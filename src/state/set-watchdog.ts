// Per-set idle-timeout watchdog. Backs the trigger DSL's
// `idle_timeout_ms` spec — a coach can ask the server to fire a channel
// event (`idle_timeout`) and optionally auto-stop the set when no rep has
// finalized for N milliseconds.
//
// Lifecycle (one watchdog per active set, max one timer per set):
//   * `set.start` calls `register(setId, idleMs, onFire)` once if the
//     watch config has at least one `idle_timeout_ms` spec.
//   * Every rep_finalized boundary in the bridge calls `reset(setId,
//     idleMs, onFire)` to bump the deadline forward.
//   * `finalizeSet` (any termination path — explicit set.end, device-
//     signal, auto-stop, disconnect cascade) calls `cancel(setId)` so a
//     stale timer never publishes after the set has closed.
//
// Smallest-wins idle threshold:
//   When a set registers multiple `idle_timeout_ms` specs (across
//   `stopOn` + `notifyOn`), only the smallest threshold ever arms a
//   timer — the later, larger thresholds would never get a chance to
//   fire because the smaller one always wakes the model first. This
//   keeps the watchdog to ONE timer per set and matches the typical
//   coaching pattern (a single "abandonment" threshold, not a layered
//   nudge cascade). The bridge's onFire callback resolves which specific
//   spec to publish for. Per-spec timers would be a larger model;
//   chosen this simpler shape because the user-visible difference is a
//   single channel event either way.

/**
 * Callback the watchdog invokes when its timer expires. Implementation
 * is owned by `set-tools.ts:startSet` — it builds the `idle_timeout`
 * payload, publishes the channel event, and calls `finalizeSet` if any
 * registered idle_timeout spec was on `stopOn`. Errors thrown from this
 * callback are caught and logged at the call site so the watchdog never
 * leaves an unhandled rejection trail.
 */
export type WatchdogFireCallback = () => void;

/**
 * Per-set idle-timer registry. Maps setId → live `setTimeout` handle so
 * `reset` and `cancel` can find the timer without the caller threading
 * the handle. Stateful but tightly scoped — one instance lives on the
 * shared `ServerState`, alongside the `state.timers` push-timer map.
 */
export class SetWatchdog {
  private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Arm a fresh idle timer for `setId`. If a timer is already registered
   * for the same setId, this is a no-op — call `reset` to re-arm. The
   * choice keeps `register` semantically a "first-time arm" so the
   * smallest-wins selection at set.start can't be undone by a stray
   * second register call.
   */
  register(setId: string, idleMs: number, onFire: WatchdogFireCallback): void {
    if (this.handles.has(setId)) {
      return;
    }
    const handle = setTimeout(() => {
      this.handles.delete(setId);
      onFire();
    }, idleMs);
    this.handles.set(setId, handle);
  }

  /**
   * Bump the timer for `setId` forward by `idleMs`. Clears the existing
   * handle and arms a new one. If no timer was registered for this set
   * (the set didn't register any idle_timeout specs), this is a no-op so
   * the bridge's per-rep reset call is safe to invoke unconditionally.
   */
  reset(setId: string, idleMs: number, onFire: WatchdogFireCallback): void {
    const existing = this.handles.get(setId);
    if (existing === undefined) {
      return;
    }
    clearTimeout(existing);
    const handle = setTimeout(() => {
      this.handles.delete(setId);
      onFire();
    }, idleMs);
    this.handles.set(setId, handle);
  }

  /**
   * Cancel and remove the timer for `setId`. Idempotent — calling on a
   * setId with no registered timer is a no-op success, so finalizeSet
   * can call cancel without checking whether the set ever had a
   * watchdog.
   */
  cancel(setId: string): void {
    const existing = this.handles.get(setId);
    if (existing === undefined) {
      return;
    }
    clearTimeout(existing);
    this.handles.delete(setId);
  }

  /**
   * Test-only: clear every registered timer. Production code never needs
   * this (`cancel(setId)` covers the per-set teardown via finalizeSet);
   * tests use it in `afterEach` to drain leftovers between cases.
   */
  clearAll(): void {
    for (const handle of this.handles.values()) {
      clearTimeout(handle);
    }
    this.handles.clear();
  }

  /** Test/diagnostic helper — does this set have an armed watchdog? */
  has(setId: string): boolean {
    return this.handles.has(setId);
  }
}
