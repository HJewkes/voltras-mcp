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
// TTS-ducking: `mute()`/`unmute()` (refcounted) suspend processing while the
// speaker is live so we never transcribe what the TTS read aloud. Entering the
// muted state discards any in-progress utterance. The mic stream stays warm.

import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';

import { log } from '../logger.js';
import type { SystemListenStartInputType } from '../schemas/voice.js';
import { SpeechSegmenter } from './speech-segmenter.js';
import { routeTranscript } from './transcript-router.js';
import { createSileroVad, VAD_FRAME_SAMPLES, type Vad } from './vad.js';

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
}

export interface VoiceListenerEvents {
  onVoiceInput?: (event: VoiceInputEvent) => void;
  onSafetyPhrase?: (event: SafetyPhraseEvent) => void;
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

/** Logical clock; tests inject a fake to keep timestamps deterministic. */
export type NowFn = () => number;

export interface VoiceListenerDeps {
  audioFactory: AudioSourceFactory;
  vadFactory: VadFactory;
  whisper: WhisperFn;
  now?: NowFn;
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
      return { transcript: transcript.trim() };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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

interface PendingUtterance {
  audio: Buffer;
  closedAt: number;
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
  private _muteDepth = 0;

  /** Raw mic bytes not yet aligned into a full 512-sample frame. */
  private frameAccum: Buffer = Buffer.alloc(0);
  /** Frames awaiting VAD; drained strictly in order (VAD is stateful). */
  private pendingFrames: Buffer[] = [];
  private drainingFrames = false;
  /** Closed utterances awaiting whisper; drained one at a time (FIFO). */
  private transcriptionQueue: PendingUtterance[] = [];
  private drainingTranscriptions = false;

  constructor(deps: VoiceListenerDeps, events: VoiceListenerEvents = {}) {
    this.deps = { now: () => Date.now(), ...deps };
    this.events = events;
  }

  getState(): ListenerStateName {
    return this.state;
  }

  getStartArgs(): StartArgs | null {
    return this.startArgs;
  }

  /** True when any TTS call is still in flight (refcount > 0). */
  get isMuted(): boolean {
    return this._muteDepth > 0;
  }

  /**
   * Suspend processing before TTS playback. Refcounted — each mute() pairs with
   * an unmute(); the mic stays ducked until all concurrent TTS calls finish.
   * Entering the muted state discards any in-progress utterance so TTS audio is
   * never transcribed.
   */
  mute(): void {
    this._muteDepth += 1;
    if (this._muteDepth === 1) this.segmenter?.flush();
    log.debug('VoiceListener: muted (TTS ducking active)');
  }

  /** Resume processing after TTS playback ends. */
  unmute(): void {
    this._muteDepth = Math.max(0, this._muteDepth - 1);
    log.debug('VoiceListener: unmuted (TTS ducking lifted)');
  }

  /** Bring the listener up. Idempotent — second call returns the same state. */
  async start(args: StartArgs): Promise<void> {
    if (this.state !== 'idle') return;
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
  }

  /** Tear everything down. Idempotent. Drops any pending/queued audio. */
  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    this.audio?.stop();
    this.segmenter?.flush();
    this.vad?.reset();
    this.audio = null;
    this.vad = null;
    this.segmenter = null;
    this.frameAccum = Buffer.alloc(0);
    this.pendingFrames = [];
    this.transcriptionQueue = [];
    this.startArgs = null;
    this.state = 'idle';
  }

  private wireAudio(): void {
    const audio = this.audio;
    if (audio === null) return;
    audio.stream.on('data', (chunk: Buffer) => {
      this.enqueueFrames(chunk);
    });
    audio.stream.on('error', (err) => {
      this.emitError({ code: 'AUDIO_STREAM_ERROR', message: err.message });
    });
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
   * callback — it only enqueues. Muted frames are discarded (TTS ducking).
   */
  private async drainFrames(): Promise<void> {
    this.drainingFrames = true;
    try {
      while (this.pendingFrames.length > 0) {
        const frame = this.pendingFrames.shift()!;
        if (this._muteDepth > 0 || this.vad === null || this.segmenter === null) continue;
        const prob = await this.runVad(frame);
        if (prob === null) continue;
        const utterance = this.segmenter.push(prob, frame);
        if (utterance !== null) this.enqueueTranscription(utterance);
      }
    } finally {
      this.drainingFrames = false;
    }
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
    this.transcriptionQueue.push({ audio, closedAt: this.deps.now!() });
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
    this.route(transcript, startArgs, { latencyMs, audioDurationMs });
  }

  private route(
    transcript: string,
    startArgs: StartArgs,
    timing: { latencyMs: number; audioDurationMs: number },
  ): void {
    const result = routeTranscript(transcript, { wakePhrases: startArgs.wakePhrases });
    if (result.tier === 'safety') {
      this.events.onSafetyPhrase?.({ matchedPhrase: result.matchedPhrase!, transcript });
      return;
    }
    if (result.tier === 'wake') {
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
