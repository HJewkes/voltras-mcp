// Specialization programming rules (VW-624, B45). ADVISORY ONLY: a warning never blocks a write.
//
// A session that trains a specialized muscle carries two exercises for it, against one for a
// back-burner muscle. A beginner is exempt: one exercise already specializes for a beginner
// (rp-s5-prioritized-muscle-double-exercise-count). The note states the rule for intermediates and
// its application extends it to advanced, so every non-beginner tier gets it.

import { resolveMuscleRef, wholeBodyRefOf } from '../analytics/goal-metrics.js';
import { mapCatalogMuscle, type TitanMuscleGroup } from '../exercises/muscle-map.js';
import type { StoredPriority } from '../store/types.js';
import type { Tier, TierConfidence } from '../tools/tier-signal.js';
import { PROVISIONAL_SUFFIX, type LintPlanExercise, type PlanWarning } from './lint-plan.js';

const DOUBLE_EXERCISE = 'rp-s5-prioritized-muscle-double-exercise-count';

type PriorityShape = Pick<StoredPriority, 'kind' | 'ref' | 'level'>;

/** A live `specialize` priority on a muscle, not a lift or a whole-body ref. */
export function isSpecializedMuscle(priority: PriorityShape): boolean {
  return (
    priority.kind === 'muscle' &&
    priority.level === 'specialize' &&
    wholeBodyRefOf(priority) === null
  );
}

/** The landmark slugs one muscle ref covers: "arms" is biceps and triceps. */
export function priorityMuscleSlugs(ref: string): TitanMuscleGroup[] {
  return [...new Set(resolveMuscleRef(ref).flatMap(mapCatalogMuscle))];
}

/** Every landmark slug the declared specializations cover. */
export function specializedMuscles(priorities: readonly PriorityShape[]): TitanMuscleGroup[] {
  const slugs = priorities.filter(isSpecializedMuscle).flatMap((p) => priorityMuscleSlugs(p.ref));
  return [...new Set(slugs)];
}

export interface LintSpecializationInput {
  /** One session's planned exercises. */
  exercises: readonly LintPlanExercise[];
  /** Landmark slugs of the specialized muscles. */
  specialized: readonly string[];
  tier: Tier;
  confidence: TierConfidence;
}

/** A warning per specialized muscle this session trains with exactly one distinct exercise. */
export function lintSpecializedMuscleExercises(input: LintSpecializationInput): PlanWarning[] {
  if (input.tier === 'beginner') return [];
  const warnings = input.specialized
    .filter((muscle) => exerciseCountFor(input.exercises, muscle) === 1)
    .map((muscle) => singleExerciseWarning(muscle, input.tier));
  if (input.confidence !== 'provisional') return warnings;
  return warnings.map((w) => ({ ...w, message: w.message + PROVISIONAL_SUFFIX }));
}

function exerciseCountFor(exercises: readonly LintPlanExercise[], muscle: string): number {
  return new Set(exercises.filter((e) => e.muscleGroups.includes(muscle)).map((e) => e.exerciseId))
    .size;
}

function singleExerciseWarning(muscle: string, tier: Tier): PlanWarning {
  const label = muscle.replaceAll('_', ' ');
  return {
    code: 'specialized_muscle_single_exercise',
    message:
      `This session trains ${label}, a specialized muscle, with one exercise. Past the beginner ` +
      'stage a specialized muscle gets two exercises in each session that trains it, against one ' +
      `for a back-burner muscle, so it is hit from a second angle (${DOUBLE_EXERCISE}). Consider ` +
      'adding a second exercise for it here.',
    muscleGroup: muscle,
    observed: 1,
    floor: 2,
    tier,
  };
}
