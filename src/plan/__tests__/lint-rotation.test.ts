import { describe, expect, it } from 'vitest';

import { lintBeginnerRotation } from '../lint-rotation.js';

const PREVIOUS = ['squat', 'bench', 'row', 'press'];

describe('lintBeginnerRotation', () => {
  it('flags a beginner block that rotates half its exercises', () => {
    const warnings = lintBeginnerRotation({
      previousBlockExerciseIds: PREVIOUS,
      blockExerciseIds: ['squat', 'bench', 'lunge', 'fly'],
      tier: 'beginner',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'beginner_rotation_over_quarter',
      observed: 50,
      ceiling: 25,
    });
  });

  it('lets a beginner rotate exactly a quarter', () => {
    const warnings = lintBeginnerRotation({
      previousBlockExerciseIds: PREVIOUS,
      blockExerciseIds: ['squat', 'bench', 'row', 'fly'],
      tier: 'beginner',
    });

    expect(warnings).toEqual([]);
  });

  it('leaves an intermediate lifter free to rotate', () => {
    const warnings = lintBeginnerRotation({
      previousBlockExerciseIds: PREVIOUS,
      blockExerciseIds: ['lunge', 'fly', 'pulldown', 'raise'],
      tier: 'intermediate',
    });

    expect(warnings).toEqual([]);
  });

  it('says nothing about a first block, which has nothing to rotate from', () => {
    const warnings = lintBeginnerRotation({
      previousBlockExerciseIds: [],
      blockExerciseIds: ['lunge', 'fly'],
      tier: 'beginner',
    });

    expect(warnings).toEqual([]);
  });

  it('counts an exercise planned on several days once', () => {
    const warnings = lintBeginnerRotation({
      previousBlockExerciseIds: PREVIOUS,
      blockExerciseIds: ['squat', 'squat', 'bench', 'row', 'fly', 'fly'],
      tier: 'beginner',
    });

    expect(warnings).toEqual([]);
  });
});
