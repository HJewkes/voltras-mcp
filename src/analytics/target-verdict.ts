// A set's verdict against its exercise's planned rep floor (VW-262) — one rule,
// shared by `report.session_results`' "missed: X of Y" line and every wall
// surface that flags a missed set, so the two can never disagree about the
// same set.

/** `no-target` when the exercise carries no planned rep floor to judge against. */
export type TargetVerdict = 'hit' | 'miss' | 'no-target';

/** A set's verdict: below the floor is a miss, at or above it is a hit. */
export function targetVerdict(repCount: number, targetRepsLow: number | undefined): TargetVerdict {
  if (targetRepsLow === undefined) return 'no-target';
  return repCount < targetRepsLow ? 'miss' : 'hit';
}

/**
 * Count of `repCounts` entries that missed `targetRepsLow`, or `undefined` when
 * no floor was set (mirrors `report.session_results`' own "no plan attached"
 * omission rather than reporting a false zero).
 */
export function countMissed(
  repCounts: readonly number[],
  targetRepsLow: number | undefined,
): number | undefined {
  if (targetRepsLow === undefined) return undefined;
  return repCounts.filter((reps) => targetVerdict(reps, targetRepsLow) === 'miss').length;
}
