import { describe, it, expect, vi } from 'vitest';
import type * as VoltraSdk from '@voltras/node-sdk';
import { log } from '../logger.js';

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
const { ErrorCode } = await vi.importActual<typeof VoltraSdk>('@voltras/node-sdk');

const SAFE_SDK_CODES = ['NOT_CONNECTED', 'ALREADY_CONNECTED'];
const INNER_DETAIL = 'inner detail 0042';

describe('mapSdkError on every SDK error code', () => {
  const unsafeCodes = Object.values(ErrorCode).filter((code) => !SAFE_SDK_CODES.includes(code));

  it('reads the codes from the SDK itself', () => {
    expect(unsafeCodes.length).toBeGreaterThan(SAFE_SDK_CODES.length);
  });

  it.each(unsafeCodes)('%s keeps its code and never echoes the SDK message', (code) => {
    const result = mapSdkError(new FakeVoltraSDKError(`Failed: ${INNER_DETAIL}`, code));
    expect(result.code).toBe(code);
    expect(result.message).not.toContain(INNER_DETAIL);
    expect(result.message).not.toMatch(/\d/);
  });

  it.each(SAFE_SDK_CODES)('%s passes its fixed SDK message through', (code) => {
    const result = mapSdkError(new FakeVoltraSDKError('Device is not connected', code));
    expect(result).toEqual({ code, message: 'Device is not connected' });
  });

  it('words a code the SDK adds later generically, keeping the code', () => {
    const result = mapSdkError(new FakeVoltraSDKError(INNER_DETAIL, 'SOME_FUTURE_CODE'));
    expect(result.code).toBe('SOME_FUTURE_CODE');
    expect(result.message).toMatch(/^The device reported an error/);
  });

  it('sends the raw SDK message to the debug log only', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => undefined);
    mapSdkError(new FakeVoltraSDKError(INNER_DETAIL, 'AUTH_FAILED'));
    expect(debug).toHaveBeenCalledWith('sdk error', 'AUTH_FAILED', INNER_DETAIL);
    debug.mockRestore();
  });
});

describe('mapSdkError', () => {
  it('maps a VoltraSDKError to its code with its own wording', () => {
    const err = new FakeVoltraSDKError('lost link', 'CONNECTION_LOST');
    const result = mapSdkError(err);
    expect(result.code).toBe('CONNECTION_LOST');
    expect(result.message).toMatch(/connection to the device dropped/);
  });

  it('words a device-state-unknown refusal itself, keeping the code', () => {
    const err = new FakeVoltraSDKError('internal wording', 'DEVICE_STATE_UNKNOWN');
    const result = mapSdkError(err);
    expect(result.code).toBe('DEVICE_STATE_UNKNOWN');
    expect(result.message).toMatch(/nothing was written/);
  });

  it('finds a connection refusal wrapped as the cause of a generic connect failure', () => {
    const refusal = new FakeVoltraSDKError('refused, status 7', 'CONNECTION_REFUSED');
    const wrapped = Object.assign(
      new FakeVoltraSDKError('Connection failed', 'CONNECTION_FAILED'),
      {
        cause: refusal,
      },
    );
    const result = mapSdkError(wrapped);
    expect(result.code).toBe('CONNECTION_REFUSED');
    expect(result.message).not.toMatch(/status/);
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
