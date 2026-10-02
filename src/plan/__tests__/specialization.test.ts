// The specialization exercise-count lint (VW-624): two exercises for a specialized muscle in a
// session that trains it, one for a back-burner muscle, and a beginner exempt.

import { describe, expect, it } from 'vitest';

import type { StoredPriority, StoredPriorityLevel } from '../../store/types.js';
import type { LintPlanExercise } from '../lint-plan.js';
import {
  isSpecializedMuscle,
  lintSpecializedMuscleExercises,
  specializedMuscles,
} from '../specialization.js';

function exercise(exerciseId: string, ...muscleGroups: string[]): LintPlanExercise {
  return { exerciseId, targetSets: 3, muscleGroups };
}

function muscle(ref: string, level: StoredPriorityLevel): StoredPriority {
  return {
    id: `pri-${ref}`,
    userId: 'local',
    horizonWeeks: 6,
    kind: 'muscle',
    ref,
    level,
    declaredAt: '2026-09-01T00:00:00.000Z',
    mesosHeld: 1,
  };
}

const curl = exercise('curl', 'biceps');
const hammer = exercise('hammer', 'biceps');
const press = exercise('press', 'chest');

describe('specialized muscle exercise count', () => {
  it('warns an intermediate whose specialized muscle gets one exercise in a session', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [curl, press],
      specialized: ['biceps'],
      tier: 'intermediate',
      confidence: 'confident',
    });

    expect(warnings).toMatchObject([
      {
        code: 'specialized_muscle_single_exercise',
        muscleGroup: 'biceps',
        observed: 1,
        floor: 2,
      },
    ]);
    expect(warnings[0]?.message).toContain('rp-s5-prioritized-muscle-double-exercise-count');
  });

  it('stays quiet once the session carries a second exercise for it', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [curl, hammer, press],
      specialized: ['biceps'],
      tier: 'intermediate',
      confidence: 'confident',
    });

    expect(warnings).toEqual([]);
  });

  it('counts the same exercise planned twice as one exercise', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [curl, curl],
      specialized: ['biceps'],
      tier: 'intermediate',
      confidence: 'confident',
    });

    expect(warnings.map((w) => w.muscleGroup)).toEqual(['biceps']);
  });

  it('exempts a beginner, for whom one exercise already specializes', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [curl],
      specialized: ['biceps'],
      tier: 'beginner',
      confidence: 'confident',
    });

    expect(warnings).toEqual([]);
  });

  it('applies to an advanced lifter too', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [curl],
      specialized: ['biceps'],
      tier: 'advanced',
      confidence: 'confident',
    });

    expect(warnings).toHaveLength(1);
  });

  it('says nothing about a specialized muscle the session does not train', () => {
    const warnings = lintSpecializedMuscleExercises({
      exercises: [press],
      specialized: ['biceps'],
      tier: 'intermediate',
      confidence: 'confident',
    });

    expect(warnings).toEqual([]);
  });

  it('marks the warning when the tier is provisional', () => {
    const [warning] = lintSpecializedMuscleExercises({
      exercises: [curl],
      specialized: ['biceps'],
      tier: 'intermediate',
      confidence: 'provisional',
    });

    expect(warning?.message).toContain('tier is provisional');
  });
});

describe('which muscles count as specialized', () => {
  it('lets a back-burner muscle stand on one exercise', () => {
    const priorities = [muscle('chest', 'maintain'), muscle('triceps', 'deprioritize')];

    const warnings = lintSpecializedMuscleExercises({
      exercises: [press, exercise('pushdown', 'triceps')],
      specialized: specializedMuscles(priorities),
      tier: 'intermediate',
      confidence: 'confident',
    });

    expect(warnings).toEqual([]);
  });

  it('fans a spoken ref out to its landmark slugs', () => {
    expect(specializedMuscles([muscle('arms', 'specialize')]).sort()).toEqual([
      'biceps',
      'triceps',
    ]);
  });

  it('ignores a lift priority and a whole-body ref', () => {
    const lift = { ...muscle('cable-row', 'specialize'), kind: 'lift' as const };

    expect(isSpecializedMuscle(lift)).toBe(false);
    expect(isSpecializedMuscle(muscle('sessions', 'specialize'))).toBe(false);
  });
});
