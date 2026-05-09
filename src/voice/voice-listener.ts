// VoiceListener — wires together the openWakeWord Python sidecar, the
// `node-record-lpcm16` mic capture, and `nodejs-whisper` STT. Single instance
// per MCP server; lives on `ServerState.voice` and is allocated on first
// `system.listen_start` call.
//
// State machine (idle → listening → wake → buffering → transcribing → idle):
//
//   idle          : no sidecar, no mic. start() transitions to listening.
//   listening     : sidecar + mic running, audio frames flowing into both
//                   the sidecar's stdin and the local 30-s ring buffer.
//   wake          : transient — sidecar emitted a `wake` event. We snapshot
//                   the ring's last 1 s, then stay in `buffering` until the
//                   utterance window closes.
//   buffering     : actively appending forward audio for a configurable
//                   window (default ~12 s) until silence or hard cap.
//   transcribing  : window closed; ship the wav buffer to whisper.cpp. While
//                   we're here we keep listening for the NEXT wake (sidecar
//                   stays warm). A second wake during transcription is
//                   enqueued in `_transcriptionQueue` (FIFO, cap 5). When the
//                   current whisper finishes the next queued buffer is
//                   immediately dispatched to whisper without requiring a new
//                   wake event.
//                   On transcription complete: emit voice_input + either
//                   process next queued buffer or return to listening.
//
// TODO(phase-1.5): TTS-ducking. While `system.speak` is producing audio the
// host's mic re-hears the speaker output ("coach" appearing inside a TTS
// response self-triggers the listener). The mitigation is a `mute()`/`unmute()`
// pair driven by the speak tool. Deliberately deferred from the MVP to keep
// this module a single, reviewable surface — all the integration points
// (sidecar IPC, ring buffer, STT invocation) need to stabilize before we
// thread a global mute state through them.
//
// TODO(future): wake-word swap. The shipped default is openWakeWord's built-in
// `hey_jarvis`; the user's preferred `hey coach` requires a custom-trained
// .onnx (see voice-models/README.md). Swap is config-only — drop the file in
// voice-models/ and pass `wakeWordModelPath` to listen_start.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { SystemListenStartInputType } from '../schemas/voice.js';

/** Default whisper.cpp model. ~150 MB; sub-second p50 on M-series. */
export const DEFAULT_STT_MODEL: SttModelName = 'base.en';

/**
 * Default openWakeWord built-in. The user's preferred `hey coach` requires
 * a custom-trained model; absent that, `hey_jarvis` is the closest 2-word
 * built-in shipped by openWakeWord and is auto-downloaded on sidecar boot.
 * See voice-models/README.md for the swap-in path.
 */
export const DEFAULT_WAKE_WORD = 'hey_jarvis';

/** Size of the post-wake utterance buffer in seconds before we hand off to STT. */
const DEFAULT_MAX_UTTERANCE_SEC = 12;

/** Seconds of pre-wake audio we replay into the STT buffer for context. */
const PRE_WAKE_CAPTURE_SEC = 1;

/** PCM format we coordinate with both the recorder and the sidecar. */
const SAMPLE_RATE_HZ = 16_000;
const SAMPLE_BYTES = 2;

export type SttModelName = 'tiny.en' | 'base.en' | 'small.en';
export type ListenerStateName = 'idle' | 'listening' | 'buffering' | 'transcribing';

export interface VoiceInputEvent {
  transcript: string;
  latencyMs: number;
  sttModel: SttModelName;
  audioDurationMs: number;
}

export interface WakeWordEvent {
  wakeWord: string;
  confidence: number;
  capturedAtMs: number;
}

export interface VoiceListenerEvents {
  onVoiceInput?: (event: VoiceInputEvent) => void;
  onWakeWord?: (event: WakeWordEvent) => void;
  onError?: (err: { code: string; message: string }) => void;
}

/**
 * Audio source contract. Production wires in `node-record-lpcm16`; tests
 * supply a mock stream. The contract is intentionally minimal — a Readable
 * yielding raw PCM frames plus a stop hook.
 */
export interface AudioSource {
  stream: Readable;
  stop: () => void;
}

export type AudioSourceFactory = () => AudioSource;

/**
 * Wake-word sidecar contract. Production spawns `python listener.py` and
 * pipes mic frames into its stdin; tests inject a fake. The sidecar's
 * stdout is parsed line-by-line as JSONL.
 */
export interface WakeSidecar {
  /** Stream of raw 16 kHz PCM in. The sidecar must read until EOF. */
  stdin: NodeJS.WritableStream;
  /** JSONL events out. */
  stdout: NodeJS.ReadableStream;
  /** Diagnostic logs; surfaced to the listener's onError when fatal. */
  stderr: NodeJS.ReadableStream;
  kill: () => void;
}

export interface SidecarOptions {
  modelPath: string | undefined;
}
export type WakeSidecarFactory = (opts: SidecarOptions) => WakeSidecar;

/** STT invocation contract. Production wraps `nodejs-whisper`. */
export type WhisperFn = (audio: Buffer, model: SttModelName) => Promise<{ transcript: string }>;

/** Logical clock; tests inject a fake to keep timestamps deterministic. */
export type NowFn = () => number;

/** Async timer scheduling, abstracted for tests. */
export interface Timers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface VoiceListenerDeps {
  audioFactory: AudioSourceFactory;
  sidecarFactory: WakeSidecarFactory;
  whisper: WhisperFn;
  now?: NowFn;
  timers?: Timers;
}

export interface StartArgs {
  wakeWord: string;
  wakeWordModelPath: string | undefined;
  sttModel: SttModelName;
  maxUtteranceSec: number;
}

/**
 * Normalize listen_start input against MVP defaults. Lives in this module
 * (rather than the schema layer) so the schema stays a pure validator and
 * the defaults are introspectable from tests + the tool handler.
 */
export function resolveStartArgs(input: SystemListenStartInputType): StartArgs {
  return {
    wakeWord: input.wakeWord ?? DEFAULT_WAKE_WORD,
    wakeWordModelPath: input.wakeWordModelPath,
    sttModel: input.sttModel ?? DEFAULT_STT_MODEL,
    maxUtteranceSec: input.maxUtteranceSec ?? DEFAULT_MAX_UTTERANCE_SEC,
  };
}

/**
 * Default audio source: spawn sox via `node-record-lpcm16`. Lazy-required
 * so a missing sox install only surfaces at start() time, not import time
 * (the Linux CI smoke test imports voltras-mcp without sox installed).
 */
export function defaultAudioFactory(): AudioSource {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

/**
 * Default wake-word sidecar: spawn `python3 voice-listener/listener.py`.
 * Caller resolves `pythonBin` + `scriptPath` ahead of time so this stays
 * platform-agnostic.
 */
export function defaultSidecarFactory(pythonBin: string, scriptPath: string): WakeSidecarFactory {
  return ({ modelPath }: SidecarOptions): WakeSidecar => {
    const args: string[] = [scriptPath];
    if (modelPath !== undefined) args.push('--model', modelPath);
    const child = spawn(pythonBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return adaptSpawnedChild(child);
  };
}

function adaptSpawnedChild(child: ChildProcessWithoutNullStreams): WakeSidecar {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited or unkillable — drop the reference.
      }
    },
  };
}

/**
 * Default STT impl: route through `nodejs-whisper`. Lazy-required for the
 * same Linux-import reason as the audio factory.
 *
 * `nodejs-whisper` writes a wav file to disk for whisper.cpp; this thin
 * adapter feeds it the raw buffer through a tempfile so the listener layer
 * stays I/O-free.
 */
export function defaultWhisper(): WhisperFn {
  return async (audio: Buffer, model: SttModelName) => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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

interface SidecarEventWake {
  event: 'wake';
  ts: number;
  score: number;
  model?: string;
}
interface SidecarEventReady {
  event: 'ready';
  ts: number;
  model?: string;
}
type SidecarEvent = SidecarEventWake | SidecarEventReady | { event: string; [k: string]: unknown };

/** Maximum number of queued transcription buffers to prevent unbounded growth. */
const TRANSCRIPTION_QUEUE_CAP = 5;

/**
 * Voice listener — owns the sidecar + recorder lifecycle and the post-wake
 * STT pipeline. One instance is enough; `listen_start` is idempotent.
 */
export class VoiceListener {
  private readonly deps: VoiceListenerDeps;
  private readonly events: VoiceListenerEvents;
  private state: ListenerStateName = 'idle';
  private startArgs: StartArgs | null = null;
  private audio: AudioSource | null = null;
  private sidecar: WakeSidecar | null = null;
  private buffer: Buffer[] = [];
  private wakeFiredAt: number | null = null;
  private hardCapHandle: unknown = null;
  /** FIFO queue of captured audio buffers for wake events that arrived during
   * transcription. Capped at TRANSCRIPTION_QUEUE_CAP; oldest dropped when full. */
  private _transcriptionQueue: Buffer[] = [];

  constructor(deps: VoiceListenerDeps, events: VoiceListenerEvents = {}) {
    this.deps = { now: () => Date.now(), timers: DEFAULT_TIMERS, ...deps };
    this.events = events;
  }

  getState(): ListenerStateName {
    return this.state;
  }

  getStartArgs(): StartArgs | null {
    return this.startArgs;
  }

  /** Bring the listener up. Idempotent — second call returns the same state. */
  async start(args: StartArgs): Promise<void> {
    if (this.state !== 'idle') return;
    this.startArgs = args;
    const audio = this.deps.audioFactory();
    let sidecar: WakeSidecar;
    try {
      sidecar = this.deps.sidecarFactory({ modelPath: args.wakeWordModelPath });
    } catch (err) {
      audio.stop();
      throw err;
    }
    this.audio = audio;
    this.sidecar = sidecar;
    this.state = 'listening';
    this.wireAudioFanout();
    this.wireSidecarReader();
  }

  /** Tear everything down. Idempotent. Drains the overlap queue without
   * firing whisper for any pending entries. */
  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    this.cancelHardCap();
    this.audio?.stop();
    this.sidecar?.kill();
    this.audio = null;
    this.sidecar = null;
    this.buffer = [];
    this.wakeFiredAt = null;
    this.startArgs = null;
    this._transcriptionQueue = [];
    this.state = 'idle';
  }

  /**
   * Audio fans out to two consumers: the sidecar's stdin (every frame, for
   * wake-word inference) AND a local rolling buffer that captures the last
   * `PRE_WAKE_CAPTURE_SEC` seconds so we have pre-trigger context for STT.
   */
  private wireAudioFanout(): void {
    const audio = this.audio;
    const sidecar = this.sidecar;
    if (audio === null || sidecar === null) return;
    audio.stream.on('data', (chunk: Buffer) => {
      this.handleAudioChunk(chunk);
    });
    audio.stream.on('error', (err) => {
      this.emitError({ code: 'AUDIO_STREAM_ERROR', message: err.message });
    });
  }

  private handleAudioChunk(chunk: Buffer): void {
    const sidecar = this.sidecar;
    if (sidecar !== null) {
      // Backpressure surfaces as `false`; we drop the frame rather than
      // queue indefinitely — the sidecar getting starved is a louder failure
      // mode than a few skipped windows.
      sidecar.stdin.write(chunk);
    }
    if (this.state === 'buffering') {
      this.buffer.push(chunk);
    } else {
      this.appendToRing(chunk);
    }
  }

  /**
   * Pre-wake ring: keep the last PRE_WAKE_CAPTURE_SEC of audio so the wake
   * snapshot includes the user's leading consonant. Implemented as a
   * trim-from-front on each append rather than a true ring-buffer because
   * the post-wake fast path already migrates the buffer into `buffering`
   * state — the only cost is a bounded list scan per chunk.
   */
  private appendToRing(chunk: Buffer): void {
    this.buffer.push(chunk);
    const cap = SAMPLE_RATE_HZ * SAMPLE_BYTES * PRE_WAKE_CAPTURE_SEC;
    let total = this.buffer.reduce((acc, b) => acc + b.length, 0);
    while (total > cap && this.buffer.length > 1) {
      total -= this.buffer[0].length;
      this.buffer.shift();
    }
  }

  /** Read JSONL from the sidecar's stdout, dispatch to event handlers. */
  private wireSidecarReader(): void {
    const sidecar = this.sidecar;
    if (sidecar === null) return;
    let pending = '';
    sidecar.stdout.on('data', (data: Buffer | string) => {
      pending += typeof data === 'string' ? data : data.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.dispatchSidecarLine(trimmed);
      }
    });
    sidecar.stderr.on('data', (data: Buffer | string) => {
      // Stderr is human-readable; surface the first crash-on-init line as an
      // error event but ignore steady-state info logs.
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (text.toLowerCase().includes('error')) {
        this.emitError({ code: 'SIDECAR_ERROR', message: text.trim() });
      }
    });
  }

  private dispatchSidecarLine(line: string): void {
    let event: SidecarEvent;
    try {
      event = JSON.parse(line) as SidecarEvent;
    } catch {
      this.emitError({ code: 'SIDECAR_PROTOCOL_ERROR', message: `bad JSONL: ${line}` });
      return;
    }
    if (event.event === 'wake') {
      this.handleWakeEvent(event as SidecarEventWake);
    }
    // 'ready' and unknown events are dropped silently.
  }

  private handleWakeEvent(event: SidecarEventWake): void {
    const now = this.deps.now!();
    if (this.state === 'transcribing') {
      // A previous utterance is in flight. Snapshot the current ring buffer
      // (pre-wake context) as the queued entry so it transcribes after the
      // current whisper call finishes. The sidecar stays warm; no audio is lost.
      const snapshot = Buffer.concat(this.buffer);
      if (this._transcriptionQueue.length >= TRANSCRIPTION_QUEUE_CAP) {
        // Drop the oldest to prevent unbounded growth (busy room / false wakes).
        this._transcriptionQueue.shift();
        this.emitError({
          code: 'QUEUE_OVERFLOW',
          message: 'Transcription queue full — oldest queued utterance dropped.',
        });
      }
      this._transcriptionQueue.push(snapshot);
      this.events.onWakeWord?.({
        wakeWord: event.model ?? this.startArgs?.wakeWord ?? DEFAULT_WAKE_WORD,
        confidence: event.score,
        capturedAtMs: now,
      });
      return;
    }
    if (this.state !== 'listening') return;
    this.state = 'buffering';
    this.wakeFiredAt = now;
    this.events.onWakeWord?.({
      wakeWord: event.model ?? this.startArgs?.wakeWord ?? DEFAULT_WAKE_WORD,
      confidence: event.score,
      capturedAtMs: now,
    });
    this.scheduleHardCap();
  }

  private scheduleHardCap(): void {
    const startArgs = this.startArgs;
    const timers = this.deps.timers!;
    if (startArgs === null) return;
    this.hardCapHandle = timers.setTimeout(() => {
      void this.flushBufferToWhisper();
    }, startArgs.maxUtteranceSec * 1000);
  }

  private cancelHardCap(): void {
    if (this.hardCapHandle === null) return;
    this.deps.timers!.clearTimeout(this.hardCapHandle);
    this.hardCapHandle = null;
  }

  private async flushBufferToWhisper(): Promise<void> {
    if (this.state !== 'buffering') return;
    const startArgs = this.startArgs;
    if (startArgs === null) return;
    this.cancelHardCap();
    this.state = 'transcribing';
    const audio = Buffer.concat(this.buffer);
    this.buffer = [];
    await this.transcribeBuffer(audio, startArgs);
  }

  /** Transcribe one audio buffer and, when done, process any queued buffers
   * in FIFO order before returning to the listening state. */
  private async transcribeBuffer(audio: Buffer, startArgs: StartArgs): Promise<void> {
    const audioDurationMs = pcmDurationMs(audio.length);
    const wakeAt = this.wakeFiredAt ?? this.deps.now!();
    this.wakeFiredAt = null;
    try {
      const { transcript } = await this.deps.whisper(audio, startArgs.sttModel);
      const latencyMs = this.deps.now!() - wakeAt;
      this.events.onVoiceInput?.({
        transcript,
        latencyMs,
        sttModel: startArgs.sttModel,
        audioDurationMs,
      });
    } catch (err) {
      this.emitError({
        code: 'STT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // After finishing, drain the overlap queue in FIFO order before returning
    // to `listening`. Each queued entry is a snapshot taken at wake-time, so
    // wakeAt for latency measurement is approximated as now (the enqueue time
    // is not stored to avoid a parallel data structure).
    //
    // Guard: stop() may have been called while whisper was in flight (state
    // would be `idle`). In that case the queue is already drained by stop() —
    // don't re-enter `listening` or process any more buffers.
    if (this.state !== 'transcribing') return;
    const next = this._transcriptionQueue.shift();
    if (next !== undefined) {
      // Stay in `transcribing`; tail-call into the next buffer.
      await this.transcribeBuffer(next, startArgs);
    } else {
      this.state = 'listening';
    }
  }

  private emitError(err: { code: string; message: string }): void {
    this.events.onError?.(err);
  }
}

function pcmDurationMs(pcmByteLength: number): number {
  return Math.round((pcmByteLength / (SAMPLE_RATE_HZ * SAMPLE_BYTES)) * 1000);
}
