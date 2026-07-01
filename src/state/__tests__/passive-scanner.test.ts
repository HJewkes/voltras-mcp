// Unit tests for the passive BLE scanner (VMCP-02.19).
//
// All scheduling + I/O is injected through `PassiveScanContext` so these
// tests run on real microtask scheduling without `vi.useFakeTimers` — we
// drive `runTick` directly and assert the state mutations + callback
// invocations.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampInterval,
  createPassiveScanState,
  PASSIVE_SCAN_DEFAULT_INTERVAL_MS,
  PASSIVE_SCAN_MAX_INTERVAL_MS,
  PASSIVE_SCAN_MIN_INTERVAL_MS,
  runTick,
  startPassiveScan,
  stopPassiveScan,
  type PassiveScanContext,
  type PassiveScanDevice,
  type PassiveScanState,
} from '../passive-scanner.js';

interface FakeScheduler {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** Pending entries, in insertion order — tests pop and invoke manually. */
  pending: Array<{ fn: () => void; ms: number; handle: ReturnType<typeof setTimeout> }>;
  /** Cancelled handles (so we can assert clearTimeout was called). */
  cancelled: Array<ReturnType<typeof setTimeout>>;
}

function makeScheduler(): FakeScheduler {
  let nextId = 1;
  const scheduler: FakeScheduler = {
    pending: [],
    cancelled: [],
    setTimeout: (fn, ms) => {
      const handle = nextId++ as unknown as ReturnType<typeof setTimeout>;
      scheduler.pending.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => {
      scheduler.cancelled.push(handle);
      const idx = scheduler.pending.findIndex((p) => p.handle === handle);
      if (idx >= 0) scheduler.pending.splice(idx, 1);
    },
  };
  return scheduler;
}

interface Harness {
  state: PassiveScanState;
  ctx: PassiveScanContext;
  scheduler: FakeScheduler;
  onNewlySeen: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  isAnyDeviceConnected: ReturnType<typeof vi.fn>;
  /** Convenience: invoke whatever's pending. Throws if zero or >1. */
  fireSole: () => Promise<void>;
}

function makeHarness(
  opts: { scanResult?: PassiveScanDevice[] | (() => Promise<PassiveScanDevice[]>) } = {},
): Harness {
  const scheduler = makeScheduler();
  const scan = vi.fn(async () => {
    const r = opts.scanResult ?? [];
    return typeof r === 'function' ? await r() : r;
  });
  const onNewlySeen = vi.fn();
  const onError = vi.fn();
  const isAnyDeviceConnected = vi.fn(() => false);
  const state = createPassiveScanState();
  const ctx: PassiveScanContext = {
    isAnyDeviceConnected,
    scan,
    onNewlySeen,
    onError,
    scheduler,
  };
  const fireSole = async (): Promise<void> => {
    if (scheduler.pending.length !== 1) {
      throw new Error(`fireSole: expected exactly 1 pending, got ${scheduler.pending.length}`);
    }
    const next = scheduler.pending.shift()!;
    next.fn();
    // Allow async work in the tick callback to settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { state, ctx, scheduler, onNewlySeen, onError, scan, isAnyDeviceConnected, fireSole };
}

describe('createPassiveScanState', () => {
  it('returns disabled state with default interval and empty baseline', () => {
    const state = createPassiveScanState();
    expect(state.enabled).toBe(false);
    expect(state.intervalMs).toBe(PASSIVE_SCAN_DEFAULT_INTERVAL_MS);
    expect(state.handle).toBeNull();
    expect(state.seenDeviceIds.size).toBe(0);
  });
});

describe('clampInterval', () => {
  it('passes values inside the band through unchanged', () => {
    expect(clampInterval(30_000)).toBe(30_000);
  });
  it('clamps below-min up to MIN', () => {
    expect(clampInterval(100)).toBe(PASSIVE_SCAN_MIN_INTERVAL_MS);
  });
  it('clamps above-max down to MAX', () => {
    expect(clampInterval(99_999_999)).toBe(PASSIVE_SCAN_MAX_INTERVAL_MS);
  });
});

describe('startPassiveScan', () => {
  it('flips enabled=true, schedules an immediate first tick at 0ms', () => {
    const h = makeHarness();
    startPassiveScan(h.state, h.ctx);
    expect(h.state.enabled).toBe(true);
    expect(h.scheduler.pending).toHaveLength(1);
    expect(h.scheduler.pending[0]!.ms).toBe(0);
  });

  it('overrides intervalMs when supplied; clamps to the legal band', () => {
    const h = makeHarness();
    startPassiveScan(h.state, h.ctx, 5_000_000); // way over MAX
    expect(h.state.intervalMs).toBe(PASSIVE_SCAN_MAX_INTERVAL_MS);
  });

  it('is idempotent: calling while running cancels prior handle and reschedules', () => {
    const h = makeHarness();
    startPassiveScan(h.state, h.ctx);
    const firstHandle = h.state.handle;
    startPassiveScan(h.state, h.ctx, 60_000);
    expect(h.scheduler.cancelled).toContain(firstHandle);
    expect(h.scheduler.pending).toHaveLength(1);
    expect(h.state.intervalMs).toBe(60_000);
  });
});

describe('stopPassiveScan', () => {
  it('clears the pending handle, flips enabled=false, and resets the baseline', () => {
    const h = makeHarness();
    startPassiveScan(h.state, h.ctx);
    h.state.seenDeviceIds.add('d1');
    const handle = h.state.handle;
    stopPassiveScan(h.state, h.ctx);
    expect(h.state.enabled).toBe(false);
    expect(h.state.handle).toBeNull();
    expect(h.state.seenDeviceIds.size).toBe(0);
    expect(h.scheduler.cancelled).toContain(handle);
  });

  it('is a no-op when the scanner is already stopped', () => {
    const h = makeHarness();
    expect(() => stopPassiveScan(h.state, h.ctx)).not.toThrow();
    expect(h.state.enabled).toBe(false);
  });
});

describe('runTick — scan path', () => {
  it('emits voltras_available for newly-seen devices and updates the baseline', async () => {
    const h = makeHarness({
      scanResult: [
        { id: 'a', rssi: -55 },
        { id: 'b', rssi: -60 },
      ],
    });
    h.state.enabled = true;
    await runTick(h.state, h.ctx);
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(h.onNewlySeen).toHaveBeenCalledTimes(1);
    expect(h.onNewlySeen.mock.calls[0]![0]).toEqual([
      { id: 'a', rssi: -55 },
      { id: 'b', rssi: -60 },
    ]);
    expect(Array.from(h.state.seenDeviceIds).sort()).toEqual(['a', 'b']);
    // Next tick scheduled.
    expect(h.scheduler.pending).toHaveLength(1);
    expect(h.scheduler.pending[0]!.ms).toBe(h.state.intervalMs);
  });

  it('does not re-emit when the same devices appear in a follow-up scan', async () => {
    const h = makeHarness({ scanResult: [{ id: 'a' }] });
    h.state.enabled = true;
    await runTick(h.state, h.ctx);
    h.onNewlySeen.mockClear();
    await runTick(h.state, h.ctx);
    expect(h.onNewlySeen).not.toHaveBeenCalled();
  });

  it('emits only the newly-appeared subset when some devices were already seen', async () => {
    const h = makeHarness({ scanResult: [{ id: 'a' }, { id: 'b' }] });
    h.state.enabled = true;
    h.state.seenDeviceIds.add('a');
    await runTick(h.state, h.ctx);
    expect(h.onNewlySeen).toHaveBeenCalledTimes(1);
    expect(h.onNewlySeen.mock.calls[0]![0]).toEqual([{ id: 'b' }]);
    expect(Array.from(h.state.seenDeviceIds).sort()).toEqual(['a', 'b']);
  });

  it('overwriting baseline allows a device that drops and reappears to re-fire', async () => {
    // Scan 1: a + b seen, both fired.
    // Scan 2: only a — baseline becomes {a}.
    // Scan 3: a + b again — b is "newly seen" relative to scan-2 baseline.
    const results: PassiveScanDevice[][] = [
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'a' }],
      [{ id: 'a' }, { id: 'b' }],
    ];
    let i = 0;
    const h = makeHarness({ scanResult: () => Promise.resolve(results[i++]!) });
    h.state.enabled = true;
    await runTick(h.state, h.ctx);
    await runTick(h.state, h.ctx);
    await runTick(h.state, h.ctx);
    expect(h.onNewlySeen).toHaveBeenCalledTimes(2);
    expect(h.onNewlySeen.mock.calls[0]![0].map((d: PassiveScanDevice) => d.id).sort()).toEqual([
      'a',
      'b',
    ]);
    expect(h.onNewlySeen.mock.calls[1]![0]).toEqual([{ id: 'b' }]);
  });
});

describe('runTick — connection gating', () => {
  it('skips the scan when isAnyDeviceConnected() is true; preserves baseline', async () => {
    const h = makeHarness({ scanResult: [{ id: 'a' }] });
    h.state.enabled = true;
    h.state.seenDeviceIds.add('z');
    h.isAnyDeviceConnected.mockReturnValue(true);
    await runTick(h.state, h.ctx);
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.onNewlySeen).not.toHaveBeenCalled();
    expect(Array.from(h.state.seenDeviceIds)).toEqual(['z']);
    // Next tick still scheduled.
    expect(h.scheduler.pending).toHaveLength(1);
  });
});

describe('runTick — error handling', () => {
  it('routes scan() rejection to onError and still schedules the next tick', async () => {
    const boom = new Error('noble busy');
    const h = makeHarness({ scanResult: () => Promise.reject(boom) });
    h.state.enabled = true;
    await runTick(h.state, h.ctx);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError.mock.calls[0]![0]).toBe(boom);
    expect(h.onNewlySeen).not.toHaveBeenCalled();
    expect(h.scheduler.pending).toHaveLength(1);
  });

  it('routes onNewlySeen() throw to onError without breaking the tick loop', async () => {
    const h = makeHarness({ scanResult: [{ id: 'a' }] });
    h.state.enabled = true;
    h.onNewlySeen.mockImplementation(() => {
      throw new Error('publish failed');
    });
    await runTick(h.state, h.ctx);
    expect(h.onError).toHaveBeenCalledTimes(1);
    // Baseline still updated; next tick scheduled.
    expect(h.state.seenDeviceIds.has('a')).toBe(true);
    expect(h.scheduler.pending).toHaveLength(1);
  });
});

describe('runTick — disable race', () => {
  it('drops the scan result if stop() was called while the scan was in flight', async () => {
    let resolve!: (devs: PassiveScanDevice[]) => void;
    const h = makeHarness({
      scanResult: () =>
        new Promise<PassiveScanDevice[]>((r) => {
          resolve = r;
        }),
    });
    h.state.enabled = true;
    const tickPromise = runTick(h.state, h.ctx);
    // Mid-flight: caller stops the scanner.
    stopPassiveScan(h.state, h.ctx);
    // Scan resolves AFTER stop.
    resolve([{ id: 'a' }]);
    await tickPromise;
    expect(h.onNewlySeen).not.toHaveBeenCalled();
    // No re-schedule because state.enabled is false.
    expect(h.scheduler.pending).toHaveLength(0);
  });
});

describe('runTick — stop→start race', () => {
  it('does not spawn a second scan chain when a stop→start straddles an in-flight scan', async () => {
    // Arrange: a running scanner (generation 1) with one tick's scan
    // in-flight and awaiting a resolution we control.
    let resolveInflight!: (devs: PassiveScanDevice[]) => void;
    const h = makeHarness({
      scanResult: () =>
        new Promise<PassiveScanDevice[]>((r) => {
          resolveInflight = r;
        }),
    });
    startPassiveScan(h.state, h.ctx, 10_000);
    h.scheduler.pending.shift(); // discard the auto-scheduled wrapper…
    const inflight = runTick(h.state, h.ctx); // …drive the same tick so we hold its promise.
    expect(h.scan).toHaveBeenCalledTimes(1);

    // Act: stop then start again (generation 2) while the first scan is
    // still awaiting, then let the now-stale scan resolve.
    stopPassiveScan(h.state, h.ctx);
    startPassiveScan(h.state, h.ctx, 10_000);
    resolveInflight([{ id: 'a' }]);
    await inflight;

    // Assert: the stale tick dropped its result and did NOT reschedule —
    // exactly the new chain's single immediate first tick remains.
    expect(h.onNewlySeen).not.toHaveBeenCalled();
    expect(h.scheduler.pending).toHaveLength(1);
    expect(h.scheduler.pending[0]!.ms).toBe(0);
  });

  it('the restarted chain continues normally as the sole live chain', async () => {
    // First scan is deferred (the straddled one); later scans resolve
    // immediately so the new chain can walk forward.
    let resolveInflight!: (devs: PassiveScanDevice[]) => void;
    let call = 0;
    const h = makeHarness({
      scanResult: () => {
        call += 1;
        if (call === 1) return new Promise<PassiveScanDevice[]>((r) => (resolveInflight = r));
        return Promise.resolve([{ id: 'a' }]);
      },
    });
    startPassiveScan(h.state, h.ctx, 10_000);
    h.scheduler.pending.shift();
    const inflight = runTick(h.state, h.ctx);
    stopPassiveScan(h.state, h.ctx);
    startPassiveScan(h.state, h.ctx, 10_000);
    resolveInflight([{ id: 'a' }]);
    await inflight; // stale tick returns without rescheduling

    // The new chain's immediate first tick fires, resolves fresh, and
    // schedules exactly one interval-delayed successor — one live handle.
    await h.fireSole();
    expect(h.onNewlySeen).toHaveBeenCalledTimes(1);
    expect(h.scheduler.pending).toHaveLength(1);
    expect(h.scheduler.pending[0]!.ms).toBe(10_000);
  });
});

describe('runTick — disabled before entry', () => {
  it('is a silent no-op if enabled is false at tick start', async () => {
    const h = makeHarness();
    // enabled defaults to false
    await runTick(h.state, h.ctx);
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.scheduler.pending).toHaveLength(0);
  });
});

describe('integration — start → fire → fire', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ scanResult: [{ id: 'a' }] });
  });
  afterEach(() => {
    stopPassiveScan(h.state, h.ctx);
  });

  it('walks through enable → immediate scan → emit → interval-delayed scan → no-op', async () => {
    startPassiveScan(h.state, h.ctx, 10_000);
    // First scheduled at 0ms.
    expect(h.scheduler.pending[0]!.ms).toBe(0);
    await h.fireSole();
    expect(h.onNewlySeen).toHaveBeenCalledTimes(1);
    // Subsequent tick scheduled at intervalMs.
    expect(h.scheduler.pending[0]!.ms).toBe(10_000);
    await h.fireSole();
    expect(h.onNewlySeen).toHaveBeenCalledTimes(1); // no new devices
    expect(h.scheduler.pending[0]!.ms).toBe(10_000);
  });
});
