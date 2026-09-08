// `lintPlan()` — tier-aware volume ceilings as ADVISORY plan warnings
// (VMCP-06.03 / RP backlog B31).
//
// Pure and store-free by construction: the caller reads the tier once, resolves
// each exercise's primary muscle group, and hands this function a flat list.
// That is what makes the ceilings testable without a database and what keeps
// the plan write path unable to fail because of a lint.
//
// ADVISORY, NEVER BLOCKING (backlog Addendum 4 decision 2). Nothing here
// throws, nothing here rejects a plan, and every message points at the real
// fix rather than at the number: RP is explicit that sets are not the
// progression tool — technique and effort come first, and set count is raised
// one at a time on recovery evidence, never planned up front.
//
// The ceilings are the corpus's, and they are the same numbers
// `coaching.explain meso.volume_progression` reads out:
//
//   beginner      ~5 sets/exercise, 5-8 sets/muscle/session, 10-20 hard
//                 sets/muscle/week
//   intermediate  attractor 2-4 sets/exercise/session (4-8/muscle in week 1)
//   advanced      often zero or one set added across an ENTIRE mesocycle, so
//                 there is no per-session number to compare against
//
// Sources: rp-s5-set-addition-not-progression-tool,
// rp-s5-set-addition-decision-rule, rp-s6-set-progression-state-machine,
// rp-s5-volume-err-low-first-week.

import type { Tier, TierConfidence } from '../tools/tier-signal.js';

export type PlanWarningCode =
  | 'sets_per_exercise_over_tier_ceiling'
  | 'sets_per_muscle_per_session_over_tier_ceiling'
  /**
   * DECLARED BUT NOT EMITTED. The weekly ceiling (beginner 10-20 hard
   * sets/muscle/week) needs every template in the week plus each template's
   * planned exercises — `plan.template.list_for_week` returns the templates
   * only, so it is one query per sibling template, not one query. The code is
   * reserved here so the second B31/B32 PR does not have to rename anything.
   */
  | 'hard_sets_per_muscle_per_week_over_tier_ceiling';

export interface PlanWarning {
  code: PlanWarningCode;
  message: string;
  exerciseId?: string;
  muscleGroup?: string;
  observed: number;
  ceiling: number;
  tier: Tier;
}

export interface LintPlanExercise {
  exerciseId: string;
  targetSets: number;
  /** PRIMARY muscle group only (`muscleGroups[0]`); absent skips the per-muscle lint. */
  muscleGroup?: string;
  /** Which session within the plan. Absent means "the one session being linted". */
  dayIndex?: number;
}

export interface LintPlanInput {
  exercises: LintPlanExercise[];
  tier: Tier;
  confidence: TierConfidence;
}

/** `null` = the tier has no per-session number to compare against. */
const SETS_PER_EXERCISE_CEILING: Record<Tier, number | null> = {
  beginner: 5,
  intermediate: 4,
  advanced: null,
};

const SETS_PER_MUSCLE_PER_SESSION_CEILING: Record<Tier, number | null> = {
  beginner: 8,
  intermediate: 10,
  advanced: null,
};

const PROVISIONAL_SUFFIX =
  ' (tier is provisional; set `profile.set_training_background` to confirm)';

const REAL_FIX = 'Technique and effort before more sets';

interface MuscleDayBucket {
  muscleGroup: string;
  sets: number;
}

/**
 * Advisory warnings for one session's worth of planned exercises. Returns an
 * empty array when the plan is within its tier's ceilings, when the tier has
 * no ceiling, or when there is nothing to measure.
 */
export function lintPlan(input: LintPlanInput): PlanWarning[] {
  const warnings = [
    ...lintSetsPerExercise(input.exercises, input.tier),
    ...lintSetsPerMuscle(input.exercises, input.tier),
  ];
  if (input.confidence !== 'provisional') return warnings;
  return warnings.map((w) => ({ ...w, message: w.message + PROVISIONAL_SUFFIX }));
}

function lintSetsPerExercise(exercises: LintPlanExercise[], tier: Tier): PlanWarning[] {
  const ceiling = SETS_PER_EXERCISE_CEILING[tier];
  if (ceiling === null) return [];
  return exercises
    .filter((e) => e.targetSets > ceiling)
    .map((e) => ({
      code: 'sets_per_exercise_over_tier_ceiling' as const,
      message: setsPerExerciseMessage(e, tier, ceiling),
      exerciseId: e.exerciseId,
      observed: e.targetSets,
      ceiling,
      tier,
    }));
}

function setsPerExerciseMessage(e: LintPlanExercise, tier: Tier, ceiling: number): string {
  if (tier === 'beginner') {
    return (
      `${e.targetSets} sets of ${e.exerciseId} is above the beginner ceiling of about ` +
      `${ceiling} sets per exercise. ${REAL_FIX} — a beginner grows on execution quality, ` +
      'and week-1 volume should err low because under-dosing is free to correct next week ' +
      'while over-dosing leaves fatigue debt.'
    );
  }
  return (
    `${e.targetSets} sets of ${e.exerciseId} is above the intermediate attractor of 2-4 ` +
    `sets per exercise per session (soft ceiling ${ceiling}). Sets are added one at a time ` +
    `on recovery evidence, not planned up front. ${REAL_FIX}.`
  );
}

function lintSetsPerMuscle(exercises: LintPlanExercise[], tier: Tier): PlanWarning[] {
  const ceiling = SETS_PER_MUSCLE_PER_SESSION_CEILING[tier];
  if (ceiling === null) return [];
  return [...setsByMuscleAndDay(exercises).values()]
    .filter((bucket) => bucket.sets > ceiling)
    .map((bucket) => ({
      code: 'sets_per_muscle_per_session_over_tier_ceiling' as const,
      message: setsPerMuscleMessage(bucket.muscleGroup, bucket.sets, tier, ceiling),
      muscleGroup: bucket.muscleGroup,
      observed: bucket.sets,
      ceiling,
      tier,
    }));
}

/**
 * Hard sets per (session, primary muscle group). Exercises with no resolved
 * muscle group are skipped rather than pooled under a placeholder — a bucket
 * of "unknown" would produce a warning naming no muscle anyone can act on.
 */
function setsByMuscleAndDay(exercises: LintPlanExercise[]): Map<string, MuscleDayBucket> {
  const totals = new Map<string, MuscleDayBucket>();
  for (const e of exercises) {
    if (e.muscleGroup === undefined) continue;
    const key = `${e.dayIndex ?? 0} ${e.muscleGroup}`;
    const bucket = totals.get(key) ?? { muscleGroup: e.muscleGroup, sets: 0 };
    bucket.sets += e.targetSets;
    totals.set(key, bucket);
  }
  return totals;
}

function setsPerMuscleMessage(
  muscleGroup: string,
  observed: number,
  tier: Tier,
  ceiling: number,
): string {
  if (tier === 'beginner') {
    return (
      `${observed} sets for ${muscleGroup} in this session is above the beginner range of ` +
      `5-${ceiling} sets per muscle per session. ${REAL_FIX} — start at the low end and ` +
      'add one set only when recovery says the last number was too easy.'
    );
  }
  return (
    `${observed} sets for ${muscleGroup} in this session is above ${ceiling}. Whether that ` +
    'is too much is recovery-dependent, not automatic: hold at this number and let the next ' +
    `session's recovery decide, rather than planning the increase now. ${REAL_FIX}.`
  );
}
