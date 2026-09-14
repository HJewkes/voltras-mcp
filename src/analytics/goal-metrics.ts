// Which metrics a declared priority is tracked by (VW-347, plan H0 / §2b).
//
// PURE. No store, no catalog lookup of its own, no clock: the caller passes the
// catalog in and the same input always yields the same selection. Picking the
// metric is all this module does — reading history, deriving the band
// (`goal-band.ts`) and persisting the target are H2's job.
//
// THE COACH PICKS THE METRIC, NOT THE HUMAN. The human declares a priority
// ("get bench up", "grow my arms"); this rule turns that into the measurable
// legs of it. A lift is tracked by its top load at matched reps, with the e1RM
// trend as context only. A muscle is tracked through the lifts that train it as
// a primary mover, because RP tracks size through strength and wants agreement
// across two or more exercises before it believes a muscle grew
// (rp:rp-s7-multi-exercise-confirmation-for-muscle-gain).
//
// SETS ARE A DOSE, NEVER A GOAL (B47). Weekly working sets come back on every
// muscle-or-lift selection flagged `informational`, so a surface can show the
// dose without a consumer mistaking it for something to maximise.
//
// WHAT IS NOT MEASURABLE IS SAID, NOT SILENTLY DROPPED. Size, body composition
// and velocity-at-load have no series behind them today, so each returns a
// reason a surface can print rather than an empty array.

import { mapCatalogMuscle, type TitanMuscleGroup } from '../exercises/muscle-map.js';
import type { StoredPriorityKind, StoredPriorityLevel } from '../store/types.js';
import type { GoalMetric } from './goal-band.js';

/** The declaration this rule reads: {@link StoredPriority} minus its stored columns. */
export interface GoalPriority {
  kind: StoredPriorityKind;
  ref: string;
  level: StoredPriorityLevel;
}

/**
 * The catalog fields the rule needs. Structural, so the seed catalog's
 * `Exercise` entries pass without a cast and a future catalog shape that adds
 * a rep range is picked up by `anchorReps` without a change here.
 */
export interface CatalogExercise {
  id: string;
  muscleGroups: readonly string[];
  secondaryMuscleGroups?: readonly string[];
  defaultRepRange?: { low: number; high: number };
}

/**
 * Refs the human says that are not catalog muscle strings.
 *
 * Deliberately tiny: a row exists only where the spoken word covers more than
 * one catalog string. `shoulders`, `back`, `chest` and `core` need no row —
 * they are catalog strings already, and `mapCatalogMuscle` is what fans them
 * out to titan slugs (`shoulders` covers all three deltoid heads because the
 * data cannot split them, VW-323 §4).
 */
export const PRIORITY_MUSCLE_SYNONYMS: Record<string, readonly string[]> = {
  arms: ['biceps', 'triceps'],
  legs: ['quads', 'hamstrings', 'glutes'],
};

/** Refs that are about the whole body rather than one muscle or one lift. */
export const WHOLE_BODY_METRICS: Record<string, GoalMetric> = {
  sessions: 'sessions_28d',
  bodyweight: 'bodyweight',
  strength: 'composite_strength',
};

/** Refs a human may reasonably declare that nothing can measure today. */
export const NOT_MEASURABLE_REFS: Record<string, string> = {
  size: 'Nothing writes a circumference, a photo or a lean-mass figure, and RP tracks size through strength rather than directly (rp:rp-s7-multi-exercise-confirmation-for-muscle-gain). Declare the muscle instead and its lifts are tracked.',
  body_composition:
    'Body metrics hold bodyweight and height only; body-fat percent is display-only (VW-370), so there is no series to track a target against. Declare bodyweight instead.',
  velocity:
    'The history trend series are top load, e1RM and volume; velocity at a fixed load is measured per set but never kept as a series, so it cannot carry a target.',
};

/** Exercises that must agree before a muscle is called grown. rp:rp-s7-multi-exercise-confirmation-for-muscle-gain */
export const MIN_CORROBORATING_LIFTS = 2;

/** One metric the priority is tracked by. `context` legs are read, never scored. */
export interface GoalGainMetric {
  kind: 'gain';
  metric: GoalMetric;
  exerciseId: string | null;
  anchorReps: number | null;
  role: 'primary' | 'context';
}

/** Emitted only when corroboration is impossible, so its presence IS the gap. */
export interface GoalCorroborationGap {
  kind: 'corroboration';
  corroborated: null;
  qualifyingLifts: number;
  reason: string;
}

/** Weekly working sets: the dose the priority is trained at, never the goal. */
export interface GoalDoseMetric {
  kind: 'weekly_sets';
  informational: true;
  exerciseId: string | null;
  muscles: readonly TitanMuscleGroup[];
}

/** A declared ref with no series behind it, carrying what to say about it. */
export interface GoalNotMeasurable {
  kind: 'not_measurable';
  notMeasurable: true;
  ref: string;
  reason: string;
}

export type GoalMetricSelection =
  | GoalGainMetric
  | GoalCorroborationGap
  | GoalDoseMetric
  | GoalNotMeasurable;

/**
 * Turn one declared priority into the metrics that track it.
 *
 * Order is stable: gain legs in catalog order, then the corroboration gap if
 * there is one, then the dose. A `deprioritize` level returns the dose alone —
 * a back-burnered muscle still gets maintenance volume, but no gain is claimed
 * for it (rp:rp-s5-fatloss-priority-training-rule).
 */
export function selectGoalMetrics(
  priority: GoalPriority,
  catalog: readonly CatalogExercise[],
): GoalMetricSelection[] {
  if (priority.kind === 'lift') return liftSelections(priority, catalog);

  const ref = normalizeRef(priority.ref);
  const unmeasurable = NOT_MEASURABLE_REFS[ref];
  if (unmeasurable !== undefined) {
    return [{ kind: 'not_measurable', notMeasurable: true, ref, reason: unmeasurable }];
  }

  const wholeBody = WHOLE_BODY_METRICS[ref];
  if (wholeBody !== undefined) {
    return [
      { kind: 'gain', metric: wholeBody, exerciseId: null, anchorReps: null, role: 'primary' },
    ];
  }

  return muscleSelections(ref, priority.level, catalog);
}

/** The catalog strings a declared muscle ref covers. Unknown refs pass through. */
export function resolveMuscleRef(ref: string): readonly string[] {
  return PRIORITY_MUSCLE_SYNONYMS[normalizeRef(ref)] ?? [normalizeRef(ref)];
}

function normalizeRef(ref: string): string {
  return ref
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function liftSelections(
  priority: GoalPriority,
  catalog: readonly CatalogExercise[],
): GoalMetricSelection[] {
  const exercise = catalog.find((entry) => entry.id === priority.ref);
  const dose: GoalDoseMetric = {
    kind: 'weekly_sets',
    informational: true,
    exerciseId: priority.ref,
    muscles: exercise === undefined ? [] : primarySlugsOf(exercise),
  };
  if (priority.level === 'deprioritize') return [dose];

  return [
    {
      kind: 'gain',
      metric: 'top_load_at_reps',
      exerciseId: priority.ref,
      anchorReps: anchorRepsOf(exercise),
      role: 'primary',
    },
    {
      kind: 'gain',
      metric: 'e1rm_trend',
      exerciseId: priority.ref,
      anchorReps: null,
      role: 'context',
    },
  ];
}

function muscleSelections(
  ref: string,
  level: StoredPriorityLevel,
  catalog: readonly CatalogExercise[],
): GoalMetricSelection[] {
  const targets = new Set(resolveMuscleRef(ref).flatMap(mapCatalogMuscle));
  const dose: GoalDoseMetric = {
    kind: 'weekly_sets',
    informational: true,
    exerciseId: null,
    muscles: [...targets],
  };
  if (level === 'deprioritize') return [dose];

  const qualifying = catalog.filter((entry) =>
    primarySlugsOf(entry).some((slug) => targets.has(slug)),
  );
  const selections: GoalMetricSelection[] = qualifying.map((entry) => ({
    kind: 'gain',
    metric: 'top_load_at_reps',
    exerciseId: entry.id,
    anchorReps: anchorRepsOf(entry),
    role: 'primary',
  }));
  if (qualifying.length < MIN_CORROBORATING_LIFTS) {
    selections.push(corroborationGap(qualifying.length));
  }
  selections.push(dose);
  return selections;
}

function corroborationGap(qualifyingLifts: number): GoalCorroborationGap {
  const shortfall =
    qualifyingLifts === 0
      ? 'No catalog lift trains this as a primary mover'
      : `Only ${qualifyingLifts} catalog lift trains this as a primary mover`;
  return {
    kind: 'corroboration',
    corroborated: null,
    qualifyingLifts,
    reason: `${shortfall}; muscle-gain agreement needs ${MIN_CORROBORATING_LIFTS} (rp:rp-s7-multi-exercise-confirmation-for-muscle-gain), so this priority is tracked without a corroborated verdict.`,
  };
}

function primarySlugsOf(exercise: CatalogExercise): TitanMuscleGroup[] {
  return exercise.muscleGroups.flatMap(mapCatalogMuscle);
}

/** The low edge: a top load is compared at the heaviest reps of the range. */
function anchorRepsOf(exercise: CatalogExercise | undefined): number | null {
  return exercise?.defaultRepRange?.low ?? null;
}
