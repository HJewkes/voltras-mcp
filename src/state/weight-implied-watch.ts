// VMCP-02.68 — force-implied-weight validator.
//
// A plateau set's median concentric peak force (in pounds) slightly exceeds
// the header (logged) weight: dynamic concentric peak overshoots the static
// load by a small, roughly constant fraction, so weight ≈ peakForce /
// PEAK_OVERSHOOT_FACTOR. Inverting that lets us compute the weight the reps
// were PHYSICALLY performed at from telemetry alone, and flag when it
// disagrees with the stored header weight — the signature of a stale /
// mis-recorded header (VMCP-02.57: two "30 lb" sets were actually lifted at 50).
//
// This module is pure (no device, no channel, no protocol). The finalize
// path (`finalizeSet` in `src/tools/set-tools.ts`) feeds it the persisted
// rep array + header weight and publishes a `weight_implied_mismatch`
// channel event when `evaluateWeightImplied` returns a flagged result.

import type { Rep } from '@voltras/workout-analytics';

/**
 * Overshoot of a plateau set's median concentric peak force (in POUNDS, after
 * the bridge's tenths→lb conversion) over the header weight in pounds:
 *   peakForce ≈ PEAK_OVERSHOOT_FACTOR × lbs.
 *
 * De-conflation note: the old `FORCE_PER_LB = 10.17` bundled two effects — a
 * ×10 unit conversion (tenths→lb) and this residual ~1.7% overshoot. The ×10
 * now lives at the single bridge conversion point (`FRAME_FORCE_TENTHS_PER_LB`),
 * so only the overshoot residual belongs here. Bench 2026-07-05 (single cable
 * session, upper-body bilateral) measured plateau median concentric peak force
 * landing ~1.017× the header weight in pounds.
 *
 * CALIBRATION CAVEAT: this residual rests on one session and is almost
 * certainly per-device / per-movement / per-cable-geometry (attachment, pulley
 * ratio, line angle). It needs proper empirical calibration via a controlled
 * isometric hold (separate ticket) before it is trusted on a different machine,
 * attachment, or exercise. The mismatch flag stays advisory only — it never
 * coerces or rewrites the stored weight.
 */
export const PEAK_OVERSHOOT_FACTOR = 1.017;

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
  /** `medianConcentricPeakForce / PEAK_OVERSHOOT_FACTOR`. */
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
  const impliedWeightLbs = median / PEAK_OVERSHOOT_FACTOR;
  const ratio = Math.abs(impliedWeightLbs - headerWeightLbs) / headerWeightLbs;
  return {
    flagged: ratio > WEIGHT_IMPLIED_MISMATCH_RATIO,
    medianConcentricPeakForce: median,
    impliedWeightLbs,
    ratio,
  };
}
