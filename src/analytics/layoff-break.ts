// Which comparisons a layoff takes out of the regression signals (VW-975).
//
// A break is the `re-entry.ts` one: a run of whole calendar days between two training days long
// enough to fall outside its `none` band. Performance after such a break is detraining plus the
// planned light weeks, so a comparison that reaches back across it reads a layoff as a collapse.
// The drift guard (and through it the MRV guard) refuses such a pair, and the stall rule only
// reads sessions after the last one.
//
// Pure: callers pass local calendar dates.

import { classifyBreak } from './re-entry.js';
import { trainingGaps, type TrainingGap } from './training-days.js';

/** The longest break between consecutive days, or `null` when every gap is inside the `none` band. */
export function longestBreak(days: readonly string[]): TrainingGap | null {
  const sorted = [...new Set(days)].sort();
  const breaks = trainingGaps(sorted).filter((gap) => classifyBreak(gap.days) !== 'none');
  return breaks.reduce<TrainingGap | null>(
    (longest, gap) => (longest === null || gap.days > longest.days ? gap : longest),
    null,
  );
}

/** The first day after the most recent break, or `null` when there is none. */
export function lastBreakEnd(days: readonly string[]): string | null {
  const sorted = [...new Set(days)].sort();
  const breaks = trainingGaps(sorted).filter((gap) => classifyBreak(gap.days) !== 'none');
  return breaks.at(-1)?.endsOn ?? null;
}
