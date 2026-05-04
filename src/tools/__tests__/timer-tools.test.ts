// Tests for `timer.wait` / `timer.cancel`.
//
// `timer.wait` is the rare VMCP tool that's all about timing, so vitest's
// fake timers (`vi.useFakeTimers()`) drive the suite — real wall-clock waits
// would 100x the runtime and add flake. The wrapper grabs the `RegisteredTool`
// callbacks the same way the production code does (placeholder Map) so the
// tests exercise the actual wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the SDK so the static import chain (helpers -> errors -> SDK) does
// not pull in the real package during a focused timer-tools test.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { registerTimerTools, __resetTimerState } = await import('../timer-tools.js');

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult } from '../helpers.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

interface Slot {
  callback: Callback;
  description?: string;
}

function buildPlaceholders(): {
  placeholders: Map<string, RegisteredTool>;
  slots: Map<string, Slot>;
} {
  const slots = new Map<string, Slot>();
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of ['timer.wait', 'timer.cancel']) {
    const slot: Slot = {
      callback: async () => ({ content: [{ type: 'text', text: 'placeholder' }] }),
    };
    slots.set(name, slot);
    placeholders.set(name, {
      update: ({ description, callback }: { description?: string; callback?: Callback }) => {
        if (description !== undefined) slot.description = description;
        if (callback !== undefined) slot.callback = callback;
      },
    } as unknown as RegisteredTool);
  }
  return { placeholders, slots };
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe('timer.wait / timer.cancel', () => {
  let waitCb: Callback;
  let cancelCb: Callback;

  beforeEach(() => {
    vi.useFakeTimers();
    const { placeholders, slots } = buildPlaceholders();
    registerTimerTools({} as McpServer, placeholders);
    waitCb = slots.get('timer.wait')!.callback;
    cancelCb = slots.get('timer.cancel')!.callback;
  });

  afterEach(() => {
    __resetTimerState();
    vi.useRealTimers();
  });

  it('blocks for the requested duration and returns status:completed', async () => {
    const promise = waitCb({ durationMs: 90_000, label: 'rest' });
    // Promise should not resolve before the timer fires.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(payload(result)).toMatchObject({
      status: 'completed',
      requestedMs: 90_000,
      label: 'rest',
    });
  });

  it('rejects a second wait while one is in flight with code:BUSY', async () => {
    const first = waitCb({ durationMs: 5000 });
    const second = await waitCb({ durationMs: 1000 });
    expect(second.isError).toBe(true);
    expect(payload(second)).toMatchObject({ code: 'BUSY' });
    await vi.advanceTimersByTimeAsync(5000);
    await first; // unblock the suite
  });

  it('cancel resolves the in-flight wait early with status:cancelled', async () => {
    const waitPromise = waitCb({ durationMs: 60_000, label: 'rest' });
    await vi.advanceTimersByTimeAsync(2000);
    const cancelResult = await cancelCb({});
    expect(payload(cancelResult)).toEqual({ cancelled: true, label: 'rest' });
    const waitResult = await waitPromise;
    expect(payload(waitResult)).toMatchObject({
      status: 'cancelled',
      label: 'rest',
      requestedMs: 60_000,
    });
  });

  it('cancel with no active timer is a no-op success', async () => {
    const result = await cancelCb({});
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({ cancelled: false, reason: 'no active timer' });
  });

  it('rejects invalid durations (zero, negative, huge) with INVALID_INPUT', async () => {
    for (const bad of [{ durationMs: 0 }, { durationMs: -5 }, { durationMs: 60 * 60 * 1000 + 1 }]) {
      const result = await waitCb(bad);
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('rejects unknown args on cancel (strict schema) with INVALID_INPUT', async () => {
    const result = await cancelCb({ id: 'abc' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('after a wait completes, a fresh wait can start (active state cleared)', async () => {
    const first = waitCb({ durationMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await first;

    const second = waitCb({ durationMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await second;
    expect(payload(result)).toMatchObject({ status: 'completed', requestedMs: 500 });
  });
});
