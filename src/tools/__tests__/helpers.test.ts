import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// Stub the SDK so the static import chain helpers.ts -> errors.ts ->
// '@voltras/node-sdk' doesn't pull in optional native peers.
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

const { textResult, errorResult, wrapHandler } = await import('../helpers.js');

describe('textResult', () => {
  it('serializes data into a single text content block with no isError flag', () => {
    const result = textResult({ x: 1 });
    expect(result.content).toEqual([{ type: 'text', text: '{"x":1}' }]);
    expect(result.isError).toBeUndefined();
  });

  it('round-trips through JSON.parse for arrays and primitives', () => {
    const arr = textResult([1, 'two', null]);
    expect(JSON.parse(arr.content[0].text)).toEqual([1, 'two', null]);
  });
});

describe('errorResult', () => {
  it('wraps a code/message payload as a JSON text block with isError=true', () => {
    const result = errorResult({ code: 'FOO', message: 'bar' });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"code":"FOO","message":"bar"}' }],
      isError: true,
    });
  });
});

describe('wrapHandler', () => {
  const schema = z.object({ name: z.string() });

  it('parses input, calls fn with typed data, and returns a textResult', async () => {
    const fn = vi.fn(async (input: { name: string }) => ({
      greeting: `hi ${input.name}`,
    }));
    const handler = wrapHandler(schema, fn);

    const result = await handler({ name: 'alex' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ name: 'alex' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ greeting: 'hi alex' });
  });

  it('returns INVALID_INPUT and does NOT call fn when input fails validation', async () => {
    const fn = vi.fn(async () => 'unreachable');
    const handler = wrapHandler(schema, fn);

    const result = await handler({ name: 42 });

    expect(fn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      code: string;
      message: string;
    };
    expect(parsed.code).toBe('INVALID_INPUT');
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message.length).toBeGreaterThan(0);
  });

  it('also returns INVALID_INPUT when the input is structurally absent', async () => {
    const fn = vi.fn(async () => 'unreachable');
    const handler = wrapHandler(schema, fn);

    const result = await handler(undefined);

    expect(fn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
  });

  it('maps a VoltraSDKError thrown by fn into an errorResult with the SDK code', async () => {
    const fn = vi.fn(async () => {
      throw new FakeVoltraSDKError('disconnected mid-command', 'CONNECTION_LOST');
    });
    const handler = wrapHandler(schema, fn);

    const result = await handler({ name: 'alex' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'CONNECTION_LOST',
      message: 'disconnected mid-command',
    });
  });

  it('maps a plain Error thrown by fn to UNKNOWN code', async () => {
    const fn = vi.fn(async () => {
      throw new Error('something broke');
    });
    const handler = wrapHandler(schema, fn);

    const result = await handler({ name: 'alex' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'UNKNOWN',
      message: 'something broke',
    });
  });

  it('never throws — bad input resolves rather than rejects', async () => {
    const fn = vi.fn(async () => 'x');
    const handler = wrapHandler(schema, fn);
    await expect(handler({ name: 42 })).resolves.toBeDefined();
  });

  it('never throws — fn throwing resolves rather than rejects', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    const handler = wrapHandler(schema, fn);
    await expect(handler({ name: 'alex' })).resolves.toBeDefined();
  });

  it('passes through an `extra` arg without disturbing the result', async () => {
    const fn = vi.fn(async (input: { name: string }) => input.name);
    const handler = wrapHandler(schema, fn);

    const result = await handler({ name: 'alex' }, { signal: new AbortController().signal });

    expect(fn).toHaveBeenCalledWith({ name: 'alex' });
    expect(JSON.parse(result.content[0].text)).toBe('alex');
  });
});
