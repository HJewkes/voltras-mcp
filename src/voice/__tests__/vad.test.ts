// VMCP-02.77 P1: contract tests for the Silero VAD wrapper. These exercise the
// REAL onnxruntime-node session against the bundled model with deterministic
// silence input — proving the ONNX plumbing and recurrent state threading
// without needing a real speech fixture (that lives in scripts/vad-parity.mjs).

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSileroVad, VAD_FRAME_SAMPLES, type Vad } from '../vad.js';

// Native import plus model load is CPU-bound and took a per-test 5 s budget over under
// full-suite load (VW-696). One warmed session serves every case; reset() gives each a zero state.
const SESSION_LOAD_TIMEOUT_MS = 60_000;

describe('createSileroVad', () => {
  let vad: Vad;

  beforeAll(async () => {
    vad = createSileroVad();
    await vad.process(new Int16Array(VAD_FRAME_SAMPLES));
  }, SESSION_LOAD_TIMEOUT_MS);

  beforeEach(() => {
    vad.reset();
  });

  it('returns a finite low probability for repeated silence frames', async () => {
    const silence = new Int16Array(VAD_FRAME_SAMPLES); // all zeros
    for (let i = 0; i < 5; i += 1) {
      const prob = await vad.process(silence);
      expect(Number.isFinite(prob)).toBe(true);
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
      expect(prob).toBeLessThan(0.5);
    }
  });

  it('throws on a wrong-length frame', async () => {
    await expect(vad.process(new Int16Array(VAD_FRAME_SAMPLES - 1))).rejects.toThrow(/512 samples/);
  });

  it('reset() clears recurrent state without throwing', async () => {
    await vad.process(new Int16Array(VAD_FRAME_SAMPLES));
    expect(() => vad.reset()).not.toThrow();
    const prob = await vad.process(new Int16Array(VAD_FRAME_SAMPLES));
    expect(prob).toBeLessThan(0.5);
  });
});
