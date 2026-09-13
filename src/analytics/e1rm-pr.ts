// Shared "new e1RM PR" verdict (VW-314) — the SPA hero card's `toExerciseIsPR`
// (`dashboard/spa/panels/exercise-hero-view.ts`) and `metrics.compute`'s
// `strength.e1rm` pipeline both compare a fresh e1RM estimate against a prior
// historical best through this one function, so the two never drift apart on
// what counts as a PR.

import { isNewE1RM } from '@voltras/workout-analytics/view';

export interface E1RMPrVerdict {
  isPR: boolean;
  priorBest: number | null;
}

/**
 * `priorBest` is `historyBest` verbatim — `null` only when there is no prior
 * session to beat, mirroring `isNewE1RM`'s own no-baseline contract (the
 * first-ever session of an exercise is never a PR).
 */
export function evaluateE1RMPr(current: number | null, historyBest: number | null): E1RMPrVerdict {
  return { isPR: isNewE1RM(current, historyBest), priorBest: historyBest };
}
