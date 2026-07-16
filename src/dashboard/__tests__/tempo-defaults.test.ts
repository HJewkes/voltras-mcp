// Unit tests for the target-tempo resolver (VW-41).
//
// The tuple order is the easiest bug to ship: everywhere at this boundary it is
// [eccentric, pauseBottom, concentric, pauseTop] (seconds), matching WA's
// getSetTempoSeconds. These tests pin that order explicitly and cover the three
// resolution branches: coach override → exercise default → none.

import { describe, expect, it } from 'vitest';

import {
  resolveExerciseDefaultTempo,
  resolveTargetTempo,
  type TempoTuple,
} from '../tempo-defaults.js';

describe('resolveExerciseDefaultTempo', () => {
  it('returns the per-exercise override, in [ecc, pauseBottom, con, pauseTop] order', () => {
    // cable_hip_thrust is a §3d override with a distinct value in every slot, so a
    // transposed tuple would fail this — it is the order-guard.
    expect(resolveExerciseDefaultTempo('cable_hip_thrust')).toEqual([2, 1, 1, 2]);
  });

  it('prefers the per-exercise override over the movement-pattern default', () => {
    // cable_fly overrides the generic isolation default ([2,0,2,1]).
    expect(resolveExerciseDefaultTempo('cable_fly', 'isolation')).toEqual([3, 1, 1, 1]);
  });

  it('falls back to the movement-pattern default when no override exists', () => {
    expect(resolveExerciseDefaultTempo('cable_bench_press', 'push')).toEqual([3, 0, 1, 0]);
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
    // Even though cable_fly has an override, the coach value takes precedence.
    expect(resolveTargetTempo('cable_fly', coach, 'isolation')).toEqual([4, 2, 1, 0]);
  });

  it('uses the exercise default when no coach tempo is set', () => {
    expect(resolveTargetTempo('cable_lateral_raise', undefined, 'isolation')).toEqual([3, 0, 1, 1]);
  });

  it('falls back to the movement-pattern default when no override and no coach tempo', () => {
    expect(resolveTargetTempo('cable_row', undefined, 'pull')).toEqual([2, 0, 1, 1]);
  });

  it('returns null when neither coach tempo nor any default resolves', () => {
    expect(resolveTargetTempo('mystery_lift', undefined, undefined)).toBeNull();
  });
});
