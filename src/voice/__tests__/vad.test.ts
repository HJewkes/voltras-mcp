// VMCP-02.77 P1: contract tests for the Silero VAD wrapper. These exercise the
// REAL onnxruntime-node session against the bundled model with deterministic
// silence input — proving the ONNX plumbing and recurrent state threading
// without needing a real speech fixture (that lives in scripts/vad-parity.mjs).

import { describe, expect, it } from 'vitest';

import { createSileroVad, VAD_FRAME_SAMPLES } from '../vad.js';

describe('createSileroVad', () => {
  it('returns a finite low probability for repeated silence frames', async () => {
    const vad = createSileroVad();
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
    const vad = createSileroVad();
    await expect(vad.process(new Int16Array(VAD_FRAME_SAMPLES - 1))).rejects.toThrow(/512 samples/);
  });

  it('reset() clears recurrent state without throwing', async () => {
    const vad = createSileroVad();
    await vad.process(new Int16Array(VAD_FRAME_SAMPLES));
    expect(() => vad.reset()).not.toThrow();
    const prob = await vad.process(new Int16Array(VAD_FRAME_SAMPLES));
    expect(prob).toBeLessThan(0.5);
  });
});
