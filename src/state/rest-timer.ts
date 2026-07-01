// Passive rest-timer registry (VMCP-02.08).
//
// When a set finalizes (via `set.end`, the bridge's autonomous device-signal
// close, the inactivity watchdog, etc.), the trainer enters a rest period.
// Without this module the PT skill has no way to track elapsed rest time
// without either blocking on `timer.wait` or polling — neither matches the
// trainer flow described in the friction context.
//
// This registry publishes a `rest_status` channel event:
//   * once immediately on set close (elapsed_seconds = 0),
//   * every `REST_STATUS_INTERVAL_MS` thereafter while the rest is in flight,
//   * and a final emit at the hard cap with `final: true` before disposing.
//
// Lifecycle (called from set-tools.ts / event-bridge.ts):
//   * `start(slotId, setId)` — invoked after the `set_ended` publish in
//     `finalizeSet`. If a previous rest is still in flight for the slot, it
//     is cancelled and replaced (the only way that happens in practice is a
//     bug or a torn-down test rig).
//   * `cancel(slotId)` — invoked from `startSet` after the `set_started`
//     publish (next set began → rest is over) and from the disconnect path
//     in event-bridge.ts (slot lost its device mid-rest).
//   * `dispose()` — invoked from `bootstrapState` cleanup paths and slot
//     teardown so no stray `setTimeout` keeps the process alive.
//
// Cadence reasoning: 15s interval / 5min cap = at most 20 emits per rest
// period. Common rest intervals (30s, 60s, 90s, 2min, 3min) all land cleanly
// on a 15s grid, so the trainer always sees a fresh status within 15s of the
// intended rest target. Pure `setTimeout` chain (NOT `setInterval`) so a slow
// publish doesn't compound into drift / overlapping work — same pattern the
// inactivity / idle-rep timers in event-bridge.ts could move to but kept
// `setInterval` because they are cheap polls; the rest timer publishes which
// is the work we want to serialize.

import type { ChannelPublisher } from './channel-publisher.js';
import { buildRestStatusPayload } from './channel-payloads.js';
import { log } from '../logger.js';

/**
 * Interval between successive `rest_status` emits. 15s is short enough that
 * the trainer sees the elapsed counter tick over before they queue the next
 * set, and long enough that a typical 60-90s rest only publishes 4-6 events
 * (well below the channel-noise threshold the `idle_rep_summary` batching
 * was designed to dodge).
 */
export const REST_STATUS_INTERVAL_MS = 15_000;

/**
 * Hard cap on rest-timer duration. After 5 minutes a rest is effectively
 * abandoned for our purposes — most workouts have a session timeout long
 * before this kicks in, and the PT skill should treat anything past 5 min
 * as "user walked away" anyway. The final emit at the cap carries
 * `final: true` so the skill can distinguish a cap timeout from an
 * in-progress rest.
 */
export const REST_STATUS_CAP_MS = 300_000;

/**
 * Test seam: scheduler abstraction matching `setTimeout`'s shape but
 * returning a cancel handle. Production wiring uses `defaultScheduler`
 * (real Node timers); tests pass a fake that drives time manually so
 * we don't need `vi.useFakeTimers` boilerplate per test file.
 */
export type Scheduler = (callback: () => void, delayMs: number) => () => void;

/**
 * Default scheduler wrapping Node's `setTimeout`. The returned cancel
 * function calls `clearTimeout` to detach the pending handle.
 */
export const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Reasons a rest timer can be cancelled. Surfaced only in debug logs today
 * — the payload itself doesn't expose this. Distinct values keep the call
 * sites self-documenting (set-tools cancels with `'next_set'`, event-bridge
 * with `'disconnect'`, etc.).
 */
export type RestTimerCancelReason =
  | 'next_set'
  | 'disconnect'
  | 'dispose'
  | 'replaced'
  | 'cap_reached';

interface RestTimerEntry {
  slotId: string;
  setId: string;
  startedAtMs: number;
  channels: ChannelPublisher;
  cancelPending: () => void;
}

/**
 * Per-slot rest-timer registry. One entry per active rest period; starting
 * a new rest for a slot that already has one cancels the previous (this is
 * a defensive belt-and-braces — in normal flow the previous set's rest is
 * cancelled when the next `set_started` fires, so the new `set_ended`
 * registration always finds the slot empty).
 */
export class RestTimerRegistry {
  private readonly entries = new Map<string, RestTimerEntry>();
  private readonly scheduler: Scheduler;
  private readonly intervalMs: number;
  private readonly capMs: number;
  private readonly nowMs: () => number;

  constructor(
    opts: {
      scheduler?: Scheduler;
      intervalMs?: number;
      capMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.intervalMs = opts.intervalMs ?? REST_STATUS_INTERVAL_MS;
    this.capMs = opts.capMs ?? REST_STATUS_CAP_MS;
    this.nowMs = opts.now ?? (() => Date.now());
  }

  /**
   * Begin a rest-status emission cycle for `slotId`. Publishes the initial
   * `rest_status` (elapsed=0) synchronously, then schedules subsequent
   * emits at `intervalMs` intervals up to `capMs`. `channels` should be
   * the slot-scoped publisher (the caller passes
   * `state.channels.forSlot(slotId)`) so every emit carries `meta.slot`.
   *
   * `setId` is the id of the set that JUST ended — the model uses it to
   * attribute the rest to a specific set in the session history.
   */
  start(slotId: string, setId: string, channels: ChannelPublisher): void {
    // Defensive replace: cancel any in-flight rest for this slot before
    // starting a new one. In normal flow this branch is unreachable (the
    // next set_started cancelled the prior rest), but a finalize-after-
    // finalize race (rare; partial-close paths) would otherwise leak a
    // pending setTimeout.
    this.cancel(slotId, 'replaced');

    const startedAtMs = this.nowMs();
    const entry: RestTimerEntry = {
      slotId,
      setId,
      startedAtMs,
      channels,
      cancelPending: () => undefined,
    };
    this.entries.set(slotId, entry);

    // Initial emit at t=0 so the skill sees the rest begin even if it
    // misses the surrounding `set_ended`. Publish BEFORE scheduling the
    // next tick so a same-tick cancel doesn't drop the t=0 status.
    this.publish(entry, /*final*/ false);

    this.scheduleNext(entry);
  }

  /**
   * Cancel the rest-timer for `slotId`. No-op when no rest is active for
   * the slot — callers don't need to track whether a timer is live, just
   * `cancel()` on whichever lifecycle event ends rest (next set, disconnect,
   * dispose).
   */
  cancel(slotId: string, _reason: RestTimerCancelReason = 'next_set'): void {
    const entry = this.entries.get(slotId);
    if (entry === undefined) {
      return;
    }
    entry.cancelPending();
    this.entries.delete(slotId);
  }

  /**
   * Tear down every in-flight rest timer. Called from slot/bootstrap
   * teardown so a process exit doesn't leave a pending setTimeout dangling.
   */
  dispose(): void {
    for (const slotId of Array.from(this.entries.keys())) {
      this.cancel(slotId, 'dispose');
    }
  }

  /**
   * True if a rest timer is currently active for `slotId`. Exposed for
   * unit tests; production callers should not branch on this.
   */
  has(slotId: string): boolean {
    return this.entries.has(slotId);
  }

  private scheduleNext(entry: RestTimerEntry): void {
    const elapsedMs = this.nowMs() - entry.startedAtMs;
    const nextElapsedMs = elapsedMs + this.intervalMs;

    // Past-cap guard: if the next tick would land at or beyond the cap,
    // schedule a single final emit AT the cap and dispose. This way the
    // last `rest_status` always carries elapsed_seconds = capMs/1000
    // (a stable, predictable terminal value) rather than whatever the
    // interval boundary happens to land at.
    if (nextElapsedMs >= this.capMs) {
      const delayMs = Math.max(0, this.capMs - elapsedMs);
      const cancel = this.scheduler(() => this.fireFinal(entry), delayMs);
      entry.cancelPending = cancel;
      return;
    }

    const cancel = this.scheduler(() => this.fireTick(entry), this.intervalMs);
    entry.cancelPending = cancel;
  }

  private fireTick(entry: RestTimerEntry): void {
    // Re-check membership: the cancel path clears the map BEFORE the
    // scheduler fires (`clearTimeout`), but a test-side fake scheduler
    // that fires queued callbacks synchronously could land here after a
    // cancel ran in the same drain. Bail silently rather than publish a
    // stale status.
    if (this.entries.get(entry.slotId) !== entry) {
      return;
    }
    // A throwing publisher must NOT break the rest cadence: swallow and
    // log the publish error, then still schedule the next tick so the
    // elapsed counter keeps advancing to the terminal cap emit. Mirrors
    // the tick-loop resilience in passive-scanner.ts / set-watchdog.ts.
    try {
      this.publish(entry, /*final*/ false);
    } catch (err) {
      log.error('rest-timer tick publish failed', err);
    }
    this.scheduleNext(entry);
  }

  private fireFinal(entry: RestTimerEntry): void {
    if (this.entries.get(entry.slotId) !== entry) {
      return;
    }
    // Terminal emit: even if the final publish throws, the map entry MUST
    // be removed so a failed publisher never leaks a live rest into the
    // registry (`has()` would otherwise stay true forever).
    try {
      this.publish(entry, /*final*/ true);
    } catch (err) {
      log.error('rest-timer final publish failed', err);
    } finally {
      this.entries.delete(entry.slotId);
    }
  }

  private publish(entry: RestTimerEntry, final: boolean): void {
    const elapsedMs = this.nowMs() - entry.startedAtMs;
    const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000));
    const payload = buildRestStatusPayload({
      slotId: entry.slotId,
      setId: entry.setId,
      elapsedSeconds,
      capSeconds: Math.round(this.capMs / 1000),
      final,
    });
    entry.channels.publish(payload);
  }
}
