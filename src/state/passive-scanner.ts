// Background BLE scanner for device-availability discovery (VMCP-02.19).
//
// Removes session-start friction ("are the Voltras awake yet?") by polling
// for nearby Voltras on a configurable cadence and emitting a
// `voltras_available` channel event when newly-seen devices appear. The
// agent can then react to the event instead of polling `device.scan`.
//
// Concurrency model:
//   * Single-shot `setTimeout` chain (not `setInterval`) — each tick
//     schedules the next AFTER its scan resolves. Prevents overlapping
//     scans if a window runs long (the SDK's `manager.scan` honors a
//     timeout but a slow host can still drift).
//   * A tick that finds any slot currently connected is a no-op (no scan
//     issued, `seenDeviceIds` left intact) — BLE conflict avoidance with
//     `@stoprocent/noble`'s write mutex (see SDK 0.10.1 release notes).
//     The next tick re-checks; once the device disconnects, scanning
//     resumes naturally.
//   * `start`/`stop` are idempotent: a `start` while already running
//     cancels the pending handle and reschedules; `stop` clears the
//     pending handle (any scan already in-flight runs to completion but
//     its result is dropped).
//   * Each `start` opens a new scan-chain epoch (`state.generation`). A
//     tick whose scan was in-flight across a stop→start (or reconfigure)
//     sees a stale generation on resolve and bows out without
//     rescheduling — otherwise it would orphan the new chain's timer and
//     run two concurrent tick loops (double scan rate).
//
// State ownership:
//   * `PassiveScanState` lives on `ServerState` (one instance per server,
//     not per slot — the scanner is global).
//   * `seenDeviceIds` is the diff baseline. Newly-seen = currentScan
//     ids minus `seenDeviceIds`. After each non-empty scan, `seenDeviceIds`
//     is overwritten with the current set so a device that drops and
//     reappears re-fires the event.
//
// What this module does NOT do:
//   * Emit `voltras_unavailable` events. The spec calls them debatable;
//     the high-signal event is "a device just appeared." Re-firing
//     on reconnect covers the drop-then-back case adequately.
//   * Auto-connect. The agent is in the loop — the event surfaces the
//     fact-of-availability and the agent decides whether to call
//     `device.connect`.

import type { VoltraManager } from '@voltras/node-sdk';

/** Default cadence when `device.set_passive_scan {enabled: true}` is
 * called without an explicit `intervalSeconds`. 30s is responsive enough
 * to feel snappy when the user just powered on the Voltras while keeping
 * the host duty cycle low. */
export const PASSIVE_SCAN_DEFAULT_INTERVAL_MS = 30_000;

/** Minimum cadence — guards against pathological caller input that would
 * starve the BLE host of idle time. */
export const PASSIVE_SCAN_MIN_INTERVAL_MS = 5_000;

/** Maximum cadence — beyond this, callers should disable + manually
 * re-enable rather than parking the scanner at a near-dead interval. */
export const PASSIVE_SCAN_MAX_INTERVAL_MS = 600_000;

/** Per-scan timeout. Each scan window is ~3-5s on the SDK's noble
 * adapter; this is generous without blocking the next tick indefinitely
 * on a stuck adapter. */
export const PASSIVE_SCAN_TIMEOUT_MS = 5_000;

/** Mutable runtime state owned by `ServerState.passiveScan`. */
export interface PassiveScanState {
  enabled: boolean;
  intervalMs: number;
  /** Pending `setTimeout` handle for the next tick. `null` when stopped or
   * between scheduling boundaries. */
  handle: ReturnType<typeof setTimeout> | null;
  /** Device ids observed on the prior tick — used to compute newly-seen.
   * Cleared on `stop` so a fresh `start` doesn't suppress devices that
   * were seen during a previous session. */
  seenDeviceIds: Set<string>;
  /** Monotonic scan-chain epoch. Bumped on every `start` so an in-flight
   * tick from a superseded chain (e.g. a stop→start or reconfigure while
   * a scan was awaiting) can detect it's stale and no-op instead of
   * rescheduling — which would orphan the new chain's timer and run two
   * concurrent tick chains. */
  generation: number;
}

/** Discovered-device shape returned by `manager.scan` (subset). The
 * scanner only needs id + rssi; richer fields like `name` are surfaced
 * elsewhere via the existing `device.scan` tool. */
export interface PassiveScanDevice {
  id: string;
  rssi?: number;
}

/**
 * Collaborators the scanner needs at runtime. Split out as an interface
 * so unit tests can inject a fake scheduler + scan function without
 * spinning up a real `VoltraManager` or relying on `vi.useFakeTimers`.
 */
export interface PassiveScanContext {
  /** Returns true if any slot is currently bound to a connected client.
   * The scanner skips its window when true. */
  isAnyDeviceConnected: () => boolean;
  /** Run a scan and resolve with the discovered devices. The default
   * (production) wiring calls `manager.scan({ timeout: PASSIVE_SCAN_TIMEOUT_MS })`. */
  scan: () => Promise<readonly PassiveScanDevice[]>;
  /** Called with the subset of `devices` whose ids weren't in
   * `seenDeviceIds` at the start of this tick. The host publishes the
   * `voltras_available` channel event from this callback. */
  onNewlySeen: (devices: readonly PassiveScanDevice[]) => void;
  /** Surface for errors the scanner can't recover from inside a tick.
   * Logged-only; the scanner schedules the next tick regardless. */
  onError?: (err: unknown) => void;
  /** Optional scheduler injection (test-only). Defaults to global
   * `setTimeout`/`clearTimeout`. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

/** Build the production scan callback that delegates to the SDK
 * manager. Kept as a tiny factory so tests can substitute a fake scan
 * without re-implementing the manager surface. */
export function makeManagerScan(manager: VoltraManager): PassiveScanContext['scan'] {
  return async () => {
    const devices = await manager.scan({ timeout: PASSIVE_SCAN_TIMEOUT_MS });
    return devices.map((d) => {
      const out: PassiveScanDevice = { id: d.id };
      if (typeof d.rssi === 'number') out.rssi = d.rssi;
      return out;
    });
  };
}

/** Construct the default state (disabled, default interval, empty
 * baseline). Called by `bootstrapState`. */
export function createPassiveScanState(): PassiveScanState {
  return {
    enabled: false,
    intervalMs: PASSIVE_SCAN_DEFAULT_INTERVAL_MS,
    handle: null,
    seenDeviceIds: new Set(),
    generation: 0,
  };
}

/**
 * Clamp a caller-provided interval (in ms) into `[MIN, MAX]`. Tool input
 * already enforces these bounds at the schema layer; this is a defensive
 * second pass for direct callers (tests, programmatic enable).
 */
export function clampInterval(intervalMs: number): number {
  if (intervalMs < PASSIVE_SCAN_MIN_INTERVAL_MS) return PASSIVE_SCAN_MIN_INTERVAL_MS;
  if (intervalMs > PASSIVE_SCAN_MAX_INTERVAL_MS) return PASSIVE_SCAN_MAX_INTERVAL_MS;
  return intervalMs;
}

/**
 * Enable (or re-configure) the passive scanner. Idempotent — calling
 * while already running cancels the pending handle and reschedules.
 * Runs the first tick immediately (no delay) so the caller gets a
 * fast `voltras_available` if devices are already advertising.
 *
 * `intervalMs` defaults to whatever the current state already holds
 * (typically `PASSIVE_SCAN_DEFAULT_INTERVAL_MS` from
 * `createPassiveScanState`). Pass an explicit value to change cadence.
 */
export function startPassiveScan(
  state: PassiveScanState,
  ctx: PassiveScanContext,
  intervalMs?: number,
): void {
  const sched = ctx.scheduler ?? defaultScheduler;
  if (state.handle !== null) {
    sched.clearTimeout(state.handle);
    state.handle = null;
  }
  if (intervalMs !== undefined) {
    state.intervalMs = clampInterval(intervalMs);
  }
  state.enabled = true;
  // Open a new scan-chain epoch. Any tick still awaiting a scan from the
  // prior chain will see a mismatched generation once it resolves and
  // bow out instead of rescheduling over this chain's timer.
  state.generation += 1;
  // First tick fires immediately so an explicit enable doesn't have to
  // wait a full interval for its first event.
  state.handle = sched.setTimeout(() => {
    void runTick(state, ctx);
  }, 0);
}

/**
 * Disable the scanner. Clears any pending handle and resets the
 * newly-seen baseline so a future re-enable starts fresh. An in-flight
 * scan (one whose `scan()` promise has not yet resolved) runs to
 * completion but its result is dropped — `runTick` re-checks
 * `state.enabled` after the await.
 */
export function stopPassiveScan(
  state: PassiveScanState,
  ctx: Pick<PassiveScanContext, 'scheduler'> = {},
): void {
  const sched = ctx.scheduler ?? defaultScheduler;
  if (state.handle !== null) {
    sched.clearTimeout(state.handle);
    state.handle = null;
  }
  state.enabled = false;
  state.seenDeviceIds.clear();
}

/**
 * One scan iteration. Exported for direct invocation from tests that
 * want to drive the tick manually (without relying on real timers).
 */
export async function runTick(state: PassiveScanState, ctx: PassiveScanContext): Promise<void> {
  if (!state.enabled) return;
  // Epoch this tick belongs to. If `start` bumps the generation while our
  // scan is in-flight, this tick is stale and must not reschedule.
  const generation = state.generation;

  // BLE conflict avoidance: skip the scan if anything is currently
  // connected. Don't clear `seenDeviceIds` here — the device set as we
  // know it is still valid; we just can't probe.
  if (ctx.isAnyDeviceConnected()) {
    scheduleNext(state, ctx);
    return;
  }

  const devices = await ctx.scan().catch((err: unknown): null => {
    ctx.onError?.(err);
    return null;
  });

  // Bow out if this chain was superseded while the scan was in-flight:
  // a `stop` (enabled=false) or a stop→start / reconfigure (generation
  // bumped). Either way, rescheduling here would fire stale events and/or
  // orphan the new chain's timer, spawning a second concurrent tick loop.
  if (!state.enabled || generation !== state.generation) return;

  if (devices === null) {
    scheduleNext(state, ctx);
    return;
  }

  const newlySeen = devices.filter((d) => !state.seenDeviceIds.has(d.id));
  if (newlySeen.length > 0) {
    try {
      ctx.onNewlySeen(newlySeen);
    } catch (err) {
      // Callback errors must not break the tick loop.
      ctx.onError?.(err);
    }
  }

  // Overwrite the baseline with the full current set so a device that
  // drops and reappears re-fires the event next time it shows up.
  state.seenDeviceIds = new Set(devices.map((d) => d.id));

  scheduleNext(state, ctx);
}

function scheduleNext(state: PassiveScanState, ctx: PassiveScanContext): void {
  if (!state.enabled) return;
  const sched = ctx.scheduler ?? defaultScheduler;
  state.handle = sched.setTimeout(() => {
    void runTick(state, ctx);
  }, state.intervalMs);
}

const defaultScheduler: NonNullable<PassiveScanContext['scheduler']> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};
