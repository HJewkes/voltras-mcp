// Per-slot ledger of recently-fired setters awaiting a device-side echo.
//
// Owns the F2/F3 `setting_coerced` channel-event correlation: when a tool-
// layer setter resolves (`device.set_*` / `device.start_guided_load` /
// `bilateral.cascade`), the slot's `CoercionWatch.register` stashes a
// `PendingCoercionCheck` carrying the user-requested device-unit value plus
// the wall-clock timestamp. The bridge's `onStateDump` / `onSettingsUpdate`
// handlers walk the reported fields and call `observe(field, deviceValue,
// now)`; a coerced device value that holds steady across two consecutive
// observations within the per-check `windowMs` returns the check (caller
// publishes the channel event) and clears it. Exact-value echoes are no-ops
// (silent success) for `mode: 'exact'` checks; `mode: 'guard'` checks treat
// echoes-at-the-requested-baseline as "no change yet" and wait for either a
// real coercion or window-expiry. Window-expired checks are swept on every
// observe pass so the map can't grow without bound.
//
// Why a stability counter and not single-shot: hardware capture 2026-05-11
// showed firmware-emitted state-dump bursts during cascade settling can pass
// through an intermediate value (e.g. ecc 80 → 320 → 0) before reaching the
// final state. Firing on the first non-matching observation false-positives
// on these transients. Requiring TWO consecutive observations of the same
// coerced value before firing defuses transient bursts while still catching
// genuine post-settle coercions (which produce many subsequent state-dumps
// at the coerced value).
//
// Memory rule `feedback_no_force_stop_set_close.md`: emitting the
// `setting_coerced` event is the ONLY action this module enables. There is
// no corrective behavior — no setter retry, no disconnect, no auto-recover.

/**
 * Default coercion window for plain single-field setters. Sized off observed
 * state-dump latency band (100-500ms after a setter write) plus a safety
 * margin. Setters whose firmware-side settle takes longer (notably
 * `device.start_guided_load`'s internal safety ramp) pass an override via
 * `trackedSetterCall`'s `opts.windowMs`.
 */
export const COERCION_WINDOW_MS = 2500;

/**
 * Extended coercion window for `device.start_guided_load`. The firmware
 * runs an internal safety-ramp sequence (chains + ecc coerced to safe
 * minimums when the target weight is dropped) that empirically settles
 * 8-12s after the trigger write — hardware capture 2026-05-11 saw the
 * coerced state-dump arrive ~10s post-tool-return. The 2500ms default
 * would expire the check before observe could match, so guided-load uses
 * this longer window.
 */
export const COERCION_WINDOW_MS_GUIDED_LOAD = 15000;

/**
 * Number of consecutive observations of the SAME coerced device value
 * required before `observe` returns the pending check (publishing the
 * channel event). Tunes false-positive rate vs. responsiveness — 2 is the
 * minimum that filters mid-cascade transient state-dumps without missing
 * genuine post-settle coercions (which produce many repeating state-dumps
 * at the same coerced value).
 */
export const COERCION_STABILITY_THRESHOLD = 2;

/**
 * How `observe` interprets an exact-value echo of `requested`:
 *   - `'exact'`: the setter's `requested` IS the user's new explicit value
 *     (`set_eccentric(0)` → requested=0). An echo at 0 is a legitimate
 *     success; clear the check so a later (coerced) state-dump can't
 *     accidentally fire.
 *   - `'guard'`: the setter's `requested` is a BASELINE the user expects
 *     to persist across the call (`start_guided_load` reads pre-call
 *     `chainTargetForceTenths` and registers it as `requested` — meaning
 *     "firmware should leave this alone"). An echo at the baseline is "no
 *     change yet" — keep the check alive within the window so a later
 *     coerced state-dump can match.
 */
export type CoercionMode = 'exact' | 'guard';

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
  /** Per-check window. Defaults to `COERCION_WINDOW_MS` at registration. */
  windowMs: number;
  /** Echo interpretation. Defaults to `'exact'` at registration. */
  mode: CoercionMode;
  /**
   * Internal stability tracking. Set by `observe` to the device value
   * observed on the prior non-matching pass; reset when a different value
   * arrives. Not part of the public registration API — callers pass field
   * + requested + (optional) mode/windowMs and let `register` initialize.
   */
  observedDeviceValue?: number;
  observedCount: number;
}

/**
 * Caller-supplied registration shape. `windowMs` and `mode` are optional;
 * `observedDeviceValue` / `observedCount` are internal stability state and
 * must NOT be supplied by callers (they're initialized by `register`).
 */
export interface PendingCoercionRegister {
  setterName: string;
  field: string;
  requested: number;
  setterReturnedAt: number;
  windowMs?: number;
  mode?: CoercionMode;
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
   * to device units. `windowMs` defaults to `COERCION_WINDOW_MS`; `mode`
   * defaults to `'exact'`.
   */
  register(spec: PendingCoercionRegister): void {
    this.pending.set(spec.field, {
      setterName: spec.setterName,
      field: spec.field,
      requested: spec.requested,
      setterReturnedAt: spec.setterReturnedAt,
      windowMs: spec.windowMs ?? COERCION_WINDOW_MS,
      mode: spec.mode ?? 'exact',
      observedCount: 0,
    });
  }

  /**
   * Compare a device-reported `deviceValue` for `field` against the pending
   * check. Returns the matched check (caller publishes `setting_coerced`)
   * and clears it from the ledger when:
   *   - a pending check for `field` exists,
   *   - `now - check.setterReturnedAt < check.windowMs`,
   *   - `deviceValue !== check.requested`,
   *   - this is the SECOND consecutive observation of the same
   *     `deviceValue` (the stability check that defuses mid-cascade
   *     transient state-dumps).
   *
   * Returns `null` otherwise. Always sweeps expired checks first so a stale
   * entry on a different field cannot leak through subsequent observes.
   *
   * For `mode: 'exact'`, an echo at `deviceValue === check.requested`
   * clears the check (legitimate success). For `mode: 'guard'`, the echo
   * is "no change yet" and the check is held until a genuine coercion is
   * observed or the window expires.
   */
  observe(field: string, deviceValue: number, now: number): PendingCoercionCheck | null {
    this.sweep(now);
    const check = this.pending.get(field);
    if (check === undefined) {
      return null;
    }
    if (deviceValue === check.requested) {
      if (check.mode === 'exact') {
        // Legitimate success echo — clear so a later (coerced) state-dump
        // in a different burst doesn't accidentally fire.
        this.pending.delete(field);
        return null;
      }
      // `'guard'`: leave the check pending; this echo means "device hasn't
      // touched the baseline yet". A later coerced value can still match.
      // Reset any in-flight stability streak — a matching echo invalidates
      // the prior non-matching observation as a transient.
      delete check.observedDeviceValue;
      check.observedCount = 0;
      return null;
    }
    // deviceValue !== requested — track stability before firing.
    if (check.observedDeviceValue !== deviceValue) {
      check.observedDeviceValue = deviceValue;
      check.observedCount = 1;
      return null;
    }
    check.observedCount += 1;
    if (check.observedCount < COERCION_STABILITY_THRESHOLD) {
      return null;
    }
    this.pending.delete(field);
    return check;
  }

  /**
   * Drop checks whose age exceeds their `windowMs`. Idempotent + cheap
   * — the bridge calls this once per `onStateDump` / `onSettingsUpdate`
   * fire so the map stays bounded by the number of in-flight setters
   * (typically 0-3).
   */
  sweep(now: number): void {
    for (const [field, check] of this.pending) {
      if (now - check.setterReturnedAt >= check.windowMs) {
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
 * stash. `mode` defaults to `'exact'`; pass `'guard'` for fields whose
 * `requested` is a pre-call baseline (e.g. `start_guided_load`'s chains +
 * ecc, where the user's prior config is what we expect the firmware to
 * preserve).
 */
export interface TrackedFieldSpec {
  field: string;
  requested: number;
  mode?: CoercionMode;
}

/**
 * Optional knobs for `trackedSetterCall`. `windowMs` overrides the default
 * coercion window for every field registered by this call — used by
 * `start_guided_load` to pass `COERCION_WINDOW_MS_GUIDED_LOAD`. Per-field
 * `mode` lives on `TrackedFieldSpec` (some setters mix `'exact'` and
 * `'guard'` fields).
 */
export interface TrackedSetterOptions {
  windowMs?: number;
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
  opts: TrackedSetterOptions = {},
): Promise<T> {
  const result = await fn();
  if (watch === undefined) {
    return result;
  }
  const setterReturnedAt = Date.now();
  for (const spec of fields) {
    const reg: PendingCoercionRegister = {
      setterName,
      field: spec.field,
      requested: spec.requested,
      setterReturnedAt,
    };
    if (opts.windowMs !== undefined) {
      reg.windowMs = opts.windowMs;
    }
    if (spec.mode !== undefined) {
      reg.mode = spec.mode;
    }
    watch.register(reg);
  }
  return result;
}
