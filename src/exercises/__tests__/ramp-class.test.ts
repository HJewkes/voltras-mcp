import * as analytics from '@voltras/workout-analytics';
import { beforeEach, describe, expect, it } from 'vitest';

import { rampClassForExerciseId, rampClassOf } from '../ramp-class.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

describe('rampClassOf', () => {
  it('reads any isolation-typed exercise as isolation, whatever its pattern', () => {
    expect(rampClassOf({ exerciseType: 'isolation', movementPattern: 'pull' })).toBe('isolation');
  });

  it('reads a squat or hinge compound as lower body', () => {
    expect(rampClassOf({ exerciseType: 'compound', movementPattern: 'squat' })).toBe(
      'lower_compound',
    );
    expect(rampClassOf({ exerciseType: 'compound', movementPattern: 'hinge' })).toBe(
      'lower_compound',
    );
  });

  it('reads every other compound as upper body', () => {
    for (const movementPattern of ['push', 'pull', 'rotation']) {
      expect(rampClassOf({ exerciseType: 'compound', movementPattern })).toBe('upper_compound');
    }
  });

  it('reads a missing row as the unknown-class default', () => {
    expect(rampClassOf(undefined)).toBe('upper_compound');
  });
});

describe('rampClassForExerciseId', () => {
  beforeEach(() => {
    (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(
      SEED_CABLE_EXERCISES,
    );
  });

  it('places the seed catalog lifts', () => {
    expect(rampClassForExerciseId('cable-overhead-tricep-extension')).toBe('isolation');
    expect(rampClassForExerciseId('cable-face-pull')).toBe('isolation');
    expect(rampClassForExerciseId('cable-chest-press')).toBe('upper_compound');
    expect(rampClassForExerciseId('cable-romanian-deadlift')).toBe('lower_compound');
  });

  it('reads an absent or uncatalogued id as the unknown-class default', () => {
    expect(rampClassForExerciseId(null)).toBe('upper_compound');
    expect(rampClassForExerciseId('not-in-the-catalog')).toBe('upper_compound');
  });
});
