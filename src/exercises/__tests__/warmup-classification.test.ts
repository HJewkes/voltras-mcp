// Unit tests for the pure warm-up classification helpers.
//
// Pure functions over a structural exercise view — no catalog, no mocks. The
// fixtures mirror real seed entries so the classification stays honest against
// the shipped exercises (a real-seed smoke check lives in the PR verification).

import { describe, it, expect } from 'vitest';
import { warmupDemand, workedMuscles, type WarmupClassifiable } from '../warmup-classification.js';

function ex(overrides: Partial<WarmupClassifiable>): WarmupClassifiable {
  return {
    muscleGroups: ['chest'],
    movementPattern: 'push',
    exerciseType: 'compound',
    ...overrides,
  };
}

describe('warmupDemand', () => {
  it.each(['squat', 'hinge', 'push', 'pull'])(
    'compound through a big pattern (%s) → high',
    (movementPattern) => {
      expect(warmupDemand(ex({ exerciseType: 'compound', movementPattern }))).toBe('high');
    },
  );

  it.each(['lunge', 'carry', 'rotation'])(
    'compound through a smaller pattern (%s) → medium',
    (movementPattern) => {
      expect(warmupDemand(ex({ exerciseType: 'compound', movementPattern }))).toBe('medium');
    },
  );

  it('isolation → low regardless of movement pattern', () => {
    expect(warmupDemand(ex({ exerciseType: 'isolation', movementPattern: 'isolation' }))).toBe(
      'low',
    );
  });

  it('exerciseType wins over a big pattern: isolation tagged "pull" (face pull) → low', () => {
    expect(warmupDemand(ex({ exerciseType: 'isolation', movementPattern: 'pull' }))).toBe('low');
  });
});

describe('workedMuscles', () => {
  it('unions primary and secondary muscle groups', () => {
    const result = workedMuscles(
      ex({ muscleGroups: ['quads'], secondaryMuscleGroups: ['glutes', 'hamstrings', 'core'] }),
    );
    expect(result).toEqual(new Set(['quads', 'glutes', 'hamstrings', 'core']));
  });

  it('returns just the primary groups when there are no secondary groups', () => {
    const result = workedMuscles(
      ex({ muscleGroups: ['biceps'], secondaryMuscleGroups: undefined }),
    );
    expect(result).toEqual(new Set(['biceps']));
  });

  it('deduplicates a muscle listed as both primary and secondary', () => {
    const result = workedMuscles(
      ex({ muscleGroups: ['back'], secondaryMuscleGroups: ['back', 'biceps'] }),
    );
    expect([...result].sort()).toEqual(['back', 'biceps']);
  });
});
