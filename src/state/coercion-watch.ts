// Per-slot ledger of recently-fired setters awaiting a device-side echo.
//
// Owns the F2/F3 `setting_coerced` channel-event correlation: when a tool-
// layer setter resolves (`device.set_*` / `device.start_guided_load` /
// `bilateral.cascade`), the slot's `CoercionWatch.register` stashes a
// `PendingCoercionCheck` carrying the user-requested device-unit value plus
// the wall-clock timestamp. The bridge's `onStateDump` / `onSettingsUpdate`
// handlers walk the reported fields and call `observe(field, deviceValue,
// now)`; the first match within `COERCION_WINDOW_MS` whose `deviceValue !==
// requested` returns the check (caller publishes the channel event) and
// clears it. Exact-value echoes are no-ops (silent success). Window-expired
// checks are swept on every observe pass so the map can't grow without bound.
//
// Why a ledger and not a single-shot Promise: a setter rarely produces just
// one state-dump frame — the firmware sometimes bursts 2-3 cmd=0x07 frames
// in <200ms after a write. The ledger removes the check on the first
// matching observation, so subsequent frames in the same burst are silently
// dropped. Combined with sweep-on-observe, we never need a separate
// scheduled timer.
//
// Memory rule `feedback_no_force_stop_set_close.md`: emitting the
// `setting_coerced` event is the ONLY action this module enables. There is
// no corrective behavior — no setter retry, no disconnect, no auto-recover.

/**
 * How long a pending setter check is eligible to match a device echo. After
 * this many ms the check is silently swept and no event fires (treated as
 * "device did not acknowledge in time" — an out-of-scope V1 signal). 2500
 * ms was sized off the observed state-dump latency band (100-500ms for plain
 * setters, 1-2s for guided-load's internal settle sequence) plus a safety
 * margin.
 */
export const COERCION_WINDOW_MS = 2500;

/**
 * One outstanding setter awaiting a device echo. `requested` is in DEVICE
 * UNITS (tenths-of-percent for ecc, tenths-of-lbs for weight/chains, the
 * raw enum byte for assistMode/damperLevel). The tool-layer helper
 * (`trackedSetterCall`) is responsible for converting user units (percent,
 * lbs) into device units BEFORE registering — so `observe` can compare like-
 * for-like without re-applying the conversion on the read path.
 */
export interface PendingCoercionCheck {
  setterName: string;
  field: string;
  requested: number;
  setterReturnedAt: number;
}

/**
 * Per-slot pending-coercion ledger. One outstanding check per `field` at
 * any time — a fresh `register` for the same field evicts the prior pending
 * check. Newest setter wins (the most recent user intent is the
 * authoritative requested value).
 */
export class CoercionWatch {
  private readonly pending = new Map<string, PendingCoercionCheck>();

  /**
   * Stash a pending check for the given `field`. Evicts any prior pending
   * check on the same field. The caller has already converted `requested`
   * to device units.
   */
  register(check: PendingCoercionCheck): void {
    this.pending.set(check.field, check);
  }

  /**
   * Compare a device-reported `deviceValue` for `field` against the pending
   * check. Returns the matched check (caller publishes `setting_coerced`)
   * and clears it from the ledger when:
   *   - a pending check for `field` exists,
   *   - `now - check.setterReturnedAt < COERCION_WINDOW_MS`,
   *   - `deviceValue !== check.requested`.
   *
   * Returns `null` otherwise. Always sweeps expired checks first so a stale
   * entry on a different field cannot leak through subsequent observes.
   */
  observe(field: string, deviceValue: number, now: number): PendingCoercionCheck | null {
    this.sweep(now);
    const check = this.pending.get(field);
    if (check === undefined) {
      return null;
    }
    if (deviceValue === check.requested) {
      // Exact echo — setter succeeded at the requested value. Clear the
      // check so a subsequent (coerced) state-dump in a different burst
      // doesn't accidentally fire after a legitimate success.
      this.pending.delete(field);
      return null;
    }
    this.pending.delete(field);
    return check;
  }

  /**
   * Drop checks whose age exceeds `COERCION_WINDOW_MS`. Idempotent + cheap
   * — the bridge calls this once per `onStateDump` / `onSettingsUpdate`
   * fire so the map stays bounded by the number of in-flight setters
   * (typically 0-3).
   */
  sweep(now: number): void {
    for (const [field, check] of this.pending) {
      if (now - check.setterReturnedAt >= COERCION_WINDOW_MS) {
        this.pending.delete(field);
      }
    }
  }

  /**
   * Clear every pending check. Called by slot teardown / reset paths so a
   * stale registration from the prior connection can't fire against a
   * fresh state-dump on the new connection.
   */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Test-only: number of currently-pending checks. Lets unit tests assert
   * register / observe / sweep mutate the map as documented without
   * exposing the underlying storage.
   */
  size(): number {
    return this.pending.size;
  }
}

/**
 * Helper signature for tracked-setter registration. One spec per device
 * field a setter touches. The tool layer maps user-unit input → device-unit
 * `requested` BEFORE constructing the spec so `register` stays a pure
 * stash.
 */
export interface TrackedFieldSpec {
  field: string;
  requested: number;
}

/**
 * Wrap an SDK setter call, register one or more pending coercion checks
 * against the slot's watch, and return the SDK call's resolved value. The
 * helper does not catch or re-throw — if `fn()` rejects, no check is
 * registered (the device never received the write) and the rejection
 * propagates. On success, one check per `fields` entry is registered, all
 * sharing the same `setterName` and `setterReturnedAt`.
 *
 * Used by `device-tools.ts` setter handlers + `bilateral-cascade.ts` so
 * every user-driven setter resolution feeds the F2/F3 channel event.
 *
 * `watch === undefined` (e.g., a slot that pre-dates this feature) is a
 * silent passthrough so the helper is safe to call unconditionally during
 * the rollout.
 */
export async function trackedSetterCall<T>(
  watch: CoercionWatch | undefined,
  setterName: string,
  fields: readonly TrackedFieldSpec[],
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();
  if (watch === undefined) {
    return result;
  }
  const setterReturnedAt = Date.now();
  for (const spec of fields) {
    watch.register({
      setterName,
      field: spec.field,
      requested: spec.requested,
      setterReturnedAt,
    });
  }
  return result;
}
