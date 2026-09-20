// The one rule that reads a goal kind off the fields a planned row already carries
// (VW-448 amendment s.2). Every write path and the v38 backfill call this, so a row
// authored by the plan tools, by the dashboard, by the TrueCoach import and by the
// migration cannot end up with different kinds from the same numbers.
//
// PURE. No store, no clock, no I/O.

import type { PlanGoalKind } from '../store/types.js';

/** The effort fields the rule reads. Every one of them is optional on a planned row. */
export interface GoalKindFields {
  targetVelocityLossPct?: number | undefined;
  targetRepsLow?: number | undefined;
  targetRpe?: number | undefined;
}

/**
 * The kind a row states when the author named none. Ordered, not scored: a loss target is
 * only ever the goal, a rep range outranks an RPE on the same row (the RPE becomes its
 * cap), and a row with none of the three states no goal. `null` is that answer, never a
 * placeholder — nothing downstream may read it as an implied `rep_range`.
 */
export function defaultGoalKind(fields: GoalKindFields): PlanGoalKind | null {
  if (fields.targetVelocityLossPct !== undefined) return 'velocity_loss';
  if (fields.targetRepsLow !== undefined) return 'rep_range';
  if (fields.targetRpe !== undefined) return 'target_rpe';
  return null;
}
