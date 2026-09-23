// The one rule that reads a goal kind off the fields a planned row already carries
// (VW-448 amendment s.2). Every write path and the v38 backfill call this, so a row
// authored by the plan tools, by the dashboard, by the TrueCoach import and by the
// migration cannot end up with different kinds from the same numbers. The same three
// write paths then run `validatePrescription` (VW-537), so they also refuse alike.
//
// PURE. No store, no clock, no I/O.

import type { TrainingIntent } from '../schemas/set.js';
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

/** Everything `validatePrescription` reads: the goal, its fields, and the rest pair. */
export interface PrescriptionFields extends GoalKindFields {
  goalKind?: PlanGoalKind | undefined;
  targetRepsHigh?: number | undefined;
  trainingIntent?: TrainingIntent | undefined;
  restSec?: number | undefined;
  restLearning?: boolean | undefined;
}

/** A broken rule: a sentence a person can read, and the input field it points at. */
export interface PrescriptionRefusal {
  message: string;
  field: keyof PrescriptionFields;
}

const GOAL_FIELD_RULES: Record<
  PlanGoalKind,
  (f: PrescriptionFields) => PrescriptionRefusal | null
> = {
  rep_range: (f) =>
    f.targetRepsLow === undefined
      ? {
          field: 'targetRepsLow',
          message: 'A rep-range goal needs a rep range. Add one, or choose a different goal type.',
        }
      : null,
  target_rpe: (f) =>
    f.targetRpe === undefined
      ? {
          field: 'targetRpe',
          message: 'A target-RPE goal needs an RPE. Add one, or choose a different goal type.',
        }
      : null,
  velocity_loss: (f) =>
    f.targetVelocityLossPct === undefined && f.trainingIntent === undefined
      ? {
          field: 'targetVelocityLossPct',
          message:
            'A velocity-loss goal needs a percent. Add a percent, or set a training intent so ' +
            'the default percent can be used.',
        }
      : null,
};

/** The two independent halves of the shape check; an edit re-checks only the ones it touches. */
export type PrescriptionGroup = 'goal' | 'rest';

const ALL_GROUPS: readonly PrescriptionGroup[] = ['goal', 'rest'];

/**
 * The one shape check every write path runs on the row it is about to store (VW-448
 * amendment, "One prescription shape"; VW-445 s.7.2). Returns the first broken rule, or
 * null. Its message names the way out in plain words (OWNER: no field names in text a
 * person reads); `field` carries the input name for a program. `goalKind` is the kind
 * being written, already defaulted; absent means the row states no goal. Absent
 * `restLearning` means on. A create checks both groups; an edit passes only the groups it
 * touches, so a stored row that breaks a rule can still have its other fields edited.
 */
export function validatePrescription(
  fields: PrescriptionFields,
  groups: readonly PrescriptionGroup[] = ALL_GROUPS,
): PrescriptionRefusal | null {
  const goalRefusal = groups.includes('goal') ? validateGoal(fields) : null;
  if (goalRefusal !== null) return goalRefusal;
  return groups.includes('rest') ? validateRest(fields) : null;
}

function validateGoal(fields: PrescriptionFields): PrescriptionRefusal | null {
  const kindRefusal =
    fields.goalKind === undefined ? null : GOAL_FIELD_RULES[fields.goalKind](fields);
  if (kindRefusal !== null) return kindRefusal;
  const { targetRepsLow: low, targetRepsHigh: high } = fields;
  if (low !== undefined && high !== undefined && high < low) {
    return {
      field: 'targetRepsHigh',
      message: `The top of the rep range (${high}) must be at least the bottom (${low}).`,
    };
  }
  if (fields.targetVelocityLossPct !== undefined && fields.goalKind !== 'velocity_loss') {
    return {
      field: 'targetVelocityLossPct',
      message:
        'A velocity-loss percent only applies to a velocity-loss goal. Change the goal type, ' +
        'or remove the percent.',
    };
  }
  return null;
}

function validateRest(fields: PrescriptionFields): PrescriptionRefusal | null {
  return isRestInvalid(fields)
    ? {
        field: 'restSec',
        message:
          'Rest learning is off, so this exercise needs a fixed rest. Add a rest time, or ' +
          'turn rest learning on.',
      }
    : null;
}

/** A stored row with learning off and no rest: the read-time fallback, never a valid write. */
export function isRestInvalid(
  fields: Pick<PrescriptionFields, 'restSec' | 'restLearning'>,
): boolean {
  return fields.restLearning === false && fields.restSec === undefined;
}
