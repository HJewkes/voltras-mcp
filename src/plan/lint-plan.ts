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
//   intermediate  attractor 2-4 sets/exercise/session, 4-8/muscle in week 1 —
//                 the same per-muscle ceiling as a beginner, off a lower floor
//   advanced      often zero or one set added across an ENTIRE mesocycle, so
//                 there is no per-session number to compare against
//
// Sources: rp-s5-set-addition-not-progression-tool,
// rp-s5-set-addition-decision-rule, rp-s6-set-progression-state-machine,
// rp-s5-volume-err-low-first-week.
//
// B32 (block/week structural lints) adds three more codes. Unlike B31/the
// weekly ceiling above, these are not RP volume numbers — they are plan-shape
// checks (did the mesocycle's length change after weeks were already built,
// did the priority muscle drift, is the same muscle stacked on back-to-back
// days). `meso_length_grew_mid_block` and `priority_muscle_changed_mid_block`
// have no ceiling to cite, so `observed`/`ceiling`/`tier` are optional on
// `PlanWarning` to let them omit what does not apply.

import type { Tier, TierConfidence } from '../tools/tier-signal.js';

export type PlanWarningCode =
  | 'sets_per_exercise_over_tier_ceiling'
  | 'sets_per_muscle_per_session_over_tier_ceiling'
  | 'hard_sets_per_muscle_per_week_over_tier_ceiling'
  | 'meso_length_grew_mid_block'
  | 'priority_muscle_changed_mid_block'
  | 'same_muscle_high_volume_consecutive_days';

export interface PlanWarning {
  code: PlanWarningCode;
  message: string;
  exerciseId?: string;
  muscleGroup?: string;
  observed?: number;
  ceiling?: number;
  tier?: Tier;
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

// Both 8s are the corpus's, from the one line that states them together:
// "beginner ~5 sets/exercise, 5-8 sets/muscle/session, 10-20 hard
// sets/muscle/week; intermediate attractor 2-4 sets/exercise/session (4-8/muscle
// in week 1)" (rp-s5-volume-err-low-first-week). The intermediate range starts
// LOWER than the beginner one and ends at the same place, so the two share a
// ceiling — an intermediate may earn more across the mesocycle, which is why the
// warning is advisory and says so.
const SETS_PER_MUSCLE_PER_SESSION_CEILING: Record<Tier, number | null> = {
  beginner: 8,
  intermediate: 8,
  advanced: null,
};

/** The low end of each tier's per-muscle range, for the warning copy only. */
const SETS_PER_MUSCLE_RANGE_FLOOR: Record<Tier, number> = {
  beginner: 5,
  intermediate: 4,
  advanced: 0,
};

// The same corpus line that gives the per-session 5-8/4-8 numbers also gives
// the ONLY weekly figure in the ticket text: beginner 10-20 hard
// sets/muscle/week (rp-s5-volume-err-low-first-week). Neither the ticket nor
// the cited RP prose states an intermediate or advanced weekly figure, so
// both are `null` per REVIEW FOCUS 1 — leave null, never guess.
const HARD_SETS_PER_MUSCLE_PER_WEEK_CEILING: Record<Tier, number | null> = {
  beginner: 20,
  intermediate: null,
  advanced: null,
};

const HARD_SETS_PER_MUSCLE_PER_WEEK_FLOOR: Record<Tier, number> = {
  beginner: 10,
  intermediate: 0,
  advanced: 0,
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
  const range = `${SETS_PER_MUSCLE_RANGE_FLOOR[tier]}-${ceiling}`;
  const opening =
    `${observed} sets for ${muscleGroup} in this session is above the ${tier} range of ` +
    `${range} sets per muscle per session.`;
  if (tier === 'beginner') {
    return (
      `${opening} ${REAL_FIX} — start at the low end and add one set only when recovery ` +
      'says the last number was too easy.'
    );
  }
  return (
    `${opening} Whether that is too much is recovery-dependent, not automatic: hold at this ` +
    "number and let the next session's recovery decide, rather than planning the increase " +
    `now. ${REAL_FIX}.`
  );
}

/** Sums `targetSets` by muscle group across a flat list, ignoring `dayIndex`. */
function totalsByMuscle(exercises: LintPlanExercise[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const e of exercises) {
    if (e.muscleGroup === undefined) continue;
    totals.set(e.muscleGroup, (totals.get(e.muscleGroup) ?? 0) + e.targetSets);
  }
  return totals;
}

// --- weekly ceiling (B31 remainder) ---

export interface LintWeeklyVolumeInput {
  /** Every exercise across every template in the week, not just one session. */
  exercises: LintPlanExercise[];
  tier: Tier;
  confidence: TierConfidence;
}

/**
 * Hard sets per muscle group for a whole week, against the beginner-only
 * 10-20 figure. Returns `[]` for a tier with no cited weekly number.
 */
export function lintWeeklyVolume(input: LintWeeklyVolumeInput): PlanWarning[] {
  const ceiling = HARD_SETS_PER_MUSCLE_PER_WEEK_CEILING[input.tier];
  if (ceiling === null) return [];
  const warnings = [...totalsByMuscle(input.exercises)]
    .filter(([, sets]) => sets > ceiling)
    .map(([muscleGroup, sets]) => ({
      code: 'hard_sets_per_muscle_per_week_over_tier_ceiling' as const,
      message: weeklyVolumeMessage(muscleGroup, sets, input.tier, ceiling),
      muscleGroup,
      observed: sets,
      ceiling,
      tier: input.tier,
    }));
  if (input.confidence !== 'provisional') return warnings;
  return warnings.map((w) => ({ ...w, message: w.message + PROVISIONAL_SUFFIX }));
}

function weeklyVolumeMessage(
  muscleGroup: string,
  observed: number,
  tier: Tier,
  ceiling: number,
): string {
  const floor = HARD_SETS_PER_MUSCLE_PER_WEEK_FLOOR[tier];
  return (
    `${observed} hard sets for ${muscleGroup} across this week is above the ${tier} range of ` +
    `${floor}-${ceiling} hard sets per muscle per week. ${REAL_FIX} — weekly volume is raised ` +
    'one set at a time on recovery evidence across the mesocycle, never planned up front.'
  );
}

// --- B32: block/week structural lints ---

export interface LintMesoLengthInput {
  previousWeeksCount: number;
  newWeeksCount: number;
  /** Weeks already created under this block, before this update. */
  weeksAlreadyCreated: number;
}

/**
 * A block's `weeksCount` grew after weeks of it were already built. Silent
 * when nothing has been built yet — extending an empty block's planned
 * length is just normal authoring, not a mid-block change.
 */
export function lintMesoLengthGrewMidBlock(input: LintMesoLengthInput): PlanWarning[] {
  if (input.weeksAlreadyCreated === 0) return [];
  if (input.newWeeksCount <= input.previousWeeksCount) return [];
  const weekWord = input.weeksAlreadyCreated === 1 ? 'week' : 'weeks';
  return [
    {
      code: 'meso_length_grew_mid_block',
      message:
        `This block's planned length grew from ${input.previousWeeksCount} to ` +
        `${input.newWeeksCount} weeks after ${input.weeksAlreadyCreated} ${weekWord} of it had ` +
        'already been built. Mesocycle length is normally a call made once, up front — ' +
        'extending it mid-block usually means the original block already ran its course and ' +
        'this is really the start of the next one.',
      observed: input.newWeeksCount,
      ceiling: input.previousWeeksCount,
    },
  ];
}

export interface LintPriorityMuscleInput {
  week1Exercises: LintPlanExercise[];
  laterWeekExercises: LintPlanExercise[];
  /** 0-based `orderIndex` of the later week, for the message only. */
  laterWeekOrderIndex: number;
}

/**
 * The muscle group with the most planned sets in week 1 vs. a later week of
 * the same block. Silent when either week has no resolvable muscle data, or
 * when the top spot is tied — a tie is not a determinable priority to compare.
 */
export function lintPriorityMuscleChangedMidBlock(input: LintPriorityMuscleInput): PlanWarning[] {
  const week1Top = topMuscle(input.week1Exercises);
  const laterTop = topMuscle(input.laterWeekExercises);
  if (week1Top === null || laterTop === null || week1Top === laterTop) return [];
  return [
    {
      code: 'priority_muscle_changed_mid_block',
      message:
        `Week 1 of this block prioritized ${week1Top} (the most planned sets), but week ` +
        `${input.laterWeekOrderIndex + 1} prioritizes ${laterTop} instead. A block's priority ` +
        'muscle is normally set once for the whole mesocycle — if this shift is intentional, ' +
        'it usually means this is really the start of a new block rather than a change inside ' +
        'this one.',
      muscleGroup: laterTop,
    },
  ];
}

/** `null` when there is nothing to compare, or the top spot is tied. */
function topMuscle(exercises: LintPlanExercise[]): string | null {
  let best: string | null = null;
  let bestSets = -1;
  let tied = false;
  for (const [muscleGroup, sets] of totalsByMuscle(exercises)) {
    if (sets > bestSets) {
      best = muscleGroup;
      bestSets = sets;
      tied = false;
    } else if (sets === bestSets) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export interface LintConsecutiveDayTemplate {
  dayLabel?: string;
  exercises: LintPlanExercise[];
}

export interface LintConsecutiveDaysInput {
  /** Templates for one week, in `orderIndex` order. */
  templates: LintConsecutiveDayTemplate[];
  tier: Tier;
  confidence: TierConfidence;
}

/**
 * Two adjacent templates (by `orderIndex`) that both exceed the tier's
 * per-session per-muscle ceiling for the SAME muscle group. Reuses
 * `SETS_PER_MUSCLE_PER_SESSION_CEILING` rather than a new number — the
 * corpus does not give consecutive-day volume its own ceiling.
 */
export function lintSameMuscleHighVolumeConsecutiveDays(
  input: LintConsecutiveDaysInput,
): PlanWarning[] {
  const ceiling = SETS_PER_MUSCLE_PER_SESSION_CEILING[input.tier];
  if (ceiling === null) return [];
  const warnings: PlanWarning[] = [];
  for (let i = 0; i < input.templates.length - 1; i++) {
    const dayA = input.templates[i]?.dayLabel;
    const dayB = input.templates[i + 1]?.dayLabel;
    if (dayA === undefined || dayB === undefined) continue;
    warnings.push(
      ...consecutiveDayWarnings(
        dayA,
        input.templates[i].exercises,
        dayB,
        input.templates[i + 1].exercises,
        input.tier,
        ceiling,
      ),
    );
  }
  if (input.confidence !== 'provisional') return warnings;
  return warnings.map((w) => ({ ...w, message: w.message + PROVISIONAL_SUFFIX }));
}

function consecutiveDayWarnings(
  dayA: string,
  exercisesA: LintPlanExercise[],
  dayB: string,
  exercisesB: LintPlanExercise[],
  tier: Tier,
  ceiling: number,
): PlanWarning[] {
  const aTotals = totalsByMuscle(exercisesA);
  const bTotals = totalsByMuscle(exercisesB);
  const warnings: PlanWarning[] = [];
  for (const [muscleGroup, aSets] of aTotals) {
    const bSets = bTotals.get(muscleGroup);
    if (bSets === undefined || aSets <= ceiling || bSets <= ceiling) continue;
    warnings.push({
      code: 'same_muscle_high_volume_consecutive_days',
      message:
        `${muscleGroup} is over the ${tier} per-session ceiling of ${ceiling} sets on both ` +
        `${dayA} (${aSets}) and the very next day, ${dayB} (${bSets}). Back-to-back ` +
        'high-volume days for the same muscle cut into the recovery window that ceiling is ' +
        "built around. Consider resequencing, or lowering one day's volume toward the ceiling.",
      muscleGroup,
      observed: Math.max(aSets, bSets),
      ceiling,
      tier,
    });
  }
  return warnings;
}
