// Tests for `timer.wait`, `timer.start`, and `timer.cancel`.
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

const { registerTimerTools, __resetTimerState, formatDuration } = await import('../timer-tools.js');
const { makeFakeLease } = await import('../../state/__tests__/fixtures/lease-fence.js');
type FakeLease = ReturnType<typeof makeFakeLease>;

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { PushTimer } from '../timer-tools.js';
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
  for (const name of ['timer.wait', 'timer.start', 'timer.cancel']) {
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

interface FakeChannels {
  publish: ReturnType<typeof vi.fn>;
  /** `lease_lost` is slot-scoped, so the fence publishes through `forSlot`. */
  forSlot: () => FakeChannels;
}

function makeFakeState(): { state: ServerState; channels: FakeChannels; lease: FakeLease } {
  const channels: FakeChannels = { publish: vi.fn(), forSlot: () => channels };
  const timers = new Map<string, PushTimer>();
  const lease = makeFakeLease();
  const state = { channels, timers, lease } as unknown as ServerState;
  return { state, channels, lease };
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe('timer.wait / timer.cancel (blocking)', () => {
  let waitCb: Callback;
  let cancelCb: Callback;
  let lease: FakeLease;
  let channels: FakeChannels;

  beforeEach(() => {
    vi.useFakeTimers();
    const { placeholders, slots } = buildPlaceholders();
    const fake = makeFakeState();
    lease = fake.lease;
    channels = fake.channels;
    registerTimerTools({} as McpServer, fake.state, placeholders);
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

  // VW-200: a rest is the longest a session sits still holding the device, so
  // it is the likeliest call to be running when another client takes over.
  it('fails with LEASE_LOST when the device is taken mid-rest', async () => {
    const waitPromise = waitCb({ durationMs: 90_000, label: 'rest' });
    await vi.advanceTimersByTimeAsync(2000);

    lease.steal();
    const result = await waitPromise;

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'LEASE_LOST' });
  });

  it('publishes one lease_lost naming timer.wait when the rest is cut short', async () => {
    const waitPromise = waitCb({ durationMs: 90_000, label: 'rest' });

    lease.steal();
    await waitPromise;

    expect(channels.publish).toHaveBeenCalledTimes(1);
    const event = channels.publish.mock.calls[0][0] as { meta: Record<string, string> };
    expect(event.meta.event_type).toBe('lease_lost');
    expect(event.meta.tool).toBe('timer.wait');
  });

  it('frees the singleton on a steal, so the next holder is not told BUSY', async () => {
    const stolen = waitCb({ durationMs: 90_000 });
    lease.steal();
    await stolen;

    const next = waitCb({ durationMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    expect(payload(await next)).toMatchObject({ status: 'completed', requestedMs: 500 });
  });

  it('never fires the rest timer after a steal cut it short', async () => {
    const waitPromise = waitCb({ durationMs: 1000 });
    lease.steal();
    await waitPromise;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(channels.publish).toHaveBeenCalledTimes(1);
  });

  it('runs to completion when the holder keeps the lease across the rest', async () => {
    // The sanity case: a lease that notifies without moving its generation —
    // the holder refreshing its own claim — must not abort anything.
    const waitPromise = waitCb({ durationMs: 5000, label: 'rest' });
    await vi.advanceTimersByTimeAsync(2000);
    lease.touch();
    await vi.advanceTimersByTimeAsync(3000);

    expect(payload(await waitPromise)).toMatchObject({ status: 'completed', label: 'rest' });
    expect(channels.publish).not.toHaveBeenCalled();
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

describe('timer.start (non-blocking)', () => {
  let startCb: Callback;
  let cancelCb: Callback;
  let channels: FakeChannels;
  let state: ServerState;

  beforeEach(() => {
    vi.useFakeTimers();
    const { placeholders, slots } = buildPlaceholders();
    const fake = makeFakeState();
    state = fake.state;
    channels = fake.channels;
    registerTimerTools({} as McpServer, state, placeholders);
    startCb = slots.get('timer.start')!.callback;
    cancelCb = slots.get('timer.cancel')!.callback;
  });

  afterEach(() => {
    // Drain any leftover scheduled timers and clear push registry between
    // cases so background `setTimeout`s from one test don't bleed into the
    // next test's expectations.
    for (const t of state.timers.values()) {
      clearTimeout(t.handle);
    }
    state.timers.clear();
    __resetTimerState();
    vi.useRealTimers();
  });

  it('returns a timer_id synchronously without blocking', async () => {
    const before = Date.now();
    const result = await startCb({ durationMs: 60_000, label: 'rest' });
    expect(result.isError).toBeUndefined();
    const body = payload(result) as { timer_id: string; label: string; durationMs: number };
    expect(typeof body.timer_id).toBe('string');
    expect(body.timer_id.length).toBeGreaterThan(0);
    expect(body.label).toBe('rest');
    expect(body.durationMs).toBe(60_000);
    // Awaited synchronously — no fake-timer advance needed for the await.
    expect(Date.now()).toBe(before);
    expect(channels.publish).not.toHaveBeenCalled();
  });

  it('fires a timer_complete channel event when the duration elapses', async () => {
    await startCb({ durationMs: 30_000, label: 'between sets' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(channels.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(channels.publish).toHaveBeenCalledTimes(1);
    const event = channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(event.meta).toMatchObject({
      source: 'voltras',
      event_type: 'timer_complete',
      label: 'between sets',
      duration_ms: '30000',
    });
    expect(typeof event.meta.timer_id).toBe('string');
    expect(event.meta.timer_id.length).toBeGreaterThan(0);
    expect(typeof event.meta.expected_at).toBe('string');
    const parsed = JSON.parse(event.content) as { summary: string };
    expect(parsed.summary).toContain('between sets');
    expect(parsed.summary).toContain('0:30');
  });

  it('removes the timer from state.timers once it fires', async () => {
    const result = await startCb({ durationMs: 5_000, label: 'rest' });
    const id = (payload(result) as { timer_id: string }).timer_id;
    expect(state.timers.has(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.timers.has(id)).toBe(false);
  });

  it('cancel by timer_id prevents the channel emission', async () => {
    const result = await startCb({ durationMs: 60_000, label: 'rest' });
    const id = (payload(result) as { timer_id: string }).timer_id;

    const cancelResult = await cancelCb({ timer_id: id });
    expect(cancelResult.isError).toBeUndefined();
    expect(payload(cancelResult)).toMatchObject({
      cancelled: true,
      timer_id: id,
      label: 'rest',
    });
    expect(state.timers.has(id)).toBe(false);

    // Advance past the original duration — no channel event should fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channels.publish).not.toHaveBeenCalled();
  });

  it('cancel with unknown timer_id is a no-op success', async () => {
    const result = await cancelCb({ timer_id: 'no-such-id' });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      cancelled: false,
      reason: 'no matching timer',
    });
  });

  it('multiple in-flight timers each get unique IDs and fire independently', async () => {
    const r1 = await startCb({ durationMs: 10_000, label: 'short' });
    const r2 = await startCb({ durationMs: 20_000, label: 'long' });
    const id1 = (payload(r1) as { timer_id: string }).timer_id;
    const id2 = (payload(r2) as { timer_id: string }).timer_id;
    expect(id1).not.toBe(id2);
    expect(state.timers.size).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    // First should have fired but second still pending.
    expect(channels.publish).toHaveBeenCalledTimes(1);
    expect((channels.publish.mock.calls[0][0] as { meta: { label: string } }).meta.label).toBe(
      'short',
    );
    expect(state.timers.has(id1)).toBe(false);
    expect(state.timers.has(id2)).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(channels.publish).toHaveBeenCalledTimes(2);
    expect((channels.publish.mock.calls[1][0] as { meta: { label: string } }).meta.label).toBe(
      'long',
    );
    expect(state.timers.has(id2)).toBe(false);
  });

  it('rejects invalid input (missing label, zero duration, huge duration)', async () => {
    for (const bad of [
      { durationMs: 1_000 }, // missing label
      { durationMs: 0, label: 'rest' },
      { durationMs: 60 * 60 * 1000 + 1, label: 'rest' },
      { durationMs: 1000, label: '' },
    ]) {
      const result = await startCb(bad);
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});

describe('formatDuration', () => {
  it('formats sub-hour durations as M:SS', () => {
    expect(formatDuration(30_000)).toBe('0:30');
    expect(formatDuration(90_000)).toBe('1:30');
    expect(formatDuration(125_000)).toBe('2:05');
  });

  it('formats hour-or-longer durations as H:MM:SS', () => {
    expect(formatDuration(60 * 60 * 1000)).toBe('1:00:00');
    expect(formatDuration(60 * 60 * 1000 + 5_000)).toBe('1:00:05');
  });

  it('clamps negative durations to zero', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });
});
