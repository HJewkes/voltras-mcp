// Unit tests for the VoiceListener state machine.
//
// We mock the audio source, the wake-word sidecar, and the whisper STT call
// so the test exercises the orchestration logic — not the real openWakeWord
// model (which requires audio) or whisper.cpp (which requires a model
// download). Real-audio testing is documented in voice-listener/README.md
// as a manual-only smoke check.

import { EventEmitter, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

import {
  resolveStartArgs,
  VoiceListener,
  type AudioSource,
  type StartArgs,
  type VoiceInputEvent,
  type WakeSidecar,
  type WakeWordEvent,
  type WhisperFn,
} from '../voice-listener.js';

interface FakeTimers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  pending: Array<{ cb: () => void; ms: number; cancelled: boolean }>;
  fireMostRecent: () => void;
}

function makeFakeTimers(): FakeTimers {
  const pending: FakeTimers['pending'] = [];
  return {
    pending,
    setTimeout: (cb, ms) => {
      const entry = { cb, ms, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (h) => {
      const entry = h as { cancelled: boolean };
      entry.cancelled = true;
    },
    fireMostRecent: () => {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const entry = pending[i];
        if (!entry.cancelled) {
          entry.cancelled = true;
          entry.cb();
          return;
        }
      }
    },
  };
}

function makeFakeAudio(): AudioSource & { stopCalled: boolean; pumpChunk: (b: Buffer) => void } {
  const stream = new PassThrough();
  let stopCalled = false;
  return {
    stream,
    stop: () => {
      stopCalled = true;
    },
    get stopCalled() {
      return stopCalled;
    },
    pumpChunk: (b: Buffer) => {
      stream.push(b);
    },
  };
}

interface FakeSidecar extends WakeSidecar {
  killCalled: boolean;
  emitJson: (obj: unknown) => void;
  emitStderr: (text: string) => void;
}

function makeFakeSidecar(): FakeSidecar {
  const stdin = new PassThrough();
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  let killCalled = false;
  return {
    stdin,
    stdout,
    stderr,
    kill: () => {
      killCalled = true;
    },
    get killCalled() {
      return killCalled;
    },
    emitJson: (obj: unknown) => {
      (stdout as unknown as EventEmitter).emit('data', JSON.stringify(obj) + '\n');
    },
    emitStderr: (text: string) => {
      (stderr as unknown as EventEmitter).emit('data', text);
    },
  };
}

function defaultArgs(): StartArgs {
  return {
    wakeWord: 'hey_jarvis',
    wakeWordModelPath: undefined,
    sttModel: 'base.en',
    maxUtteranceSec: 12,
  };
}

describe('resolveStartArgs', () => {
  it('applies MVP defaults when input is empty', () => {
    const args = resolveStartArgs({});
    expect(args.wakeWord).toBe('hey_jarvis');
    expect(args.sttModel).toBe('base.en');
    expect(args.maxUtteranceSec).toBe(12);
  });

  it('honors caller overrides', () => {
    const args = resolveStartArgs({
      wakeWord: 'alexa',
      sttModel: 'small.en',
      maxUtteranceSec: 8,
      wakeWordModelPath: 'voice-models/custom.onnx',
    });
    expect(args.wakeWord).toBe('alexa');
    expect(args.sttModel).toBe('small.en');
    expect(args.maxUtteranceSec).toBe(8);
    expect(args.wakeWordModelPath).toBe('voice-models/custom.onnx');
  });
});

describe('VoiceListener — lifecycle', () => {
  it('starts in idle state', () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
    });
    expect(listener.getState()).toBe('idle');
  });

  it('transitions to listening on start()', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
    });
    await listener.start(defaultArgs());
    expect(listener.getState()).toBe('listening');
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    let factoryCalls = 0;
    const listener = new VoiceListener({
      audioFactory: () => {
        factoryCalls += 1;
        return audio;
      },
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
    });
    await listener.start(defaultArgs());
    await listener.start(defaultArgs());
    expect(factoryCalls).toBe(1);
  });

  it('stop() tears down audio + sidecar and returns to idle', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
    });
    await listener.start(defaultArgs());
    await listener.stop();
    expect(audio.stopCalled).toBe(true);
    expect(sidecar.killCalled).toBe(true);
    expect(listener.getState()).toBe('idle');
  });

  it('stop() on an already-idle listener is a no-op', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
    });
    await listener.stop();
    expect(audio.stopCalled).toBe(false);
    expect(listener.getState()).toBe('idle');
  });
});

describe('VoiceListener — wake → STT pipeline', () => {
  it('emits onWakeWord when the sidecar publishes a wake event', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const wakeEvents: WakeWordEvent[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn().mockResolvedValue({ transcript: '' }),
        timers: makeFakeTimers(),
      },
      { onWakeWord: (e) => wakeEvents.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9, model: 'hey_jarvis' });
    expect(wakeEvents).toHaveLength(1);
    expect(wakeEvents[0].wakeWord).toBe('hey_jarvis');
    expect(wakeEvents[0].confidence).toBe(0.9);
    expect(listener.getState()).toBe('buffering');
  });

  it('drops a wake event while buffering — no overlapping transcribes', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const wakeEvents: WakeWordEvent[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn().mockResolvedValue({ transcript: '' }),
        timers: makeFakeTimers(),
      },
      { onWakeWord: (e) => wakeEvents.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    sidecar.emitJson({ event: 'wake', ts: 200, score: 0.95 });
    expect(wakeEvents).toHaveLength(1);
  });

  it('flushes the buffered audio to whisper after the hard-cap timer fires', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();
    const whisper: WhisperFn = vi.fn().mockResolvedValue({ transcript: 'switch to rowing' });
    const inputs: VoiceInputEvent[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper,
        timers,
      },
      { onVoiceInput: (e) => inputs.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    audio.pumpChunk(Buffer.from('audio-chunk-after-wake'));
    timers.fireMostRecent();
    await new Promise((r) => setImmediate(r));
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].transcript).toBe('switch to rowing');
    expect(inputs[0].sttModel).toBe('base.en');
  });

  it('returns to listening after a successful transcription', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn().mockResolvedValue({ transcript: 'go' }),
      timers,
    });
    await listener.start(defaultArgs());
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    timers.fireMostRecent();
    await new Promise((r) => setImmediate(r));
    expect(listener.getState()).toBe('listening');
  });

  it('emits onError when whisper rejects', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();
    const errors: { code: string; message: string }[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn().mockRejectedValue(new Error('whisper exploded')),
        timers,
      },
      { onError: (e) => errors.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    timers.fireMostRecent();
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('STT_FAILED');
    expect(listener.getState()).toBe('listening');
  });

  it('emits onError on bad JSONL from the sidecar', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const errors: { code: string; message: string }[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn(),
        timers: makeFakeTimers(),
      },
      { onError: (e) => errors.push(e) },
    );
    await listener.start(defaultArgs());
    (sidecar.stdout as unknown as EventEmitter).emit('data', 'not-json\n');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('SIDECAR_PROTOCOL_ERROR');
  });

  it('forwards stderr lines containing "error" as SIDECAR_ERROR', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const errors: { code: string; message: string }[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn(),
        timers: makeFakeTimers(),
      },
      { onError: (e) => errors.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitStderr('[voice-listener] ERROR openwakeword not installed');
    expect(errors[0].code).toBe('SIDECAR_ERROR');
  });

  it('ignores stderr info lines without "error"', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const errors: { code: string; message: string }[] = [];
    const listener = new VoiceListener(
      {
        audioFactory: () => audio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn(),
        timers: makeFakeTimers(),
      },
      { onError: (e) => errors.push(e) },
    );
    await listener.start(defaultArgs());
    sidecar.emitStderr('[voice-listener] INFO loading openwakeword');
    expect(errors).toHaveLength(0);
  });
});

describe('VoiceListener — audio fanout', () => {
  it('forwards audio chunks to the sidecar stdin', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const written: Buffer[] = [];
    sidecar.stdin.on('data', (chunk: Buffer) => {
      written.push(chunk);
    });
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper: vi.fn(),
      timers: makeFakeTimers(),
    });
    await listener.start(defaultArgs());
    audio.pumpChunk(Buffer.from('frame-1'));
    audio.pumpChunk(Buffer.from('frame-2'));
    expect(written.map((b) => b.toString('utf8'))).toEqual(['frame-1', 'frame-2']);
  });
});
