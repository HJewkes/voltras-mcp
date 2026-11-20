// Where one set's rep count lands against a planned rep band (VW-937).
//
// Store-free and Node-free, so `plan.suggest_progression`'s tally and the
// dashboard's session-completion page read reps against the plan by ONE rule.
// Two copies of a band rule that drift apart would mark a set "missed" on the
// page while the recommendation beside it counted the same set as in band.

/** `over` reached the top of the band, `in` sits inside it, `under` fell short of its floor. */
export type RepBandClass = 'over' | 'in' | 'under';

/**
 * Classify `reps` against a `low`..`high` band. A band with no `high` is a
 * single rep target, so reaching `low` already tops it out. Reaching the top
 * counts as `over`, because that is what earns a load step.
 */
export function classifyRepsAgainstBand(
  reps: number,
  low: number,
  high: number | undefined,
): RepBandClass {
  if (reps >= (high ?? low)) return 'over';
  if (reps >= low) return 'in';
  return 'under';
}
