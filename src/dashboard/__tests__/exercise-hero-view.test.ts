// Wiring tests for the exercise-hero view (WA exact derivations → titan props).
//
// The contract: pass EXACT values into the titan prop shapes — the components
// round/band/format for display, so this layer must NOT pre-round. Where a prop
// wraps a WA derivation we assert it equals that derivation exactly.

import { describe, expect, it } from 'vitest';
import { estimateSetRpe, type Rep } from '@voltras/workout-analytics';

import { toExerciseSummary, toSetRowProps } from '../spa/panels/exercise-hero-view.js';
import type { WorkoutSetView } from '../spa/adapter.js';

/** Build a Rep whose concentric peak velocity (mm/s) is `peakMms`. */
function rep(repNumber: number, peakMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms },
    eccentric: {},
  } as unknown as Rep;
}

/** A Rep carrying the concentric aggregates WA needs for a deterministic RIR. */
function repWithMean(repNumber: number, peakMms: number, meanMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms, _totalVelocity: meanMms, _movementSampleCount: 1 },
    eccentric: {},
  } as unknown as Rep;
}

function completedView(reps: Rep[], over: Partial<WorkoutSetView> = {}): WorkoutSetView {
  return {
    setNumber: 1,
    kind: 'completed',
    reps,
    weightLbs: 100,
    targetReps: null,
    targetWeightLbs: null,
    previous: null,
    ...over,
  };
}

describe('toSetRowProps', () => {
  it('passes EXACT weight, previous, velocity, and RPE (no pre-rounding)', () => {
    const reps = [repWithMean(1, 800, 800), repWithMean(2, 600, 600)];
    const view = completedView(reps, {
      setNumber: 2,
      weightLbs: 100.4,
      previous: { reps: 8, weightLbs: 95.6 },
    });
    const props = toSetRowProps(view);

    expect(props.mode).toBe('completed');
    expect(props.setNumber).toBe(2);
    expect(props.reps).toBe(2);
    expect(props.weight).toBe(100.4); // exact — SetRow rounds for display
    expect(props.unit).toBe('lbs');
    expect(props.velocities).toEqual([0.8, 0.6]); // mm/s → m/s, unrounded
    expect(props.previous).toEqual({ reps: 8, weight: 95.6 }); // exact
    // RPE is exactly WA's value — not rounded to 0.5 at this layer.
    expect(props.rpe).toBe(estimateSetRpe({ reps }));
    expect(props.rpe).not.toBeNull();
    expect(props.isNextSet).toBe(false);
    expect(props.targets).toBeUndefined();
  });

  it('maps an active set: null reps until first rep, isNextSet, exact targets', () => {
    const view: WorkoutSetView = {
      setNumber: 3,
      kind: 'active',
      reps: [],
      weightLbs: 135,
      targetReps: 8,
      targetWeightLbs: 134.5,
      previous: null,
    };
    const props = toSetRowProps(view);
    expect(props.mode).toBe('active');
    expect(props.reps).toBeNull();
    expect(props.isNextSet).toBe(true);
    expect(props.targets).toEqual({ reps: 8, weight: 134.5 }); // exact
    expect(props.velocities).toBeUndefined();
  });

  it('omits targets on an active set with no configured rep target', () => {
    const view: WorkoutSetView = {
      setNumber: 1,
      kind: 'active',
      reps: [rep(1, 800)],
      weightLbs: 135,
      targetReps: null,
      targetWeightLbs: 135,
      previous: null,
    };
    expect(toSetRowProps(view).targets).toBeUndefined();
    expect(toSetRowProps(view).reps).toBe(1);
  });
});

describe('toExerciseSummary', () => {
  it('counts completed sets and uses the active rep target for reps', () => {
    const views: WorkoutSetView[] = [
      completedView([rep(1, 800)], { setNumber: 1, weightLbs: 100 }),
      completedView([rep(1, 800)], { setNumber: 2, weightLbs: 100 }),
      {
        setNumber: 3,
        kind: 'active',
        reps: [],
        weightLbs: 105,
        targetReps: 8,
        targetWeightLbs: 105,
        previous: null,
      },
    ];
    expect(toExerciseSummary(views, 8)).toEqual({ sets: 2, reps: 8, weight: 105, unit: 'lbs' });
  });

  it('falls back to the last set actuals (EXACT weight) when no target is set', () => {
    const views: WorkoutSetView[] = [
      completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { setNumber: 1, weightLbs: 120.6 }),
    ];
    // Exact 120.6 — ExerciseCard rounds it for display, not this layer.
    expect(toExerciseSummary(views, null)).toEqual({
      sets: 1,
      reps: 3,
      weight: 120.6,
      unit: 'lbs',
    });
  });

  it('is zeroed when there are no sets', () => {
    expect(toExerciseSummary([], null)).toEqual({ sets: 0, reps: 0, weight: 0, unit: 'lbs' });
  });
});
