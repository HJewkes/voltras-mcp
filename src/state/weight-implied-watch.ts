// VMCP-02.68 — force-implied-weight validator.
//
// A plateau set's median concentric peak force is very nearly linear in the
// header (logged) weight: force ≈ FORCE_PER_LB × lbs. Inverting that lets us
// compute the weight the reps were PHYSICALLY performed at from telemetry
// alone, and flag when it disagrees with the stored header weight — the
// signature of a stale / mis-recorded header (VMCP-02.57: two "30 lb" sets
// were actually lifted at 50).
//
// This module is pure (no device, no channel, no protocol). The finalize
// path (`finalizeSet` in `src/tools/set-tools.ts`) feeds it the persisted
// rep array + header weight and publishes a `weight_implied_mismatch`
// channel event when `evaluateWeightImplied` returns a flagged result.

import type { Rep } from '@voltras/workout-analytics';

/**
 * Empirical proportionality constant between a plateau set's median
 * concentric peak force (device force units) and the header weight in pounds:
 *   force ≈ FORCE_PER_LB × lbs.
 *
 * CALIBRATION CAVEAT: derived from a SINGLE cable session (bench 2026-07-05,
 * upper-body bilateral). Plateau median concentric peak force measured 503–506
 * at 50 lb, 817 at 80 lb, and 1168 at 115 lb — all landing on ~10.17 × lbs.
 * This ratio is almost certainly per-device / per-movement / per-cable-geometry
 * (attachment, pulley ratio, line angle) and MUST be re-calibrated before it is
 * trusted on a different machine, attachment, or exercise. The mismatch flag is
 * advisory only — it never coerces or rewrites the stored weight.
 */
export const FORCE_PER_LB = 10.17;

/**
 * Relative disagreement (|implied − header| / header) above which the
 * force-implied weight is flagged. 10% comfortably clears the ~1% spread seen
 * on correctly-labeled plateau sets while catching the ~65% gap of a 30→50
 * mislabel.
 */
export const WEIGHT_IMPLIED_MISMATCH_RATIO = 0.1;

export interface WeightImpliedResult {
  /** True when the relative disagreement exceeds `WEIGHT_IMPLIED_MISMATCH_RATIO`. */
  flagged: boolean;
  /** Median of the per-rep concentric peak force across the set. */
  medianConcentricPeakForce: number;
  /** `medianConcentricPeakForce / FORCE_PER_LB`. */
  impliedWeightLbs: number;
  /** `|impliedWeightLbs − headerWeightLbs| / headerWeightLbs`. */
  ratio: number;
}

/**
 * Median of every rep's concentric peak force. The median (not the mean)
 * rejects the one or two low-force ramp reps at the start of a plateau set
 * without any explicit warm-up trimming. Returns `null` when the set has no
 * finite force samples.
 */
export function medianConcentricPeakForce(reps: readonly Rep[]): number | null {
  const forces = reps
    .map((rep) => rep.concentric.peakForce)
    .filter((f): f is number => typeof f === 'number' && Number.isFinite(f));
  if (forces.length === 0) {
    return null;
  }
  const sorted = [...forces].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute the force-implied weight for a set and compare it to the header
 * weight. Returns `null` (no signal, no event) when the header weight is
 * non-positive or the set carries no positive force telemetry — a zero-force
 * median means "no force data", not "the device is lying".
 */
export function evaluateWeightImplied(
  headerWeightLbs: number,
  reps: readonly Rep[],
): WeightImpliedResult | null {
  const median = medianConcentricPeakForce(reps);
  if (median === null || median <= 0 || headerWeightLbs <= 0) {
    return null;
  }
  const impliedWeightLbs = median / FORCE_PER_LB;
  const ratio = Math.abs(impliedWeightLbs - headerWeightLbs) / headerWeightLbs;
  return {
    flagged: ratio > WEIGHT_IMPLIED_MISMATCH_RATIO,
    medianConcentricPeakForce: median,
    impliedWeightLbs,
    ratio,
  };
}
