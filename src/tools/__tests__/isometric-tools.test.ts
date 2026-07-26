// Tool-layer integration tests for isometric.measure_max and
// isometric.measure_imbalance.
//
// Strategy: drive the registered tool callbacks with a fake VoltraClient
// that exposes only the surface the tool consumes (`isConnected`, `onFrame`).
// The tool subscribes to `onFrame` once per trial; the test harness fires
// synthetic TelemetryFrames during the trial window via `vi.useFakeTimers()`
// so a 5-second trial completes in microseconds. Rest periods are likewise
// driven by `vi.advanceTimersByTimeAsync`.
//
// Listener-leak guard: each test asserts that the unsubscribe handle
// returned from `onFrame` was called exactly once per trial. If the tool
// ever forgets to detach, the count diverges and the suite fails.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

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

const { registerIsometricTools } = await import('../isometric-tools.js');

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { TelemetryFrame } from '@voltras/node-sdk';
import { FRAME_FORCE_TENTHS_PER_LB } from '../../state/live-signal.js';
import type { ToolResult } from '../helpers.js';
import type { StoredIsometricMeasurement } from '../../store/types.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

interface Slot {
  callback: Callback;
  description?: string;
}

function buildPlaceholders(names: readonly string[]): {
  placeholders: Map<string, RegisteredTool>;
  slots: Map<string, Slot>;
} {
  const slots = new Map<string, Slot>();
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of names) {
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

interface FrameListener {
  cb: (frame: TelemetryFrame) => void;
  unsubscribed: boolean;
}

interface FakeClient {
  isConnected: boolean;
  onFrame: Mock<(cb: (frame: TelemetryFrame) => void) => () => void>;
  /** Active frame listeners, in subscription order. */
  listeners: FrameListener[];
  /** Lifetime count of calls to onFrame (subscription count). */
  subscribeCount: number;
  /** Lifetime count of unsubscribe calls. */
  unsubscribeCount: number;
}

function makeFakeClient(opts: { isConnected: boolean } = { isConnected: true }): FakeClient {
  const listeners: FrameListener[] = [];
  const fc = {
    isConnected: opts.isConnected,
    listeners,
    subscribeCount: 0,
    unsubscribeCount: 0,
    onFrame: vi.fn((cb: (frame: TelemetryFrame) => void): (() => void) => {
      const entry: FrameListener = { cb, unsubscribed: false };
      listeners.push(entry);
      fc.subscribeCount += 1;
      return () => {
        if (!entry.unsubscribed) {
          entry.unsubscribed = true;
          fc.unsubscribeCount += 1;
        }
      };
    }),
  } as FakeClient;
  return fc;
}

interface FakeSlot {
  slotId: string;
  client: FakeClient;
}

/**
 * Records what `isometric.measure_imbalance` persists (VMCP-04.11) without
 * touching SQLite — the store contract is what the tool depends on, and the
 * SQLite half of it is covered by the v5→v6 migration suite.
 */
interface FakeStore {
  putIsometricMeasurement: Mock<(m: StoredIsometricMeasurement) => Promise<void>>;
  written: StoredIsometricMeasurement[];
  /** Set to make every write reject, standing in for a broken DB. */
  failWith: Error | null;
}

function makeFakeStore(): FakeStore {
  const store = { written: [], failWith: null } as unknown as FakeStore;
  store.putIsometricMeasurement = vi.fn(async (m: StoredIsometricMeasurement): Promise<void> => {
    if (store.failWith !== null) throw store.failWith;
    store.written.push(m);
    return Promise.resolve();
  });
  return store;
}

function makeState(
  slots: Record<string, FakeClient>,
  opts: { store?: FakeStore; deviceIds?: Record<string, string | null> } = {},
): ServerState {
  const slotMap = new Map<string, FakeSlot>();
  for (const [slotId, client] of Object.entries(slots)) {
    // `connectedDeviceId` is the ground-truth identity the tool stamps onto the
    // persisted measurement; `null` models the mock adapter / a dropped unit.
    (client as unknown as { connectedDeviceId: string | null }).connectedDeviceId =
      opts.deviceIds?.[slotId] ?? null;
    slotMap.set(slotId, { slotId, client });
  }
  return { slots: slotMap, store: opts.store } as unknown as ServerState;
}

/**
 * Build a force-rise → plateau → release shape spanning `durationMs` and
 * fire frames into every active listener at the supplied cadence. Consumes
 * fake-timer ticks via `vi.advanceTimersByTimeAsync` so a measurement
 * trial completes deterministically within the test.
 */
async function pumpTrialFrames(
  client: FakeClient,
  durationMs: number,
  peakLbs: number,
  cadenceMs: number = 25,
): Promise<void> {
  const ticks = Math.floor(durationMs / cadenceMs);
  for (let i = 0; i <= ticks; i++) {
    const t = (i * cadenceMs) / durationMs;
    let forceLbs: number;
    if (t < 0.4) forceLbs = peakLbs * (t / 0.4);
    else if (t < 0.9) forceLbs = peakLbs;
    else forceLbs = peakLbs * Math.max(0, 1 - (t - 0.9) * 5);
    const frame: TelemetryFrame = {
      sequence: i,
      phase: 0 as TelemetryFrame['phase'],
      position: 0,
      velocity: 0,
      // Frames carry the raw device unit (tenths of a pound); the isometric
      // tool converts tenths→lb, so emit peakLbs × FRAME_FORCE_TENTHS_PER_LB
      // to land plateau/inferred-weight assertions back on the intended lbs.
      force: forceLbs * FRAME_FORCE_TENTHS_PER_LB,
      timestamp: Date.now(),
    };
    for (const l of client.listeners) {
      if (!l.unsubscribed) l.cb(frame);
    }
    await vi.advanceTimersByTimeAsync(cadenceMs);
  }
}

const TOOL_NAMES = ['isometric.measure_max', 'isometric.measure_imbalance'] as const;

describe('isometric.measure_max', () => {
  let measureMaxCb: Callback;
  let client: FakeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    const state = makeState({ primary: client });
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: returns valid trials, mean plateau, inferred working weight', async () => {
    // Use minimum-allowed durations to keep the test fast even at fake-time
    // resolution (3s × 2 trials, 30s rest = 36s of fake time).
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
    });

    // Pump frames for trial 1.
    await pumpTrialFrames(client, 3000, 200);
    // Drain the rest period.
    await vi.advanceTimersByTimeAsync(30_000);
    // Pump frames for trial 2.
    await pumpTrialFrames(client, 3000, 195);

    const result = await promise;
    const body = payload(result) as {
      ok: boolean;
      slot: string;
      trials: Array<{ valid: boolean; peakForceLbs: number; plateauForceLbs: number }>;
      validTrialCount: number;
      meanPlateauForceLbs: number | null;
      inferredWorkingWeightLbs: number | null;
    };
    expect(body.ok).toBe(true);
    expect(body.slot).toBe('primary');
    expect(body.trials).toHaveLength(2);
    expect(body.trials.every((t) => t.valid)).toBe(true);
    expect(body.validTrialCount).toBe(2);
    // Plateau window of ±250ms around peak picks up some ramp samples on a
    // 3s trial (ramp ends at 1.2s, peak at ~1.6s); mean is below the
    // peak-lbs ceiling.
    expect(body.meanPlateauForceLbs).toBeGreaterThan(170);
    expect(body.meanPlateauForceLbs).toBeLessThan(205);
    expect(body.inferredWorkingWeightLbs).toBeGreaterThan(110);
    // Two onFrame subscriptions, two unsubscribe calls — no listener leak.
    expect(client.subscribeCount).toBe(2);
    expect(client.unsubscribeCount).toBe(2);
  });

  it('returns null mean when fewer than 2 trials are valid', async () => {
    // Use 2 trials but fire NO frames during them — every trial fails the
    // "no samples captured" gate, so 0 valid → mean is null.
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(3000); // trial 1 elapses with no frames
    await vi.advanceTimersByTimeAsync(30_000); // rest
    await vi.advanceTimersByTimeAsync(3000); // trial 2 elapses with no frames
    const result = await promise;
    const body = payload(result) as {
      validTrialCount: number;
      meanPlateauForceLbs: number | null;
      inferredWorkingWeightLbs: number | null;
    };
    expect(body.validTrialCount).toBe(0);
    expect(body.meanPlateauForceLbs).toBeNull();
    expect(body.inferredWorkingWeightLbs).toBeNull();
  });

  it('rejects durationMs out of range with INVALID_INPUT', async () => {
    const result = await measureMaxCb({ durationMs: 1000 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects trials out of range with INVALID_INPUT', async () => {
    const result = await measureMaxCb({ trials: 10 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('returns SLOT_NOT_BOUND when the slot is not connected', async () => {
    client.isConnected = false;
    const result = await measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'SLOT_NOT_BOUND' });
  });

  it('honors restMs between trials (vi.useFakeTimers + advance asserts the wait)', async () => {
    // Kick off a 2-trial measurement with a 90s rest. Verify that after
    // trial 1's frames + duration, advancing by 89,999ms does NOT complete
    // the call, but advancing the final 1ms + trial 2's window does.
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 90_000,
    });
    await pumpTrialFrames(client, 3000, 200);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    // Drain the rest period less one ms.
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    // Final ms + trial 2.
    await vi.advanceTimersByTimeAsync(1);
    await pumpTrialFrames(client, 3000, 195);
    await promise;
    expect(settled).toBe(true);
  });
});

describe('isometric.measure_imbalance', () => {
  let measureImbalanceCb: Callback;
  let leftClient: FakeClient;
  let rightClient: FakeClient;
  let store: FakeStore;

  beforeEach(() => {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    store = makeFakeStore();
    const state = makeState(
      { left: leftClient, right: rightClient },
      { store, deviceIds: { left: 'AA:BB:CC:01', right: 'AA:BB:CC:02' } },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureImbalanceCb = slots.get('isometric.measure_imbalance')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: both sides return valid → imbalance computed', async () => {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });

    // Order is [left, right]. Pump left's two trials, then between-sides
    // rest, then right's two trials.
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);

    const result = await promise;
    const body = payload(result) as {
      ok: boolean;
      testOrder: string[];
      left: { meanPlateauForceLbs: number | null };
      right: { meanPlateauForceLbs: number | null };
      imbalance: { strongerSide: string | null; flagged: boolean; meaningful: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.testOrder).toEqual(['left', 'right']);
    expect(body.left.meanPlateauForceLbs).toBeGreaterThan(170);
    expect(body.right.meanPlateauForceLbs).toBeGreaterThan(150);
    expect(body.imbalance.strongerSide).toBe('left');
    // No listener leaks on either client (2 trials × 1 sub each).
    expect(leftClient.subscribeCount).toBe(2);
    expect(leftClient.unsubscribeCount).toBe(2);
    expect(rightClient.subscribeCount).toBe(2);
    expect(rightClient.unsubscribeCount).toBe(2);
  });

  it('testNonDominantFirst with primary=left + dominantSide=left swaps test order', async () => {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: true,
      dominantSide: 'left',
    });

    // testOrder should be [right, left] — fire frames in that order.
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);

    const result = await promise;
    const body = payload(result) as { testOrder: string[] };
    expect(body.testOrder).toEqual(['right', 'left']);
  });

  it('returns SLOT_NOT_BOUND when one slot is not connected', async () => {
    rightClient.isConnected = false;
    const result = await measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'SLOT_NOT_BOUND' });
  });

  it('rejects primarySlot === secondarySlot with INVALID_INPUT', async () => {
    // Arrange: same device for both limbs — a bilateral test needs two.
    // Act
    const result = await measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
    });
    // Assert: rejected at validation before any trial runs.
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(leftClient.subscribeCount).toBe(0);
  });

  // --- persistence (VMCP-04.11) ---------------------------------------
  //
  // The protocol computed a real asymmetry and dropped it before this landed.
  // These cases pin down WHAT is written: the per-trial observations, keyed on
  // the device id — not the verdict, and not the slot.

  /** Drive a full 2-trial-per-side run with left stronger than right. */
  async function runImbalance(): Promise<unknown> {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    return payload(await promise);
  }

  it('persists both sides trials keyed on device_id, with a timestamp', async () => {
    const body = (await runImbalance()) as { measurementId: string | null };

    expect(store.putIsometricMeasurement).toHaveBeenCalledTimes(1);
    const written = store.written[0];
    expect(body.measurementId).toBe(written.id);
    expect(Date.parse(written.measuredAt)).not.toBeNaN();
    expect(written.analysisVersion).toBeGreaterThanOrEqual(1);
    // Protocol parameters ride along: the numbers are only interpretable
    // against the hold duration and trial count they were collected under.
    expect(written.durationMs).toBe(3000);
    expect(written.trialsRequested).toBe(2);
    expect(written.restMs).toBe(30_000);
    expect(written.betweenSidesRestMs).toBe(60_000);
    expect(written.firstSideTested).toBe('left');

    const left = written.sides.find((s) => s.side === 'left');
    const right = written.sides.find((s) => s.side === 'right');
    // Ground truth is the device id, and each limb carries its own.
    expect(left?.deviceId).toBe('AA:BB:CC:01');
    expect(right?.deviceId).toBe('AA:BB:CC:02');
    // Slot is recorded for diagnostics but is never the identity.
    expect(left?.slot).toBe('left');
    expect(right?.slot).toBe('right');
    // Both sides values, per trial.
    expect(left?.trials).toHaveLength(2);
    expect(right?.trials).toHaveLength(2);
    expect(left?.trials.map((t) => t.index)).toEqual([1, 2]);
    expect(left?.trials.every((t) => t.plateauForceLbs > 0)).toBe(true);
    // The stronger limb is stronger in the STORED numbers too, not just in the
    // response — the write must not scramble which side is which.
    const meanOf = (trials: { plateauForceLbs: number }[]) =>
      trials.reduce((sum, t) => sum + t.plateauForceLbs, 0) / trials.length;
    expect(meanOf(left?.trials ?? [])).toBeGreaterThan(meanOf(right?.trials ?? []));
  });

  it('stores observations only — no asymmetry verdict', async () => {
    // The asymmetry %, stronger side and flagged/meaningful thresholds are
    // recomputed from the stored trials on read. Persisting them would freeze
    // a verdict that the thresholds can move out from under.
    const body = (await runImbalance()) as { imbalance: { strongerSide: string } };
    expect(body.imbalance.strongerSide).toBe('left');

    const written = JSON.stringify(store.written[0]);
    for (const leaked of ['asymmetry', 'strongerSide', 'flagged', 'meaningful', 'inferred']) {
      expect(written).not.toContain(leaked);
    }
  });

  it('records a device-less side as a gap, never a placeholder id', async () => {
    // Mock adapter / dropped unit: no connected device id to stamp.
    (rightClient as unknown as { connectedDeviceId: string | null }).connectedDeviceId = null;
    await runImbalance();

    const right = store.written[0].sides.find((s) => s.side === 'right');
    expect(right).not.toHaveProperty('deviceId');
    // The trials are still recorded — the measurement happened, only the
    // attribution is missing.
    expect(right?.trials).toHaveLength(2);
  });

  it('reports the measurement even when the store write fails', async () => {
    // A bilateral assessment costs the user ten-plus minutes of maximal
    // effort; a DB failure must not throw it away.
    store.failWith = new Error('database is locked');
    const body = (await runImbalance()) as {
      ok: boolean;
      measurementId: string | null;
      imbalance: { strongerSide: string };
    };
    expect(body.ok).toBe(true);
    expect(body.imbalance.strongerSide).toBe('left');
    // …and says so, rather than implying it was saved.
    expect(body.measurementId).toBeNull();
  });
});
