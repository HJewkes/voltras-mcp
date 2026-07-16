// Unit tests for the VAD+whisper VoiceListener (VMCP-02.77).
//
// The pipeline is async (VAD prob per frame → segmenter → whisper → route), so
// we inject a fake VAD (scripted prob stream) + fake whisper and settle the
// microtask/macrotask queues after feeding audio. Audio is delivered by
// emitting 'data' on a PassThrough, exactly as node-record-lpcm16 would.

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { VoiceListener, resolveStartArgs } = await import('../voice-listener.js');

import type {
  AudioSource,
  SafetyPhraseEvent,
  Vad,
  VoiceInputEvent,
  VoiceListenerDeps,
} from '../voice-listener.js';

const FRAME_BYTES = 512 * 2;

interface Harness {
  listener: InstanceType<typeof VoiceListener>;
  audio: PassThrough;
  probs: number[];
  process: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  whisper: ReturnType<typeof vi.fn>;
  whisperTranscripts: string[];
  setWhisper: (fn: VoiceListenerDeps['whisper']) => void;
  voiceInput: VoiceInputEvent[];
  safety: SafetyPhraseEvent[];
  errors: { code: string; message: string }[];
}

function buildHarness(): Harness {
  const audio = new PassThrough();
  const probs: number[] = [];
  const process = vi.fn(async () => probs.shift() ?? 0);
  const reset = vi.fn();
  const vad: Vad = { process, reset };
  const whisperTranscripts: string[] = [];
  let whisperImpl: VoiceListenerDeps['whisper'] = async () => ({
    transcript: whisperTranscripts.shift() ?? '',
  });
  const whisper = vi.fn((audioBuf: Buffer, model: 'tiny.en' | 'base.en' | 'small.en') =>
    whisperImpl(audioBuf, model),
  );
  const voiceInput: VoiceInputEvent[] = [];
  const safety: SafetyPhraseEvent[] = [];
  const errors: { code: string; message: string }[] = [];
  const deps: VoiceListenerDeps = {
    audioFactory: (): AudioSource => ({ stream: audio, stop: vi.fn() }),
    vadFactory: () => vad,
    whisper,
    now: () => 1000,
  };
  const listener = new VoiceListener(deps, {
    onVoiceInput: (e) => voiceInput.push(e),
    onSafetyPhrase: (e) => safety.push(e),
    onError: (e) => errors.push(e),
  });
  return {
    listener,
    audio,
    probs,
    process,
    reset,
    whisper,
    whisperTranscripts,
    setWhisper: (fn) => {
      whisperImpl = fn;
    },
    voiceInput,
    safety,
    errors,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

// Feed one full utterance: `speech` voiced frames then `silence` silent frames
// (enough to exceed the 400 ms hangover so the segment closes).
function feedSegment(h: Harness, speech = 8, silence = 16): void {
  for (let i = 0; i < speech; i += 1) h.probs.push(0.9);
  for (let i = 0; i < silence; i += 1) h.probs.push(0);
  h.audio.emit('data', Buffer.alloc((speech + silence) * FRAME_BYTES));
}

describe('VoiceListener — lifecycle', () => {
  it('starts into listening and stop() is idempotent', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    expect(h.listener.getState()).toBe('listening');
    await h.listener.stop();
    await h.listener.stop();
    expect(h.listener.getState()).toBe('idle');
    expect(h.reset).toHaveBeenCalled();
  });

  it('reframes arbitrary mic chunks into 512-sample VAD frames', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    // 3072 bytes across two odd chunks = exactly 3 frames.
    h.audio.emit('data', Buffer.alloc(1536));
    h.audio.emit('data', Buffer.alloc(1536));
    await settle();
    expect(h.process).toHaveBeenCalledTimes(3);
  });
});

describe('VoiceListener — routing', () => {
  it('routes a wake-phrase utterance to onVoiceInput with the phrase stripped', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('hey coach switch to rowing');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(1);
    expect(h.voiceInput[0].transcript).toBe('switch to rowing');
    expect(h.safety).toHaveLength(0);
  });

  it('routes a safety phrase to onSafetyPhrase (not onVoiceInput)', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    expect(h.safety[0].matchedPhrase).toBe('stop');
    expect(h.voiceInput).toHaveLength(0);
  });

  it('drops ambient (non-wake, non-safety) speech', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('nice weather today');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(0);
    expect(h.safety).toHaveLength(0);
    expect(h.whisper).toHaveBeenCalledTimes(1); // it WAS transcribed, just not routed
  });
});

describe('VoiceListener — ducking', () => {
  it('does not run VAD or whisper while muted', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.listener.mute();
    h.whisperTranscripts.push('hey coach do a set');
    feedSegment(h);
    await settle();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.whisper).not.toHaveBeenCalled();
    expect(h.voiceInput).toHaveLength(0);
    h.listener.unmute();
  });

  it('resumes after unmute (refcounted)', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.listener.mute();
    h.listener.mute();
    h.listener.unmute();
    expect(h.listener.isMuted).toBe(true); // still one outstanding
    h.listener.unmute();
    expect(h.listener.isMuted).toBe(false);
    h.whisperTranscripts.push('hey coach go');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(1);
  });
});

describe('VoiceListener — transcription queue', () => {
  it('emits QUEUE_OVERFLOW when whisper backs up past the cap', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.setWhisper(() => new Promise<{ transcript: string }>(() => {})); // never resolves
    for (let s = 0; s < 7; s += 1) feedSegment(h);
    await settle();
    expect(h.errors.some((e) => e.code === 'QUEUE_OVERFLOW')).toBe(true);
  });
});
