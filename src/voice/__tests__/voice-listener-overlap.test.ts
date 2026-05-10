// Tests for the FIFO transcription-overlap queue introduced in feat/voice-overlap-queue.
//
// When a wake event arrives while whisper is in flight (state = transcribing),
// the audio buffer captured at that moment is enqueued and processed after the
// current transcription completes — in arrival order, without loss (up to cap).

import { EventEmitter, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

import {
  VoiceListener,
  type AudioSource,
  type StartArgs,
  type VoiceInputEvent,
  type WakeSidecar,
  type WhisperFn,
} from '../voice-listener.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrored from the existing test file)
// ---------------------------------------------------------------------------

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

function makeFakeAudio(): AudioSource & { pumpChunk: (b: Buffer) => void } {
  const stream = new PassThrough();
  return {
    stream,
    stop: () => {},
    pumpChunk: (b: Buffer) => {
      stream.push(b);
    },
  };
}

interface FakeSidecar extends WakeSidecar {
  emitJson: (obj: unknown) => void;
}

function makeFakeSidecar(): FakeSidecar {
  const stdin = new PassThrough();
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  return {
    stdin,
    stdout,
    stderr,
    kill: () => {},
    emitJson: (obj: unknown) => {
      (stdout as unknown as EventEmitter).emit('data', JSON.stringify(obj) + '\n');
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

/** Resolve all microtasks and the event loop tick. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceListener — transcription overlap queue', () => {
  it('enqueues a wake event that arrives during transcription and processes it after current transcription completes', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();

    // Whisper resolves in two controlled steps via manual resolvers.
    let resolveFirst!: (v: { transcript: string }) => void;
    let resolveSecond!: (v: { transcript: string }) => void;
    const firstDone = new Promise<{ transcript: string }>((r) => {
      resolveFirst = r;
    });
    const secondDone = new Promise<{ transcript: string }>((r) => {
      resolveSecond = r;
    });

    const whisper: WhisperFn = vi
      .fn()
      .mockReturnValueOnce(firstDone)
      .mockReturnValueOnce(secondDone);

    const inputs: VoiceInputEvent[] = [];
    const listener = new VoiceListener(
      { audioFactory: () => audio, sidecarFactory: () => sidecar, whisper, timers },
      { onVoiceInput: (e) => inputs.push(e) },
    );
    await listener.start(defaultArgs());

    // Wake #1 → buffering
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    expect(listener.getState()).toBe('buffering');

    // Fire hard cap → transitions to transcribing, first whisper in flight
    timers.fireMostRecent();
    await flush();
    expect(listener.getState()).toBe('transcribing');
    expect(whisper).toHaveBeenCalledTimes(1);

    // Wake #2 arrives during transcription → should be enqueued, not dropped
    sidecar.emitJson({ event: 'wake', ts: 200, score: 0.85 });
    // State should remain `transcribing` — no new whisper call yet
    expect(listener.getState()).toBe('transcribing');
    expect(whisper).toHaveBeenCalledTimes(1);

    // Resolve first transcription
    resolveFirst({ transcript: 'set the damper' });
    await flush();
    // The queued buffer should now be transcribing
    expect(whisper).toHaveBeenCalledTimes(2);
    expect(listener.getState()).toBe('transcribing');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].transcript).toBe('set the damper');

    // Resolve second transcription
    resolveSecond({ transcript: 'increase assist' });
    await flush();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].transcript).toBe('increase assist');
    expect(listener.getState()).toBe('listening');
  });

  it('processes two queued wake events in arrival order after one transcribing cycle', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();

    type Resolver = (v: { transcript: string }) => void;
    const resolvers: Resolver[] = [];
    const whisper: WhisperFn = vi.fn().mockImplementation(
      () =>
        new Promise<{ transcript: string }>((r) => {
          resolvers.push(r);
        }),
    );

    const inputs: VoiceInputEvent[] = [];
    const listener = new VoiceListener(
      { audioFactory: () => audio, sidecarFactory: () => sidecar, whisper, timers },
      { onVoiceInput: (e) => inputs.push(e) },
    );
    await listener.start(defaultArgs());

    // Wake #1 → buffering → transcribing
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    timers.fireMostRecent();
    await flush();
    expect(listener.getState()).toBe('transcribing');

    // Wakes #2 and #3 arrive during transcription
    sidecar.emitJson({ event: 'wake', ts: 200, score: 0.85 });
    sidecar.emitJson({ event: 'wake', ts: 300, score: 0.8 });
    expect(whisper).toHaveBeenCalledTimes(1); // no new whisper yet

    // Resolve whisper #1
    resolvers[0]({ transcript: 'first' });
    await flush();
    expect(whisper).toHaveBeenCalledTimes(2);

    // Resolve whisper #2
    resolvers[1]({ transcript: 'second' });
    await flush();
    expect(whisper).toHaveBeenCalledTimes(3);

    // Resolve whisper #3
    resolvers[2]({ transcript: 'third' });
    await flush();

    expect(inputs.map((e) => e.transcript)).toEqual(['first', 'second', 'third']);
    expect(listener.getState()).toBe('listening');
  });

  it('caps the queue at 5, drops the oldest entry, and logs a QUEUE_OVERFLOW error', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();

    // Whisper stays pending for the entire test so transcription never resolves.
    let resolveFirst!: (v: { transcript: string }) => void;
    const whisper: WhisperFn = vi.fn().mockReturnValueOnce(
      new Promise<{ transcript: string }>((r) => {
        resolveFirst = r;
      }),
    );

    const errors: { code: string; message: string }[] = [];
    const listener = new VoiceListener(
      { audioFactory: () => audio, sidecarFactory: () => sidecar, whisper, timers },
      { onError: (e) => errors.push(e) },
    );
    await listener.start(defaultArgs());

    // Wake #1 → transcribing (in flight, never resolves during this phase)
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    timers.fireMostRecent();
    await flush();
    expect(listener.getState()).toBe('transcribing');

    // Pump 6 more wake events while in transcribing state.
    // Queue cap is 5, so the 6th push should drop entry #1 from the queue.
    for (let i = 0; i < 6; i += 1) {
      sidecar.emitJson({ event: 'wake', ts: 200 + i * 10, score: 0.8 });
    }

    // Exactly one overflow error should have been emitted (on the 6th enqueue).
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('QUEUE_OVERFLOW');

    // Only 5 entries remain in the queue (we can verify by draining them).
    // Resolve the in-flight whisper and count how many times whisper is called.
    whisper.mockImplementation(() => Promise.resolve({ transcript: 'queued' }));
    resolveFirst({ transcript: 'first' });
    // Drain all queued entries
    for (let i = 0; i < 10; i += 1) {
      await flush();
    }
    // whisper was called once for the original + 5 from the capped queue = 6 total.
    expect(whisper).toHaveBeenCalledTimes(6);
    expect(listener.getState()).toBe('listening');
  });

  it('drains the queue without firing whisper when stop() is called during transcription', async () => {
    const audio = makeFakeAudio();
    const sidecar = makeFakeSidecar();
    const timers = makeFakeTimers();

    let resolveFirst!: (v: { transcript: string }) => void;
    const whisper: WhisperFn = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<{ transcript: string }>((r) => {
          resolveFirst = r;
        }),
      )
      // If stop() doesn't drain the queue, subsequent calls would hit this.
      .mockRejectedValue(new Error('whisper should not be called after stop'));

    const listener = new VoiceListener(
      { audioFactory: () => audio, sidecarFactory: () => sidecar, whisper, timers },
      {},
    );
    await listener.start(defaultArgs());

    // Wake #1 → transcribing
    sidecar.emitJson({ event: 'wake', ts: 100, score: 0.9 });
    timers.fireMostRecent();
    await flush();
    expect(listener.getState()).toBe('transcribing');

    // Enqueue two more wake events while in flight
    sidecar.emitJson({ event: 'wake', ts: 200, score: 0.8 });
    sidecar.emitJson({ event: 'wake', ts: 300, score: 0.8 });

    // Stop the listener — should drain the queue without processing entries
    await listener.stop();
    expect(listener.getState()).toBe('idle');
    expect(whisper).toHaveBeenCalledTimes(1); // Only the in-flight call

    // Let the in-flight whisper resolve — state should NOT go back to listening
    resolveFirst({ transcript: 'done' });
    await flush();
    expect(listener.getState()).toBe('idle'); // stays idle, not re-entered
    // No additional whisper calls from drained queue entries
    expect(whisper).toHaveBeenCalledTimes(1);
  });
});
