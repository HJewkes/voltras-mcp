// Per-slot ledger of recently-fired setters awaiting a device-side echo.
//
// Owns the F2/F3 `setting_coerced` channel-event correlation: when a tool-
// layer setter resolves (`device.set_*` / `device.start_guided_load` /
// `bilateral.cascade`), the slot's `CoercionWatch.register` stashes a
// `PendingCoercionCheck` carrying the user-requested device-unit value plus
// the wall-clock timestamp. The bridge's `onStateDump` / `onSettingsUpdate`
// handlers walk the reported fields and call `observe(field, deviceValue,
// now)`; once the stability threshold for that field is satisfied the check
// fires (caller publishes the channel event) and clears. Exact-value echoes
// are no-ops (silent success) for `mode: 'exact'` checks; `mode: 'guard'`
// checks treat echoes-at-the-requested-baseline as "no change yet" and wait
// for either a real coercion or window-expiry. Window-expired checks are
// swept on every observe pass so the map can't grow without bound.
//
// Stability threshold is PER FIELD (see `STABILITY_BY_FIELD`):
//
//   * `eccentricPercentTenths` requires TWO consecutive observations of the
//     same coerced value. Hardware capture 2026-05-11 showed cascade-settle
//     bursts pass through transient values (e.g. ecc 80 → 320 → 0) before
//     reaching the final state; firing on the first non-matching observation
//     false-positives on the 320 transient. The 2-of-2 check defuses this.
//
//   * `chainTargetForceTenths`, `weightLbsTenths`, `assistMode`,
//     `damperLevel` fire on the FIRST non-matching observation. No
//     transient-burst pattern is documented for these fields — and the
//     2-of-2 default actively prevents firing in cases like bilateral
//     chains coercion (VMCP-01.38, hardware repro 2026-05-12), where the
//     slow-settling slot oscillates between distinct non-matching values
//     (e.g. 300 ↔ 200) during settle. The 2-of-2 counter never reaches
//     stability inside the 2500ms window and the slot's setting_coerced
//     channel event is silently dropped. Firing on the first non-matching
//     observation reports the coercion fact correctly at the cost of
//     possibly carrying a mid-oscillation value instead of the post-settle
//     value (the F2/F3 event surface treats the value as advisory — the
//     fact-of-coercion is the load-bearing payload).
//
//   * Unknown / unmapped fields fall back to the conservative 2-of-2
//     default so a newly tracked field is never a silent false-positive
//     risk until it has been classified.
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
 * Default stability threshold for fields without a `STABILITY_BY_FIELD`
 * entry. Used as the fallback in `stabilityFor` so newly-tracked fields
 * are conservative until classified. See the file header for the
 * per-field rationale.
 */
export const COERCION_STABILITY_THRESHOLD = 2;

/**
 * Per-field override for the stability threshold consumed by
 * `observe()`. A value of 1 means "fire on the first non-matching
 * observation" — used for fields with no documented transient-burst
 * pattern (chains, weight, assist, damper) where the conservative 2-of-2
 * default actively prevents firing in noisy-settle cases like the
 * bilateral chains oscillation captured in VMCP-01.38. Fields with known
 * transients (`eccentricPercentTenths`) keep the 2-of-2 default so the
 * 80→320→0 cascade-settle burst doesn't false-positive at 320.
 *
 * Unmapped fields fall through to `COERCION_STABILITY_THRESHOLD` (2) via
 * `stabilityFor`.
 */
export const STABILITY_BY_FIELD: Readonly<Record<string, number>> = Object.freeze({
  eccentricPercentTenths: 2,
  chainTargetForceTenths: 1,
  weightLbsTenths: 1,
  assistMode: 1,
  damperLevel: 1,
});

/**
 * Resolve the stability threshold for `field`, falling back to the
 * conservative default for any field not in `STABILITY_BY_FIELD`.
 */
export function stabilityFor(field: string): number {
  return STABILITY_BY_FIELD[field] ?? COERCION_STABILITY_THRESHOLD;
}

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
 * Per-slot pending-coercion ledger keyed by `(setterName, field)`. One
 * outstanding check per `(setterName, field)` pair at any time — a fresh
 * `register` for the same pair evicts the prior pending check. Distinct
 * setters touching the SAME field (e.g., `device.set_chains` and
 * `bilateral.cascade` both writing `chainTargetForceTenths` within the
 * window) keep independent checks, so each can fire its own
 * `setting_coerced` event without one eviction silencing the other.
 *
 * The composite key was introduced to fix VMCP-01.38's cross-setter
 * eviction case (a back-to-back register from a different setter
 * overwriting an in-flight check). The bilateral-asymmetry case of the
 * same ticket is fixed by the per-field stability threshold in
 * `STABILITY_BY_FIELD` (see file header).
 */
export class CoercionWatch {
  private readonly pending = new Map<string, PendingCoercionCheck>();

  /**
   * Stash a pending check for `(setterName, field)`. Evicts any prior
   * pending check on the same pair. The caller has already converted
   * `requested` to device units. `windowMs` defaults to
   * `COERCION_WINDOW_MS`; `mode` defaults to `'exact'`.
   */
  register(spec: PendingCoercionRegister): void {
    this.pending.set(makeKey(spec.setterName, spec.field), {
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
   * Compare a device-reported `deviceValue` for `field` against EVERY
   * pending check on that field (regardless of which setter registered
   * it). Returns one fired check per setter whose stability streak hit
   * its per-field threshold on this observation — caller publishes one
   * `setting_coerced` event per entry. An empty array means no same-field
   * check fired (either none pending, all still priming their stability
   * counter, or all were echo-cleared).
   *
   * Within a single check, the firing rules are:
   *   - `now - check.setterReturnedAt < check.windowMs`,
   *   - `deviceValue !== check.requested`,
   *   - the stability streak (consecutive observations of the same
   *     `deviceValue`) has reached `stabilityFor(field)` — see
   *     `STABILITY_BY_FIELD`. Threshold=1 fires on the first non-matching
   *     observation; threshold=2 defuses mid-cascade transient bursts.
   *
   * Always sweeps expired checks first so a stale entry on a different
   * field cannot leak through subsequent observes.
   *
   * For `mode: 'exact'`, an echo at `deviceValue === check.requested`
   * clears the check (legitimate success). For `mode: 'guard'`, the echo
   * is "no change yet" and the check is held until a genuine coercion is
   * observed or the window expires.
   */
  observe(field: string, deviceValue: number, now: number): PendingCoercionCheck[] {
    this.sweep(now);
    const fired: PendingCoercionCheck[] = [];
    const threshold = stabilityFor(field);
    for (const [key, check] of this.pending) {
      if (check.field !== field) continue;
      if (deviceValue === check.requested) {
        if (check.mode === 'exact') {
          // Legitimate success echo — clear so a later (coerced) state-
          // dump in a different burst doesn't accidentally fire.
          this.pending.delete(key);
          continue;
        }
        // `'guard'`: leave the check pending; this echo means "device
        // hasn't touched the baseline yet". A later coerced value can
        // still match. Reset any in-flight stability streak — a matching
        // echo invalidates the prior non-matching observation as a
        // transient.
        delete check.observedDeviceValue;
        check.observedCount = 0;
        continue;
      }
      // deviceValue !== requested — track stability before firing.
      if (check.observedDeviceValue !== deviceValue) {
        check.observedDeviceValue = deviceValue;
        check.observedCount = 1;
        if (check.observedCount >= threshold) {
          this.pending.delete(key);
          fired.push(check);
        }
        continue;
      }
      check.observedCount += 1;
      if (check.observedCount < threshold) {
        continue;
      }
      this.pending.delete(key);
      fired.push(check);
    }
    return fired;
  }

  /**
   * Drop checks whose age exceeds their `windowMs`. Idempotent + cheap
   * — the bridge calls this once per `onStateDump` / `onSettingsUpdate`
   * fire so the map stays bounded by the number of in-flight setters
   * (typically 0-3).
   */
  sweep(now: number): void {
    for (const [key, check] of this.pending) {
      if (now - check.setterReturnedAt >= check.windowMs) {
        this.pending.delete(key);
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

function makeKey(setterName: string, field: string): string {
  return `${setterName} ${field}`;
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
