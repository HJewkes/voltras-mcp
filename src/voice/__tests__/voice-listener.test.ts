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
  WeightCommandEvent,
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
  commands: WeightCommandEvent[];
  errors: { code: string; message: string }[];
}

function buildHarness(
  overrides: Partial<VoiceListenerDeps> = {},
  opts: { weightHandler?: boolean } = {},
): Harness {
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
  const commands: WeightCommandEvent[] = [];
  const errors: { code: string; message: string }[] = [];
  const deps: VoiceListenerDeps = {
    audioFactory: (): AudioSource => ({ stream: audio, stop: vi.fn() }),
    vadFactory: () => vad,
    whisper,
    now: () => 1000,
    // The PassThrough delivers nothing until a test emits, so start() would sit
    // on the real mic-readiness bound. Tests that exercise the bound override.
    micReadyTimeoutMs: 0,
    ...overrides,
  };
  const listener = new VoiceListener(deps, {
    onVoiceInput: (e) => voiceInput.push(e),
    onSafetyPhrase: (e) => safety.push(e),
    // Omitted on purpose in the unwired case: a command with no fast-path must
    // still reach the model.
    ...(opts.weightHandler === false ? {} : { onWeightCommand: (e) => commands.push(e) }),
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
    commands,
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

// Byte fills that survive into the emitted utterance, so a test can tell which
// segment a whisper call was given. Silence is left zeroed: it becomes the next
// segment's pre-roll and would otherwise smear the mark across utterances.
const LIFTER_MARK = 0xcd;
const CUE_MARK = 0xab;

function feedMarkedSegment(h: Harness, mark: number, speech = 8, silence = 16): void {
  for (let i = 0; i < speech; i += 1) h.probs.push(0.9);
  for (let i = 0; i < silence; i += 1) h.probs.push(0);
  h.audio.emit('data', Buffer.alloc(speech * FRAME_BYTES, mark));
  h.audio.emit('data', Buffer.alloc(silence * FRAME_BYTES));
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

  it('routes a weight command to onWeightCommand (not onVoiceInput)', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('to like, , set it to 70');
    feedSegment(h);
    await settle();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].command).toEqual({ kind: 'absolute', lbs: 70 });
    expect(h.commands[0].transcript).toBe('to like, , set it to 70');
    expect(h.voiceInput).toHaveLength(0);
    expect(h.safety).toHaveLength(0);
  });

  it('keeps a safety phrase out of the command path', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('stop drop 5');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    expect(h.commands).toHaveLength(0);
  });

  it('falls back to onVoiceInput when no weight handler is wired', async () => {
    const h = buildHarness({}, { weightHandler: false });
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('set it to 70');
    feedSegment(h);
    await settle();
    expect(h.commands).toHaveLength(0);
    expect(h.voiceInput).toHaveLength(1);
    expect(h.voiceInput[0].transcript).toBe('set it to 70');
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

// The bench saw `latency_ms: 0` / `audio_duration_ms: 0` on every event. The
// listener measured both correctly; the safety branch dropped them on the floor
// (VMCP-02.83). The planned deaf-window measurement depends on these numbers.
describe('VoiceListener — timing instrumentation', () => {
  // Clock that advances 50 ms per read, so a dropped measurement reads 0 and a
  // real one does not.
  function advancingClock(): () => number {
    let t = 1000;
    return () => (t += 50);
  }

  it('carries measured latency and audio duration on a safety event', async () => {
    const h = buildHarness({ now: advancingClock() });
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    expect(h.safety[0].latencyMs).toBeGreaterThan(0);
    expect(h.safety[0].audioDurationMs).toBeGreaterThan(0);
  });

  it('carries measured latency and audio duration on a wake event', async () => {
    const h = buildHarness({ now: advancingClock() });
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('hey coach what is next');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(1);
    expect(h.voiceInput[0].latencyMs).toBeGreaterThan(0);
    expect(h.voiceInput[0].audioDurationMs).toBeGreaterThan(0);
  });

  it('reports audio duration from the captured PCM length', async () => {
    const h = buildHarness({ now: advancingClock() });
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('stop');
    feedSegment(h, 8, 16);
    await settle();
    // 24 frames × 512 samples at 16 kHz = 768 ms of audio; the segmenter keeps
    // the voiced frames plus hangover, so the reported duration sits inside it.
    expect(h.safety[0].audioDurationMs).toBeLessThanOrEqual(768);
    expect(h.safety[0].audioDurationMs).toBeGreaterThanOrEqual(256);
  });
});

describe('VoiceListener — STT pre-warm', () => {
  it('fires the pre-warm once at start with the configured model', async () => {
    const prewarm = vi.fn(async () => {});
    const h = buildHarness({ prewarm });
    await h.listener.start(resolveStartArgs({ sttModel: 'base.en' }));
    await settle();
    expect(prewarm).toHaveBeenCalledTimes(1);
    expect(prewarm).toHaveBeenCalledWith('base.en');
  });

  it('does not route the pre-warm result as an utterance', async () => {
    const prewarm = vi.fn(async () => {});
    const h = buildHarness({ prewarm });
    await h.listener.start(resolveStartArgs({}));
    await settle();
    expect(h.voiceInput).toHaveLength(0);
    expect(h.safety).toHaveLength(0);
  });

  // Arming the mic must never depend on the warm-up: degraded latency is
  // acceptable, a listener that will not arm is not.
  it('does not wait for a slow pre-warm before arming', async () => {
    const h = buildHarness({ prewarm: () => new Promise<void>(() => {}) }); // never settles
    await h.listener.start(resolveStartArgs({}));
    expect(h.listener.getState()).toBe('listening');
  });

  it('transcribes normally while a slow pre-warm is still in flight', async () => {
    const h = buildHarness({ prewarm: () => new Promise<void>(() => {}) });
    await h.listener.start(resolveStartArgs({}));
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
  });

  it('starts normally when the pre-warm fails', async () => {
    const prewarm = vi.fn(async () => {
      throw new Error('whisper not installed');
    });
    const h = buildHarness({ prewarm });
    await expect(h.listener.start(resolveStartArgs({}))).resolves.toBeUndefined();
    await settle();
    expect(h.listener.getState()).toBe('listening');
    expect(h.errors).toHaveLength(0);
  });
});

// VMCP-05.17: sox/CoreAudio need ~0.5-0.7 s to open the input device. Arming
// before then reported `listening` while physically deaf, so a safety word
// spoken immediately was never captured at all — lost, not merely delayed.
describe('VoiceListener — mic readiness', () => {
  it('does not resolve start() until the mic delivers audio', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 10_000 });
    let armed = false;
    const starting = h.listener.start(resolveStartArgs({})).then(() => {
      armed = true;
    });
    await settle();
    expect(armed).toBe(false); // still deaf — must not claim to be listening

    h.audio.emit('data', Buffer.alloc(FRAME_BYTES));
    await starting;
    expect(armed).toBe(true);
    expect(h.listener.getState()).toBe('listening');
  });

  // Degraded is acceptable; refusing to arm is not.
  it('arms anyway when the mic never delivers audio within the bound', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 20 });
    await expect(h.listener.start(resolveStartArgs({}))).resolves.toBeUndefined();
    expect(h.listener.getState()).toBe('listening');
    expect(h.errors).toHaveLength(0);
  });

  it('arms when the mic stream errors instead of delivering audio', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 10_000 });
    const starting = h.listener.start(resolveStartArgs({}));
    await settle();
    h.audio.emit('error', new Error('no input device'));
    await expect(starting).resolves.toBeUndefined();
    expect(h.listener.getState()).toBe('listening');
    expect(h.errors.map((e) => e.code)).toContain('AUDIO_STREAM_ERROR');
  });

  it('transcribes the very first utterance once armed', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 10_000 });
    const starting = h.listener.start(resolveStartArgs({}));
    await settle();
    h.audio.emit('data', Buffer.alloc(FRAME_BYTES));
    await starting;

    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    expect(h.safety[0].matchedPhrase).toBe('stop');
  });

  it('does not leave a stop() racing a still-arming start() parked on the bound', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 10_000 });
    const starting = h.listener.start(resolveStartArgs({}));
    await settle();
    await h.listener.stop();
    await expect(starting).resolves.toBeUndefined();
    expect(h.listener.getState()).toBe('idle');
  });

  // The pre-warm is fired before the wait so it runs *during* the mic open —
  // that dead time is exactly what it exists to fill. It must not gate arming.
  it('still arms within the bound when the pre-warm never settles', async () => {
    const h = buildHarness({
      micReadyTimeoutMs: 10_000,
      prewarm: () => new Promise<void>(() => {}),
    });
    const starting = h.listener.start(resolveStartArgs({}));
    await settle();
    h.audio.emit('data', Buffer.alloc(FRAME_BYTES));
    await expect(starting).resolves.toBeUndefined();
    expect(h.listener.getState()).toBe('listening');
  });

  // `listening` is the only thing the caller sees; the readiness wait is also
  // released by stop() and by a stream error, so "the wait finished" must not
  // be mistaken for "the mic works". isMicLive() is what callers surface.
  it('reports the mic live only when audio actually arrived', async () => {
    const live = buildHarness({ micReadyTimeoutMs: 10_000 });
    const starting = live.listener.start(resolveStartArgs({}));
    await settle();
    live.audio.emit('data', Buffer.alloc(FRAME_BYTES));
    await starting;
    expect(live.listener.isMicLive()).toBe(true);

    const dead = buildHarness({ micReadyTimeoutMs: 20 });
    await dead.listener.start(resolveStartArgs({}));
    expect(dead.listener.getState()).toBe('listening');
    expect(dead.listener.isMicLive()).toBe(false);

    const errored = buildHarness({ micReadyTimeoutMs: 10_000 });
    const arming = errored.listener.start(resolveStartArgs({}));
    await settle();
    errored.audio.emit('error', new Error('no input device'));
    await arming;
    expect(errored.listener.isMicLive()).toBe(false);
  });

  // start() is documented idempotent. A re-arm landing mid-arm must inherit the
  // same guarantee, not return `listening` while the mic is still opening.
  it('makes a re-arm during arming wait for the mic too', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 10_000 });
    let rearmed = false;
    const first = h.listener.start(resolveStartArgs({}));
    await settle();
    const second = h.listener.start(resolveStartArgs({})).then(() => {
      rearmed = true;
    });
    await settle();
    expect(rearmed).toBe(false); // still deaf — must not claim to be listening

    h.audio.emit('data', Buffer.alloc(FRAME_BYTES));
    await Promise.all([first, second]);
    expect(rearmed).toBe(true);
    expect(h.listener.isMicLive()).toBe(true);
  });

  // The bound is spent once per arm. Re-arming a listener that already armed
  // deaf must return immediately rather than stall for another whole bound.
  it('does not pay the bound again when re-arming an already-deaf listener', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 500 });
    await h.listener.start(resolveStartArgs({}));
    expect(h.listener.isMicLive()).toBe(false);

    const startedAt = Date.now();
    await h.listener.start(resolveStartArgs({}));
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  // Repeated arm/stop cycles must not accumulate 'data'/'error' handlers.
  it('does not accumulate stream listeners across arm/stop cycles', async () => {
    const h = buildHarness({ micReadyTimeoutMs: 20 });
    for (let i = 0; i < 12; i += 1) {
      await h.listener.start(resolveStartArgs({}));
      await h.listener.stop();
    }
    expect(h.audio.listenerCount('data')).toBeLessThanOrEqual(1);
    expect(h.audio.listenerCount('error')).toBeLessThanOrEqual(1);
  });
});

// VMCP-05.20. Muting used to discard mic frames outright, so a cue made the
// listener deaf for its whole duration — the bench watched a lifter say "stop"
// mid-cue twice and the cable stayed loaded both times
// (RESULTS-2026-08-11-VMCP-05.01-deaf-window). Ducking is now safety-only, not
// a discard.
describe('VoiceListener — ducking (safety exemption)', () => {
  const CUE = 'That rep was 15 percent slower. Reset.';

  it('runs VAD and whisper on frames captured while muted', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.process).toHaveBeenCalled();
    expect(h.whisper).toHaveBeenCalledTimes(1);
    h.listener.unmute(handle);
  });

  it('fires a safety phrase spoken during a cue', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    expect(h.safety[0].matchedPhrase).toBe('stop');
    h.listener.unmute(handle);
  });

  it('still fires a safety phrase when the cue text was not threaded through', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute();
    h.whisperTranscripts.push('cut the weight');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
    h.listener.unmute(handle);
  });

  it('ignores the wake phrase during a cue', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.whisperTranscripts.push('hey coach do a set');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(0);
    expect(h.safety).toHaveLength(0);
    h.listener.unmute(handle);
  });

  it('ignores a weight command during a cue', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.whisperTranscripts.push('set it to 70');
    feedSegment(h);
    await settle();
    expect(h.commands).toHaveLength(0);
    expect(h.voiceInput).toHaveLength(0);
    h.listener.unmute(handle);
  });

  it('drops the cue text fed back as a muted-window transcript', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.whisperTranscripts.push(CUE);
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(0);
    expect(h.voiceInput).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
    h.listener.unmute(handle);
  });

  // The echo filter, not the safety tier, is what has to win here — otherwise
  // the machine unloads the cable on its own voice. Documented residual risk:
  // a lifter's real "stop" over this cue is dropped along with the echo.
  it('drops a cue whose own text contains a safety word', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute("Don't stop now.");
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(0);
    expect(h.voiceInput).toHaveLength(0);
    h.listener.unmute(handle);
  });

  it('applies the echo filter only inside the muted window', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const handle = h.listener.mute(CUE);
    h.listener.unmute(handle);
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(1);
  });

  it('resumes after unmute (refcounted)', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const first = h.listener.mute();
    const second = h.listener.mute();
    h.listener.unmute(first);
    expect(h.listener.isMuted).toBe(true); // still one outstanding
    h.listener.unmute(second);
    expect(h.listener.isMuted).toBe(false);
    h.whisperTranscripts.push('hey coach go');
    feedSegment(h);
    await settle();
    expect(h.voiceInput).toHaveLength(1);
  });
});

// VW-176. A non-urgent cue does not interrupt a model `system.speak`, so two
// mutes overlap routinely. Releasing them FIFO dropped the text of whichever
// utterance was still playing, leaving the echo filter with the wrong words and
// the safety tier free to fire on the machine's own voice.
describe('VoiceListener — overlapping speech (handle pairing)', () => {
  const LONG = 'Keep the elbow tucked and do not stop short at the top of the rep';
  const SHORT = 'Two reps left.';

  it('keeps the longer text active when the shorter overlapping cue ends first', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const long = h.listener.mute(LONG);
    const short = h.listener.mute(SHORT);
    h.listener.unmute(short);

    h.whisperTranscripts.push('stop short at the top');
    feedSegment(h);
    await settle();

    expect(h.safety).toHaveLength(0);
    expect(h.voiceInput).toHaveLength(0);
    expect(h.listener.isMuted).toBe(true);
    h.listener.unmute(long);
  });

  it('still drops an echo of the second text after the first is released', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const long = h.listener.mute(LONG);
    const short = h.listener.mute(SHORT);
    h.listener.unmute(long);

    h.whisperTranscripts.push('two reps left');
    feedSegment(h);
    await settle();

    expect(h.voiceInput).toHaveLength(0);
    expect(h.safety).toHaveLength(0);
    h.listener.unmute(short);
  });

  it('treats a repeated unmute of the same handle as a no-op', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));
    const long = h.listener.mute(LONG);
    const short = h.listener.mute(SHORT);
    h.listener.unmute(short);
    h.listener.unmute(short);
    expect(h.listener.isMuted).toBe(true); // depth never went negative

    // The surviving entry is still LONG's, so its echo is still filtered.
    h.whisperTranscripts.push('stop short at the top');
    feedSegment(h);
    await settle();
    expect(h.safety).toHaveLength(0);

    h.listener.unmute(long);
    expect(h.listener.isMuted).toBe(false);
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

  // Muted frames are transcribed now, so cue audio takes queue slots that used
  // to belong to the lifter alone. At the cap the echo is the one to sacrifice.
  it('drops a queued muted utterance before an older unmuted one', async () => {
    const h = buildHarness();
    await h.listener.start(resolveStartArgs({}));

    const seen: Buffer[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setWhisper(async (audio) => {
      seen.push(audio);
      if (seen.length === 1) await gate; // first call blocks the drain
      return { transcript: '' };
    });

    feedSegment(h); // in flight, holding the drain open
    await settle();

    // Settle between feeds: frames are VAD-processed asynchronously, so the mute
    // window has to still be open when the cue segment's frames are drained.
    feedMarkedSegment(h, LIFTER_MARK); // queued first, unmuted
    await settle();
    const handle = h.listener.mute('two reps left');
    feedMarkedSegment(h, CUE_MARK);
    await settle();
    h.listener.unmute(handle);
    for (let s = 0; s < 4; s += 1) feedSegment(h); // pushes the queue past the cap
    await settle();

    release();
    await settle();

    expect(h.errors.some((e) => e.code === 'QUEUE_OVERFLOW')).toBe(true);
    expect(seen.some((audio) => audio.includes(CUE_MARK))).toBe(false);
    expect(seen.some((audio) => audio.includes(LIFTER_MARK))).toBe(true);
  });
});
