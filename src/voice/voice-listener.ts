// VoiceListener — wires `node-record-lpcm16` mic capture to an in-process
// Silero VAD (onnxruntime-node) + `nodejs-whisper` STT. Single instance per MCP
// server; lives on `ServerState.voice` and is allocated on first
// `system.listen_start` call. No Python, no wake-word model — "wake detection"
// is text-matching on the transcript (see transcript-router).
//
// Pipeline (VMCP-02.77): mic PCM → reframe to 512-sample frames → VAD prob per
// frame → SpeechSegmenter (VAD prob → utterances) → whisper per utterance →
// routeTranscript → { safety | wake | ignore }.
//
//   - VAD is a stateful LSTM, so frames MUST be processed strictly in order:
//     `drainFrames` awaits each `vad.process` before the next (never fire
//     concurrently). The audio callback only enqueues; it never blocks.
//   - whisper is slow + async, so closed segments go on a bounded queue drained
//     by a separate `drainTranscriptions` loop (single in-flight, FIFO, cap 5).
//
// TTS-ducking: `mute()`/`unmute()` (refcounted) duck the mic while the speaker
// is live so we never act on what the TTS read aloud. Entering the muted state
// discards any in-progress utterance. The mic stream stays warm. Each mute()
// returns a `MuteHandle` that its unmute() must pass back: two utterances can
// overlap (a non-urgent cue does not interrupt a model `system.speak`), and
// releasing the wrong one leaves the still-playing text out of the echo filter
// (VW-176).
//
// Safety exemption (VMCP-05.20): ducking is NOT a discard. Muted frames still
// run VAD + whisper and the transcript is routed SAFETY-ONLY — the command and
// wake tiers are dropped for the length of the cue. Before routing, the
// transcript is checked against the text being spoken (`isSpeechEcho`) so our
// own cue audio can never trigger anything. The old behaviour dropped muted mic
// frames outright, which swallowed a lifter's mid-cue "stop" twice on the bench
// (RESULTS-2026-08-11-VMCP-05.01-deaf-window).

import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';

import { log } from '../logger.js';
import type { SystemListenStartInputType } from '../schemas/voice.js';
import { isSpeechEcho } from './speech-echo.js';
import { SpeechSegmenter } from './speech-segmenter.js';
import { routeTranscript } from './transcript-router.js';
import type { WeightCommand } from './weight-command.js';
import { createSileroVad, VAD_FRAME_SAMPLES, type Vad } from './vad.js';
import { stripWhisperMarkup } from './whisper-markup.js';

// VMCP-02.38: the package is `"type": "module"`, so the bare CommonJS `require`
// global is undefined at runtime. Reconstruct a CJS-style `require` from the
// module URL so the lazy native loads below resolve. Kept lazy so a missing
// sox / whisper install only surfaces at start() time, not on import.
const require = createRequire(import.meta.url);

/** Default whisper model. `tiny.en` for the safety path's latency budget. */
export const DEFAULT_STT_MODEL: SttModelName = 'tiny.en';

/** Text-matched wake phrase(s) — no trained model needed (whisper transcribes). */
export const DEFAULT_WAKE_PHRASES: readonly string[] = ['hey coach'];

/** Default hard cap on a single utterance before we force it to STT. */
const DEFAULT_MAX_UTTERANCE_SEC = 12;

/** PCM format we coordinate with the recorder + VAD. */
const SAMPLE_RATE_HZ = 16_000;
const SAMPLE_BYTES = 2;
const FRAME_BYTES = VAD_FRAME_SAMPLES * SAMPLE_BYTES;

export type SttModelName = 'tiny.en' | 'base.en' | 'small.en';
export type ListenerStateName = 'idle' | 'listening';

export interface VoiceInputEvent {
  transcript: string;
  latencyMs: number;
  sttModel: SttModelName;
  audioDurationMs: number;
}

/** A hard-coded safety phrase ("stop", "cut the weight", …) was recognized. */
export interface SafetyPhraseEvent {
  matchedPhrase: string;
  transcript: string;
  /** Utterance-close → transcript-resolved, same clock as VoiceInputEvent. */
  latencyMs: number;
  audioDurationMs: number;
}

/** A local weight command ("set it to 70", "up 10", "cancel") was recognized. */
export interface WeightCommandEvent {
  command: WeightCommand;
  transcript: string;
  latencyMs: number;
  audioDurationMs: number;
}

export interface VoiceListenerEvents {
  onVoiceInput?: (event: VoiceInputEvent) => void;
  onSafetyPhrase?: (event: SafetyPhraseEvent) => void;
  /** Unwired: command-tier transcripts fall back to `onVoiceInput`. */
  onWeightCommand?: (event: WeightCommandEvent) => void;
  onError?: (err: { code: string; message: string }) => void;
}

/**
 * Audio source contract. Production wires in `node-record-lpcm16`; tests supply
 * a mock stream. A Readable yielding raw PCM frames plus a stop hook.
 */
export interface AudioSource {
  stream: Readable;
  stop: () => void;
}

export type AudioSourceFactory = () => AudioSource;

/** VAD factory contract. Production builds the Silero VAD; tests inject a fake. */
export type VadFactory = () => Vad;

/** STT invocation contract. Production wraps `nodejs-whisper`. */
export type WhisperFn = (audio: Buffer, model: SttModelName) => Promise<{ transcript: string }>;

/**
 * Optional STT warm-up, run once when the mic is armed. Arming is exactly when
 * we want to pay a cold-start cost; mid-set is not. Omitted by test deps.
 */
export type PrewarmFn = (model: SttModelName) => Promise<void>;

/**
 * How long `start()` waits for the mic to deliver its first PCM before arming
 * anyway (VMCP-05.17).
 *
 * sox + CoreAudio need ~0.5-0.7 s to open the input device; measured on the
 * bench Mac, the first byte lands 529-734 ms after `start()`. Until then the
 * stream is silent and anything spoken is lost outright — not delayed, lost —
 * so reporting `listening` before that point makes `listen_start` lie about the
 * one thing it promises.
 *
 * 2 s is ~3x the observed worst case, enough headroom for a loaded machine
 * without making a genuinely dead mic (no device, permission denied) hang the
 * caller. The wait is bounded rather than infinite precisely so that case still
 * arms — degraded and logged — instead of refusing to arm.
 */
export const MIC_READY_TIMEOUT_MS = 2000;

/** Logical clock; tests inject a fake to keep timestamps deterministic. */
export type NowFn = () => number;

export interface VoiceListenerDeps {
  audioFactory: AudioSourceFactory;
  vadFactory: VadFactory;
  whisper: WhisperFn;
  prewarm?: PrewarmFn;
  now?: NowFn;
  /** Override the mic-readiness bound; tests inject a small value. */
  micReadyTimeoutMs?: number;
}

export interface StartArgs {
  wakePhrases: string[];
  sttModel: SttModelName;
  maxSegmentMs: number;
}

/**
 * Normalize listen_start input against defaults. Lives here (not the schema
 * layer) so the schema stays a pure validator and defaults are introspectable.
 */
export function resolveStartArgs(input: SystemListenStartInputType): StartArgs {
  return {
    wakePhrases: input.wakePhrases ?? [...DEFAULT_WAKE_PHRASES],
    sttModel: input.sttModel ?? DEFAULT_STT_MODEL,
    maxSegmentMs: (input.maxUtteranceSec ?? DEFAULT_MAX_UTTERANCE_SEC) * 1000,
  };
}

/**
 * Default audio source: spawn sox via `node-record-lpcm16`. Lazy-required so a
 * missing sox install only surfaces at start() time (Linux CI imports without
 * sox installed).
 */
export function defaultAudioFactory(): AudioSource {
  const record = require('node-record-lpcm16') as {
    record: (opts: Record<string, unknown>) => { stream: () => Readable; stop: () => void };
  };
  const recorder = record.record({
    sampleRate: SAMPLE_RATE_HZ,
    channels: 1,
    audioType: 'raw',
    recorder: 'sox',
  });
  return { stream: recorder.stream(), stop: () => recorder.stop() };
}

/** Default VAD: the in-process Silero session. Model loads lazily on first frame. */
export function defaultVadFactory(): Vad {
  return createSileroVad();
}

/**
 * Default STT impl: route through `nodejs-whisper`. Lazy-required for the same
 * Linux-import reason as the audio factory. Writes a tempfile wav per call.
 */
export function defaultWhisper(): WhisperFn {
  return async (audio: Buffer, model: SttModelName) => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const whisper = require('nodejs-whisper') as {
      nodewhisper: (path: string, opts: Record<string, unknown>) => Promise<string>;
    };

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voltras-voice-'));
    const wavPath = path.join(tmpDir, 'utterance.wav');
    await fs.writeFile(wavPath, encodePcmAsWav(audio, SAMPLE_RATE_HZ));
    try {
      const transcript = await whisper.nodewhisper(wavPath, {
        modelName: model,
        autoDownloadModelName: model,
        removeWavFileAfterTranscription: false,
        whisperOptions: { outputInText: true },
      });
      // whisper-cli prints timestamp markup in front of every segment and
      // nodejs-whisper hands its stdout back verbatim. Strip it here so the
      // WhisperFn contract is "the words the speaker said" — the safety word
      // budget downstream must not be spent on markup. See whisper-markup.ts.
      return { transcript: stripWhisperMarkup(transcript) };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Silent audio just long enough to be a valid whisper input. The transcript is
 * discarded — the point is the side effects: whisper-cli paged in, the ~75 MB
 * model file in the OS page cache, the GPU backend's shader library resolved.
 */
const PREWARM_AUDIO_MS = 200;

/**
 * Default pre-warm: push a short silent buffer through the same STT path a real
 * utterance takes, so the first real utterance finds everything cached. Cheap
 * (one extra short transcription) and off the critical path — the caller fires
 * it without awaiting and a failure is never fatal.
 */
export function defaultPrewarm(whisper: WhisperFn): PrewarmFn {
  const silence = Buffer.alloc((SAMPLE_RATE_HZ * SAMPLE_BYTES * PREWARM_AUDIO_MS) / 1000);
  return async (model: SttModelName) => {
    await whisper(silence, model);
  };
}

/** Wrap raw 16 kHz mono int16 PCM in a minimal RIFF/WAVE container. */
function encodePcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * SAMPLE_BYTES, 28);
  header.writeUInt16LE(SAMPLE_BYTES, 32);
  header.writeUInt16LE(8 * SAMPLE_BYTES, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** Interpret a 1024-byte (512-sample) frame Buffer as int16 samples. */
function frameToInt16(frame: Buffer): Int16Array {
  return new Int16Array(frame.buffer, frame.byteOffset, VAD_FRAME_SAMPLES);
}

function pcmDurationMs(pcmByteLength: number): number {
  return Math.round((pcmByteLength / (SAMPLE_RATE_HZ * SAMPLE_BYTES)) * 1000);
}

/** Max queued utterances awaiting whisper before we drop the oldest. */
const TRANSCRIPTION_QUEUE_CAP = 5;

/**
 * Where an utterance was captured relative to TTS playback. Carried with the
 * audio because whisper finishes long after the cue does — by transcription
 * time the mute may already be lifted, and the safety-only gate + echo filter
 * both have to reflect the moment the words were spoken, not the moment they
 * were decoded.
 */
interface CaptureOrigin {
  /** Any frame in this utterance arrived while a cue was playing. */
  muted: boolean;
  /** Everything TTS was saying across those frames, for the echo filter. */
  spokenTexts: string[];
}

/**
 * Opaque token pairing one `mute()` with its `unmute()`. Identity is what
 * matters; `id` exists so log lines can name the entry being released.
 */
export interface MuteHandle {
  readonly id: number;
}

interface PendingUtterance {
  audio: Buffer;
  closedAt: number;
  origin: CaptureOrigin;
}

/**
 * Voice listener — owns the mic + VAD + whisper pipeline. One instance is
 * enough; `listen_start` is idempotent.
 */
export class VoiceListener {
  private readonly deps: VoiceListenerDeps;
  private readonly events: VoiceListenerEvents;
  private state: ListenerStateName = 'idle';
  private startArgs: StartArgs | null = null;
  private audio: AudioSource | null = null;
  private vad: Vad | null = null;
  private segmenter: SpeechSegmenter | null = null;
  /** One entry per outstanding mute(), holding the text that mute is speaking. */
  private activeSpeech = new Map<MuteHandle, string | undefined>();
  private nextMuteId = 1;
  /** Capture origin accumulating for the utterance the segmenter is building. */
  private origin: CaptureOrigin = { muted: false, spokenTexts: [] };

  /** Raw mic bytes not yet aligned into a full 512-sample frame. */
  private frameAccum: Buffer = Buffer.alloc(0);
  /** Frames awaiting VAD; drained strictly in order (VAD is stateful). */
  private pendingFrames: Buffer[] = [];
  private drainingFrames = false;
  /** Closed utterances awaiting whisper; drained one at a time (FIFO). */
  private transcriptionQueue: PendingUtterance[] = [];
  private drainingTranscriptions = false;
  /** Resolves the moment the mic delivers its first byte; see `awaitMicReady`. */
  private firstAudio: Promise<void> | null = null;
  private releaseFirstAudio: (() => void) | null = null;
  /**
   * True only once real PCM has arrived. `stop()` and a stream `error` also
   * release the readiness wait, so the wait resolving is NOT evidence the mic
   * works — this flag is.
   */
  private micLive = false;
  /**
   * Detaches the mic handlers wired by `wireAudio`. Stopping the recorder does
   * not guarantee its stream goes quiet, and a stopped listener must neither
   * keep accumulating frames nor keep a handler on a source it has released.
   */
  private unwireAudio: (() => void) | null = null;

  constructor(deps: VoiceListenerDeps, events: VoiceListenerEvents = {}) {
    this.deps = { now: () => Date.now(), ...deps };
    this.events = events;
  }

  getState(): ListenerStateName {
    return this.state;
  }

  /**
   * Whether the mic has actually delivered audio. False after `start()`
   * resolves means we armed past the bound and are very likely deaf — the
   * caller should surface that rather than let it live only in a log line.
   */
  isMicLive(): boolean {
    return this.micLive;
  }

  getStartArgs(): StartArgs | null {
    return this.startArgs;
  }

  /** True when any TTS call is still in flight (refcount > 0). */
  get isMuted(): boolean {
    return this.muteDepth > 0;
  }

  /** Outstanding mutes. One per unreleased handle, so it is the old refcount. */
  private get muteDepth(): number {
    return this.activeSpeech.size;
  }

  /**
   * Duck the mic before TTS playback. Refcounted — each mute() pairs with an
   * unmute(); the mic stays ducked until all concurrent TTS calls finish.
   * Entering the muted state discards any in-progress utterance, so the words
   * on either side of the cue boundary are never decoded as one sentence.
   *
   * Pass `spokenText` — what TTS is about to say. It is what lets the muted
   * window stay open to safety phrases (VMCP-05.20): a transcript made mostly
   * of these words is our own voice and is dropped. Omitting it is safe but
   * blunt — the safety path stays open with no echo filter behind it.
   *
   * Hand the returned handle back to `unmute()`. Overlapping speech is ordinary
   * (a non-urgent cue plays over a longer `system.speak`), and whichever ends
   * first must release its OWN text, not the oldest (VW-176).
   */
  mute(spokenText?: string): MuteHandle {
    const handle: MuteHandle = { id: this.nextMuteId++ };
    this.activeSpeech.set(handle, spokenText);
    if (this.muteDepth === 1) this.segmenter?.flush();
    log.debug('VoiceListener: muted (TTS ducking active, safety phrases still routed)');
    return handle;
  }

  /**
   * Release one mute. Unknown or already-released handles are a no-op, so a
   * failsafe timer racing the child's exit cannot free someone else's entry.
   */
  unmute(handle: MuteHandle): void {
    if (!this.activeSpeech.delete(handle)) return;
    log.debug(`VoiceListener: unmuted #${handle.id} (${this.muteDepth} still speaking)`);
  }

  /**
   * Bring the listener up. Idempotent — second call returns the same state.
   *
   * Resolves once the mic is actually delivering audio (bounded by
   * MIC_READY_TIMEOUT_MS), so a caller that has been told `listening` can trust
   * that a word spoken from that instant is heard. The pre-warm is still fired
   * without awaiting — it runs during the mic open, which is exactly the dead
   * time it was designed to fill.
   */
  async start(args: StartArgs): Promise<void> {
    // Re-arming still honours the readiness contract: a caller told `listening`
    // by the second call must be able to trust it just as much as the first.
    if (this.state !== 'idle') return this.awaitMicReady();
    this.startArgs = args;
    const audio = this.deps.audioFactory();
    try {
      this.vad = this.deps.vadFactory();
    } catch (err) {
      audio.stop();
      throw err;
    }
    this.audio = audio;
    this.segmenter = new SpeechSegmenter({ maxSegmentMs: args.maxSegmentMs });
    this.state = 'listening';
    this.wireAudio();
    this.firePrewarm(args.sttModel);
    await this.awaitMicReady();
  }

  /**
   * Block until the mic produces its first byte, or the bound elapses. Never
   * throws: a mic that never delivers audio still arms (degraded), because a
   * listener that refuses to arm is strictly worse than one that may be deaf.
   */
  private async awaitMicReady(): Promise<void> {
    const pending = this.firstAudio;
    if (pending === null) return;
    const timeoutMs = this.deps.micReadyTimeoutMs ?? MIC_READY_TIMEOUT_MS;
    const startedAt = this.deps.now!();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    await Promise.race([pending, bound]);
    clearTimeout(timer);
    // One-shot per arm: once the bound has been spent, a re-arm must not pay it
    // again. Identity-checked so a stop()+start() during the wait — which
    // installs a fresh promise — is not clobbered by this stale waiter.
    if (this.firstAudio === pending) this.firstAudio = null;
    // A stop() during the wait released it deliberately; there is nothing to
    // report about a listener that is no longer meant to be up.
    if (this.state !== 'listening') return;
    // The wait is also released by a stream error, so the race resolving says
    // nothing about whether the mic works — only `micLive` does.
    if (!this.micLive) {
      // A real diagnostic signal: no input device, denied mic permission, or a
      // wedged recorder. Arming deaf and silent is the defect being fixed here.
      log.warn(
        `VoiceListener: mic delivered no audio (bound ${timeoutMs} ms) — arming anyway, ` +
          'speech may be missed (check input device and microphone permission).',
      );
      return;
    }
    log.debug(`VoiceListener: mic live after ${this.deps.now!() - startedAt} ms`);
  }

  /**
   * Warm the STT path while the user is still walking up to the machine. Never
   * awaited and never fatal: listen_start must not hang or fail on it, and the
   * discarded result never reaches the router.
   */
  private firePrewarm(model: SttModelName): void {
    const prewarm = this.deps.prewarm;
    if (prewarm === undefined) return;
    void prewarm(model).then(
      () => log.debug('VoiceListener: STT pre-warm complete'),
      (err: unknown) => log.debug(`VoiceListener: STT pre-warm failed (non-fatal): ${String(err)}`),
    );
  }

  /** Tear everything down. Idempotent. Drops any pending/queued audio. */
  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    // A stop racing a still-arming start must not leave it parked on the bound,
    // and must be visible to that waiter as "no longer meant to be up" — so the
    // state transition happens before the wait is released, not at the end.
    this.state = 'idle';
    this.releaseMicWait();
    this.firstAudio = null;
    this.micLive = false;
    this.unwireAudio?.();
    this.unwireAudio = null;
    this.audio?.stop();
    this.segmenter?.flush();
    this.vad?.reset();
    this.audio = null;
    this.vad = null;
    this.segmenter = null;
    this.frameAccum = Buffer.alloc(0);
    this.pendingFrames = [];
    this.transcriptionQueue = [];
    this.origin = { muted: false, spokenTexts: [] };
    this.startArgs = null;
  }

  private wireAudio(): void {
    const audio = this.audio;
    if (audio === null) return;
    this.micLive = false;
    this.firstAudio = new Promise<void>((resolve) => {
      this.releaseFirstAudio = resolve;
    });
    const onData = (chunk: Buffer): void => {
      this.micLive = true;
      this.releaseMicWait();
      this.enqueueFrames(chunk);
    };
    const onError = (err: Error): void => {
      // Release the readiness wait too — this mic is never going to deliver.
      // Deliberately does not set `micLive`: nothing was ever heard.
      this.releaseMicWait();
      this.emitError({ code: 'AUDIO_STREAM_ERROR', message: err.message });
    };
    audio.stream.on('data', onData);
    audio.stream.on('error', onError);
    this.unwireAudio = (): void => {
      audio.stream.off('data', onData);
      audio.stream.off('error', onError);
    };
  }

  /** Release anyone blocked in `awaitMicReady`. Idempotent. */
  private releaseMicWait(): void {
    this.releaseFirstAudio?.();
    this.releaseFirstAudio = null;
  }

  /** Reframe arbitrary mic chunks into aligned 512-sample frames, then drain. */
  private enqueueFrames(chunk: Buffer): void {
    this.frameAccum = Buffer.concat([this.frameAccum, chunk]);
    while (this.frameAccum.length >= FRAME_BYTES) {
      // Copy so the frame owns aligned memory (Int16Array needs a 2-byte offset).
      this.pendingFrames.push(Buffer.from(this.frameAccum.subarray(0, FRAME_BYTES)));
      this.frameAccum = this.frameAccum.subarray(FRAME_BYTES);
    }
    if (!this.drainingFrames) void this.drainFrames();
  }

  /**
   * Process frames strictly in order (Silero VAD threads recurrent state, so
   * concurrent process() calls would corrupt it). Never blocks the audio
   * callback — it only enqueues. Muted frames are processed like any other and
   * tagged, not discarded: dropping them here is what made the mic deaf to a
   * safety phrase for the length of every cue (VMCP-05.20).
   */
  private async drainFrames(): Promise<void> {
    this.drainingFrames = true;
    try {
      while (this.pendingFrames.length > 0) {
        const frame = this.pendingFrames.shift()!;
        if (this.vad === null || this.segmenter === null) continue;
        if (this.muteDepth > 0) this.markMutedCapture();
        const prob = await this.runVad(frame);
        if (prob === null) continue;
        const utterance = this.segmenter.push(prob, frame);
        if (utterance !== null) this.enqueueTranscription(utterance);
      }
    } finally {
      this.drainingFrames = false;
    }
  }

  /** Record that the utterance being built overlaps live TTS, and what it says. */
  private markMutedCapture(): void {
    this.origin.muted = true;
    for (const text of this.activeSpeech.values()) {
      if (text === undefined) continue;
      if (!this.origin.spokenTexts.includes(text)) this.origin.spokenTexts.push(text);
    }
  }

  /** Hand the accumulated origin to the closing utterance and start a fresh one. */
  private takeOrigin(): CaptureOrigin {
    const origin = this.origin;
    this.origin = { muted: false, spokenTexts: [] };
    return origin;
  }

  private async runVad(frame: Buffer): Promise<number | null> {
    try {
      return await this.vad!.process(frameToInt16(frame));
    } catch (err) {
      this.emitError({
        code: 'VAD_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private enqueueTranscription(audio: Buffer): void {
    if (this.transcriptionQueue.length >= TRANSCRIPTION_QUEUE_CAP) {
      this.transcriptionQueue.shift();
      this.emitError({
        code: 'QUEUE_OVERFLOW',
        message: 'Transcription queue full — oldest queued utterance dropped.',
      });
    }
    this.transcriptionQueue.push({ audio, closedAt: this.deps.now!(), origin: this.takeOrigin() });
    if (!this.drainingTranscriptions) void this.drainTranscriptions();
  }

  /** Drain queued utterances one at a time through whisper, then route. */
  private async drainTranscriptions(): Promise<void> {
    this.drainingTranscriptions = true;
    try {
      while (this.transcriptionQueue.length > 0) {
        const startArgs = this.startArgs;
        if (startArgs === null) break; // stopped mid-flight
        await this.transcribeAndRoute(this.transcriptionQueue.shift()!, startArgs);
      }
    } finally {
      this.drainingTranscriptions = false;
    }
  }

  private async transcribeAndRoute(item: PendingUtterance, startArgs: StartArgs): Promise<void> {
    const audioDurationMs = pcmDurationMs(item.audio.length);
    let transcript: string;
    try {
      ({ transcript } = await this.deps.whisper(item.audio, startArgs.sttModel));
    } catch (err) {
      this.emitError({
        code: 'STT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const latencyMs = this.deps.now!() - item.closedAt;
    this.route(transcript, startArgs, { latencyMs, audioDurationMs }, item.origin);
  }

  private route(
    raw: string,
    startArgs: StartArgs,
    timing: { latencyMs: number; audioDurationMs: number },
    origin: CaptureOrigin,
  ): void {
    // Defence in depth: defaultWhisper already cleans its output, but an
    // injected WhisperFn (or a future whisper format change) must not put
    // markup in front of the router OR in the transcript we publish. Case is
    // preserved — only markup is removed.
    const transcript = stripWhisperMarkup(raw);
    // The echo check runs FIRST and outranks every tier, safety included: a
    // stop we hallucinate out of our own cue audio would unload the cable with
    // nobody having asked (VMCP-05.20).
    if (origin.muted && isSpeechEcho(transcript, origin.spokenTexts)) {
      log.debug('VoiceListener: dropped self-echo captured during TTS playback');
      return;
    }
    const result = routeTranscript(transcript, { wakePhrases: startArgs.wakePhrases });
    if (result.tier === 'safety') {
      this.events.onSafetyPhrase?.({
        matchedPhrase: result.matchedPhrase!,
        transcript,
        latencyMs: timing.latencyMs,
        audioDurationMs: timing.audioDurationMs,
      });
      return;
    }
    // Safety-only while a cue plays. Barge-in on the command and wake tiers
    // stays off: those are conveniences, and every one of them is reachable
    // again a second later, so they are not worth the self-trigger exposure.
    if (origin.muted) {
      log.debug(`VoiceListener: ${result.tier} tier suppressed during TTS playback`);
      return;
    }
    this.emitNonSafety(result, transcript, startArgs, timing);
  }

  private emitNonSafety(
    result: ReturnType<typeof routeTranscript>,
    transcript: string,
    startArgs: StartArgs,
    timing: { latencyMs: number; audioDurationMs: number },
  ): void {
    // A command with no handler must still reach the model — the fast path is
    // an accelerator, never the only way a heard command gets acted on.
    if (result.tier === 'command' && this.events.onWeightCommand !== undefined) {
      this.events.onWeightCommand({
        command: result.command!,
        transcript,
        latencyMs: timing.latencyMs,
        audioDurationMs: timing.audioDurationMs,
      });
      return;
    }
    if (result.tier === 'wake' || result.tier === 'command') {
      this.events.onVoiceInput?.({
        transcript: result.commandText || transcript,
        latencyMs: timing.latencyMs,
        sttModel: startArgs.sttModel,
        audioDurationMs: timing.audioDurationMs,
      });
    }
    // 'ignore' → drop.
  }

  private emitError(err: { code: string; message: string }): void {
    this.events.onError?.(err);
  }
}
