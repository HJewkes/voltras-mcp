// The two history reads a goal target is derived from (VW-350, plan H2).
//
// PURE. No store, no clock, no tool surface: both functions take plain numbers
// and return plain numbers. `goal.propose_targets` does the reading; this
// module only decides what the read MEANS.
//
// WHY A TOP LOAD AT MATCHED REPS. A start value has to be a like-vs-like
// measurement or the band it seeds is measuring the rep count rather than the
// lifter (rp:rp-s7-like-vs-like-progress-comparison-rule). "Matched" here is
// AT LEAST the anchor reps, not exactly: a set carried for more reps at the
// same load is at least as strong a performance, so excluding it would throw
// away the better evidence. The anchor itself is the low edge of the
// exercise's own rep range, which `goal-metrics.ts` picks.
//
// WHY THE STANDARD ERROR IS DERIVED RATHER THAN FITTED. `history.trend`
// already fits the series and reports a slope, an r-squared and a point count.
// Re-fitting here to get a standard error would mean two fits over one series
// that could disagree; the identity below gets the same number from the fit
// that already ran.

/** One working set, reduced to what a matched-reps read needs. */
export interface RepCountedSet {
  sessionId: string;
  /** ISO instant the set closed at; the newest matching one is the measurement. */
  endedAt: string;
  weightLbs: number;
  repCount: number;
}

/** A start value with the evidence behind it, or `null` when nothing matched. */
export interface TopLoadAtRepsRead {
  value: number;
  measuredAt: string;
  /** DISTINCT sessions holding a matching set — what the info-level gate counts. */
  matchedSessionCount: number;
}

/**
 * The heaviest load carried for at least `anchorReps` reps, taken from the
 * most recent session that did so.
 *
 * The most recent session rather than the all-time best: a band projects
 * forward from where the lifter IS, and seeding it from a personal record set
 * months ago would commit them to beating a number they cannot currently hit.
 */
export function topLoadAtReps(
  sets: readonly RepCountedSet[],
  anchorReps: number,
): TopLoadAtRepsRead | null {
  const matching = sets.filter((set) => set.repCount >= anchorReps && set.weightLbs > 0);
  if (matching.length === 0) return null;
  const newest = matching.reduce((latest, set) => (set.endedAt > latest.endedAt ? set : latest));
  const inNewestSession = matching.filter((set) => set.sessionId === newest.sessionId);
  const top = inNewestSession.reduce((best, set) => (set.weightLbs > best.weightLbs ? set : best));
  return {
    value: top.weightLbs,
    measuredAt: top.endedAt,
    matchedSessionCount: new Set(matching.map((set) => set.sessionId)).size,
  };
}

/**
 * The rep count this lifter works at most often on these sets, or `null` when
 * there are none.
 *
 * The anchor for a matched-reps read when the catalog names no rep range —
 * which today it never does, so this is the ordinary path rather than a
 * fallback. Asking what the lifter actually does is also the better question:
 * a catalog range is a recommendation, and a target has to be measured against
 * the work that is really being done. Ties go to the LOWER count, so the
 * anchor sits at the heavier end of two equally common standards.
 */
export function modalRepCount(sets: readonly RepCountedSet[]): number | null {
  const counts = new Map<number, number>();
  for (const set of sets) {
    if (set.repCount <= 0) continue;
    counts.set(set.repCount, (counts.get(set.repCount) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestFrequency = 0;
  for (const [repCount, frequency] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (frequency > bestFrequency) {
      best = repCount;
      bestFrequency = frequency;
    }
  }
  return best;
}

/** Points below this leave the residual degrees of freedom at zero or less. */
const MIN_POINTS_FOR_STANDARD_ERROR = 3;

/**
 * The standard error of a fitted slope, from the fit's own slope, r-squared
 * and point count.
 *
 * For a simple linear regression, se(b)^2 = (SSE / (n - 2)) / Sxx and
 * r^2 = b^2 * Sxx / SST, which rearrange to se(b) = |b| * sqrt((1/r^2 - 1) /
 * (n - 2)). It is an identity, not an approximation: the same three figures
 * `history.trend` already reports determine it exactly.
 *
 * `null` when the fit cannot support one — under three points there are no
 * residual degrees of freedom, a zero r-squared makes the expression
 * unbounded, and a perfect fit of 1 would claim an error of zero from data
 * that has not earned it.
 */
export function slopeStandardError(
  slope: number,
  rSquared: number,
  pointCount: number,
): number | null {
  if (pointCount < MIN_POINTS_FOR_STANDARD_ERROR) return null;
  if (!(rSquared > 0) || rSquared >= 1) return null;
  return Math.abs(slope) * Math.sqrt((1 / rSquared - 1) / (pointCount - 2));
}
