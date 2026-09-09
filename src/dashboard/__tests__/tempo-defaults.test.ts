// Unit tests for the target-tempo resolver (VW-41).
//
// The tuple order is the easiest bug to ship: everywhere at this boundary it is
// [eccentric, pauseBottom, concentric, pauseTop] (seconds), matching WA's
// getSetTempoSeconds. These tests pin that order explicitly and cover the three
// resolution branches: coach override → exercise default → none.

import { describe, expect, it, beforeAll } from 'vitest';
import { setCatalog, getExerciseById } from '@voltras/workout-analytics';

import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import { ExerciseService } from '../../exercises/exercise-service.js';
import {
  byExercise,
  resolveExerciseDefaultTempo,
  resolveTargetTempo,
  type TempoTuple,
} from '../tempo-defaults.js';

describe('resolveExerciseDefaultTempo', () => {
  it('returns the per-exercise override, in [ecc, pauseBottom, con, pauseTop] order', () => {
    // cable-crunch is a §3d override with a distinct value in every slot, so a
    // transposed tuple would fail this — it is the order-guard.
    expect(resolveExerciseDefaultTempo('cable-crunch')).toEqual([2, 0, 2, 1]);
  });

  it('prefers the per-exercise override over the movement-pattern default', () => {
    // cable-chest-fly overrides the generic isolation default ([2,0,2,1]).
    expect(resolveExerciseDefaultTempo('cable-chest-fly', 'isolation')).toEqual([3, 1, 1, 1]);
  });

  it('falls back to the movement-pattern default when no override exists', () => {
    expect(resolveExerciseDefaultTempo('cable-chest-press', 'push')).toEqual([3, 0, 1, 0]);
  });

  it('returns null for an unknown exercise with no movement pattern', () => {
    expect(resolveExerciseDefaultTempo('mystery_lift')).toBeNull();
  });

  it('returns null for a movement pattern with no default (carry)', () => {
    expect(resolveExerciseDefaultTempo('cable_farmer_carry', 'carry')).toBeNull();
  });

  it('returns null for an unrecognized movement pattern', () => {
    expect(resolveExerciseDefaultTempo('odd_lift', 'levitation')).toBeNull();
  });
});

describe('resolveTargetTempo', () => {
  it('uses the coach-set tempo when present (branch 1 wins over the default)', () => {
    const coach: TempoTuple = [4, 2, 1, 0];
    // Even though cable-chest-fly has an override, the coach value takes precedence.
    expect(resolveTargetTempo('cable-chest-fly', coach, 'isolation')).toEqual([4, 2, 1, 0]);
  });

  it('uses the exercise default when no coach tempo is set', () => {
    expect(resolveTargetTempo('cable-lateral-raise', undefined, 'isolation')).toEqual([3, 0, 1, 1]);
  });

  it('falls back to the movement-pattern default when no override and no coach tempo', () => {
    expect(resolveTargetTempo('cable-row', undefined, 'pull')).toEqual([2, 0, 1, 1]);
  });

  it('returns null when neither coach tempo nor any default resolves', () => {
    expect(resolveTargetTempo('mystery_lift', undefined, undefined)).toBeNull();
  });
});

describe('byExercise keys vs the exercise catalog (VW-56)', () => {
  beforeAll(() => {
    setCatalog(SEED_CABLE_EXERCISES);
  });

  it('every byExercise key resolves to a real catalog entry', () => {
    const service = new ExerciseService();
    for (const id of Object.keys(byExercise)) {
      expect(service.getById(id), `${id} should resolve via ExerciseService.getById`).toBeDefined();
    }
  });

  it('a real catalog id resolves to its override tuple, not the pattern default', () => {
    // cable-lateral-raise's movementPattern is isolation, whose pattern default
    // ([2,0,2,1]) differs from the override ([3,0,1,1]) — a real discriminating case.
    const exercise = getExerciseById('cable-lateral-raise');
    expect(exercise).toBeDefined();
    expect(exercise!.movementPattern).toBe('isolation');
    const resolved = resolveExerciseDefaultTempo('cable-lateral-raise', exercise!.movementPattern);
    expect(resolved).toEqual(byExercise['cable-lateral-raise']);
    expect(resolved).not.toEqual([2, 0, 2, 1]);
  });
});
