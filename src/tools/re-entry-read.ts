// The store read behind `plan.next_workout`'s `reEntry` (VW-851, slice VW-906).
//
// The rule is pure (`analytics/re-entry.ts`); this is the one place that feeds it. It reads the
// owner's training days by the VW-462 rule, so a guest's days and a `test`-kind session never
// count, and it takes today's local date from the caller.

import { readTrainingDaysMatching, type TrainingDayStore } from '../analytics/training-days.js';
import { selectReEntry, type ReEntryRead } from '../analytics/re-entry.js';

/** Everything the lifter has logged up to `nowIso`, not a rolling window: a break can be long. */
export async function readReEntry(
  store: TrainingDayStore,
  today: string,
  nowIso: string,
): Promise<ReEntryRead> {
  const trainingDays = await readTrainingDaysMatching(store, { to: nowIso });
  return selectReEntry({ trainingDays, today });
}
