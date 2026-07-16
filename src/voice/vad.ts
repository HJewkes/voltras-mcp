// VMCP-02.77 P1: Silero VAD v4 speech-probability gate for the STT listener.
//
// `process()` is ASYNC (returns Promise<number>). onnxruntime-node's
// `InferenceSession.run()` is the only inference entry point and it is async —
// there is no synchronous run() — so a sync `process()` is not achievable. The
// segmenter/listener awaits each frame.
//
// Model contract (introspected from the bundled silero_vad.onnx, v4 LSTM):
//   inputs : input float32 [1,N], sr int64 scalar (=16000), h float32 [2,1,64],
//            c float32 [2,1,64]
//   outputs: output float32 [1,1] (speech prob), hn/cn float32 [2,1,64]
// Each call threads h/c → hn/cn to carry the recurrent LSTM state forward.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Ort from 'onnxruntime-node';

export const VAD_FRAME_SAMPLES = 512;

// Silero v4 LSTM state is [2,1,64] for both h and c.
const STATE_LEN = 2 * 1 * 64;
const SAMPLE_RATE = 16000;

export interface Vad {
  /** Returns speech probability [0,1]; maintains recurrent h/c state. */
  process(frame: Int16Array): Promise<number>;
  /** Zero the h/c recurrent state. */
  reset(): void;
}

export function createSileroVad(opts?: { modelPath?: string }): Vad {
  const modelPath = opts?.modelPath ?? resolveModelPath();
  let ort: typeof Ort | null = null;
  let sessionPromise: Promise<Ort.InferenceSession> | null = null;
  let h = new Float32Array(STATE_LEN);
  let c = new Float32Array(STATE_LEN);

  // Lazy: import the native module on first frame, not at module load, so a
  // missing onnxruntime-node binary surfaces at process() time. Linux CI
  // imports this module without ever running it.
  const ensureSession = async (): Promise<Ort.InferenceSession> => {
    if (sessionPromise === null) {
      ort = await import('onnxruntime-node');
      sessionPromise = ort.InferenceSession.create(modelPath);
    }
    return sessionPromise;
  };

  return {
    async process(frame: Int16Array): Promise<number> {
      if (frame.length !== VAD_FRAME_SAMPLES) {
        throw new Error(`VAD frame must be ${VAD_FRAME_SAMPLES} samples, got ${frame.length}`);
      }
      const session = await ensureSession();
      const feeds = buildFeeds(ort as typeof Ort, int16ToFloat32(frame), h, c);
      const out = await session.run(feeds);
      // Copy out of the tensor buffers so the next run's feeds own their memory.
      h = new Float32Array(out.hn.data as Float32Array);
      c = new Float32Array(out.cn.data as Float32Array);
      return (out.output.data as Float32Array)[0];
    },
    reset(): void {
      h = new Float32Array(STATE_LEN);
      c = new Float32Array(STATE_LEN);
    },
  };
}

/** int16 PCM → float32 normalized to [-1,1) by the full-scale 32768 divisor. */
function int16ToFloat32(frame: Int16Array): Float32Array {
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    out[i] = frame[i] / 32768;
  }
  return out;
}

function buildFeeds(
  ort: typeof Ort,
  audio: Float32Array,
  h: Float32Array,
  c: Float32Array,
): Record<string, Ort.Tensor> {
  return {
    input: new ort.Tensor('float32', audio, [1, audio.length]),
    sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    h: new ort.Tensor('float32', h, [2, 1, 64]),
    c: new ort.Tensor('float32', c, [2, 1, 64]),
  };
}

/**
 * Resolve `voice-models/silero_vad.onnx` by walking up from this module. Dev
 * layout is `src/voice/vad.ts`, built layout `dist/voice/vad.js`; both reach
 * the repo root (which holds `voice-models/`) within a few parents.
 */
function resolveModelPath(): string {
  const override = process.env.VOLTRAS_VAD_MODEL;
  if (override !== undefined && existsSync(override)) return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'voice-models', 'silero_vad.onnx');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dir, 'voice-models', 'silero_vad.onnx');
}
