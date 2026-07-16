// Schema tests for the `system.listen_*` voice tools.
//
// The schemas are the user-facing input contract; pinning them here keeps
// the model / dispatch layer from silently accepting fields that won't
// actually plumb through to the listener.

import { describe, expect, it } from 'vitest';

import { SystemListenStartInput, SystemListenStopInput } from '../voice.js';

describe('SystemListenStartInput', () => {
  it('accepts an empty object — defaults applied at the listener layer', () => {
    const result = SystemListenStartInput.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts known sttModel values', () => {
    for (const model of ['tiny.en', 'base.en', 'small.en'] as const) {
      const result = SystemListenStartInput.safeParse({ sttModel: model });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown sttModel', () => {
    const result = SystemListenStartInput.safeParse({ sttModel: 'large' });
    expect(result.success).toBe(false);
  });

  it('rejects removed wake-word fields + unknown keys (strict)', () => {
    expect(SystemListenStartInput.safeParse({ wakeWord: 'hey_jarvis' }).success).toBe(false);
    expect(SystemListenStartInput.safeParse({ wakeWordModelPath: 'x.onnx' }).success).toBe(false);
    expect(SystemListenStartInput.safeParse({ bogus: true }).success).toBe(false);
  });

  it('bounds maxUtteranceSec to a sane range', () => {
    expect(SystemListenStartInput.safeParse({ maxUtteranceSec: 1 }).success).toBe(false);
    expect(SystemListenStartInput.safeParse({ maxUtteranceSec: 31 }).success).toBe(false);
    expect(SystemListenStartInput.safeParse({ maxUtteranceSec: 12 }).success).toBe(true);
  });

  it('accepts custom wakePhrases', () => {
    expect(SystemListenStartInput.safeParse({ wakePhrases: ['hey coach'] }).success).toBe(true);
    expect(SystemListenStartInput.safeParse({ wakePhrases: ['a', 'b'] }).success).toBe(true);
  });

  it('rejects an empty wakePhrases array or empty phrase', () => {
    expect(SystemListenStartInput.safeParse({ wakePhrases: [] }).success).toBe(false);
    expect(SystemListenStartInput.safeParse({ wakePhrases: [''] }).success).toBe(false);
  });
});

describe('SystemListenStopInput', () => {
  it('accepts an empty object', () => {
    const result = SystemListenStopInput.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects extra fields', () => {
    const result = SystemListenStopInput.safeParse({ force: true });
    expect(result.success).toBe(false);
  });
});
