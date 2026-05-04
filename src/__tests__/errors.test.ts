import { describe, it, expect, vi } from 'vitest';

// Stub the SDK so we don't pull in optional native peers (noble etc.) at
// unit-test time. We only need a `VoltraSDKError` class shaped like the real
// one (extends Error, has a `code` field).
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
}));

const { mapSdkError } = await import('../errors.js');

describe('mapSdkError', () => {
  it('maps a VoltraSDKError to its code and message verbatim', () => {
    const err = new FakeVoltraSDKError('lost link', 'CONNECTION_LOST');
    const result = mapSdkError(err);
    expect(result).toEqual({ code: 'CONNECTION_LOST', message: 'lost link' });
  });

  it('preserves a string `code` field on a plain Error', () => {
    const err = Object.assign(new Error('already paired'), {
      code: 'ALREADY_CONNECTED',
    });
    const result = mapSdkError(err);
    expect(result).toEqual({
      code: 'ALREADY_CONNECTED',
      message: 'already paired',
    });
  });

  it('returns code "UNKNOWN" when an Error has no `code` field', () => {
    const result = mapSdkError(new Error('boom'));
    expect(result).toEqual({ code: 'UNKNOWN', message: 'boom' });
  });

  it('treats a non-string `code` field as missing and falls back to "UNKNOWN"', () => {
    const err = Object.assign(new Error('weird'), { code: 42 });
    const result = mapSdkError(err);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('weird');
  });

  it('maps a non-Error throw (string) to UNKNOWN with stringified message', () => {
    const result = mapSdkError('something bad happened');
    expect(result).toEqual({
      code: 'UNKNOWN',
      message: 'something bad happened',
    });
  });

  it('maps a non-Error throw (number) to UNKNOWN with stringified message', () => {
    const result = mapSdkError(42);
    expect(result).toEqual({ code: 'UNKNOWN', message: '42' });
  });

  it('does not include stack trace text in the message field', () => {
    const err = new Error('noisy');
    // Force a stack containing a recognizable frame marker.
    err.stack = 'Error: noisy\n    at someFn (file.ts:1:1)';
    const result = mapSdkError(err);
    expect(result.message).toBe('noisy');
    expect(result.message).not.toContain('at ');
  });
});
