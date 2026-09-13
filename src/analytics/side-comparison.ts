// Shared metric choice for per-side (left vs right) comparisons (VW-304).
//
// Bishop et al. 2021 (Journal of Strength and Conditioning Research 35(2S))
// tested unilateral isometric squats and found peak force the only metric to
// reach good bilateral reliability (CV 5.44-5.70%, ICC 0.93-0.94) — the
// velocity-derived metrics they compared it against did not. Until this
// server's own data confirms similar reliability for its velocity-derived
// metrics, a per-side comparison should default to peak force whenever both
// sides recorded it, and say so rather than silently comparing whatever was
// available.

export type SideComparisonMetric = 'peak_force' | 'mean_velocity' | 'top_weight';

/** Which metrics both sides recorded for the window being compared. */
export interface SideComparisonAvailability {
  peakForce: boolean;
  meanVelocity: boolean;
}

export interface SideComparisonChoice {
  metric: SideComparisonMetric;
  /** Why this metric was chosen over the alternatives, for this comparison. */
  reason: string;
  reliabilityBasis: string;
}

export const PEAK_FORCE_RELIABILITY_BASIS =
  'Bishop et al. 2021, Journal of Strength and Conditioning Research 35(2S): peak force was ' +
  'the only metric reaching good bilateral reliability (CV 5.44-5.70%, ICC 0.93-0.94) in ' +
  'unilateral isometric squat testing';

/**
 * Preference order: peak force, then mean velocity, then top weight lifted —
 * the fallback when neither of the other two was recorded on both sides.
 */
export function chooseSideComparisonMetric(
  available: SideComparisonAvailability,
): SideComparisonChoice {
  if (available.peakForce) {
    return {
      metric: 'peak_force',
      reason:
        'both sides recorded peak force, the only metric with good bilateral reliability ' +
        `(${PEAK_FORCE_RELIABILITY_BASIS})`,
      reliabilityBasis: PEAK_FORCE_RELIABILITY_BASIS,
    };
  }
  if (available.meanVelocity) {
    return {
      metric: 'mean_velocity',
      reason:
        'peak force is not recorded on both sides; falling back to mean velocity, a metric ' +
        `that did not reach good bilateral reliability in the cited work (${PEAK_FORCE_RELIABILITY_BASIS})`,
      reliabilityBasis: PEAK_FORCE_RELIABILITY_BASIS,
    };
  }
  return {
    metric: 'top_weight',
    reason:
      'neither peak force nor velocity is recorded on both sides; falling back to top weight ' +
      `lifted, a metric the cited reliability study did not evaluate (${PEAK_FORCE_RELIABILITY_BASIS})`,
    reliabilityBasis: PEAK_FORCE_RELIABILITY_BASIS,
  };
}
