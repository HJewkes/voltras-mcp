// Wiring tests for the exercise-hero view (WA exact derivations → titan props).
//
// The contract: pass EXACT values into the titan prop shapes — the components
// round/band/format for display, so this layer must NOT pre-round. Where a prop
// wraps a WA derivation we assert it equals that derivation exactly.

import { describe, expect, it } from 'vitest';
import {
  bestE1RMAcrossSets,
  estimateSetRpe,
  getSetTempoSeconds,
  type Rep,
} from '@voltras/workout-analytics';

import {
  toExerciseE1RM,
  toExerciseSummary,
  toLiveTempoSeconds,
  toSetRowProps,
} from '../spa/panels/exercise-hero-view.js';
import type { WorkoutSetView } from '../spa/adapter.js';

/** Build a Rep whose concentric peak velocity (mm/s) is `peakMms`. */
function rep(repNumber: number, peakMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms },
    eccentric: {},
  } as unknown as Rep;
}

/**
 * A Rep carrying real phase timing (ms) so WA derives a non-null tempo tuple:
 * concentric movement 1.5 s (no hold), eccentric movement 2.5 s with a 0.5 s hold
 * at the bottom → `[ecc-move, ecc-hold, con-move, con-hold]` = `[2.5, 0.5, 1.5, 0]`.
 */
function repWithTempo(repNumber: number): Rep {
  return {
    repNumber,
    concentric: { startTime: 0, endTime: 1500, _totalHoldDuration: 0 },
    eccentric: { startTime: 2000, endTime: 5000, _totalHoldDuration: 500 },
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

describe('toLiveTempoSeconds', () => {
  function activeView(reps: Rep[]): WorkoutSetView {
    return {
      setNumber: 1,
      kind: 'active',
      reps,
      weightLbs: 135,
      targetReps: null,
      targetWeightLbs: null,
      previous: null,
    };
  }

  it('returns null when there is no active set', () => {
    expect(toLiveTempoSeconds(null)).toBeNull();
  });

  it('returns null when the active set has no reps yet', () => {
    expect(toLiveTempoSeconds(activeView([]))).toBeNull();
  });

  it('maps real Rep[] to the EXACT WA tempo tuple TempoDisplay expects', () => {
    const view = activeView([repWithTempo(1)]);
    const tempo = toLiveTempoSeconds(view);
    // [eccentric-move, pause-bottom, concentric-move, pause-top] seconds — exact.
    expect(tempo).toEqual([2.5, 0.5, 1.5, 0]);
    // Wiring contract: identical to WA's own derivation (no app-side reshaping).
    expect(tempo).toEqual(getSetTempoSeconds({ reps: view.reps }));
  });
});

describe('toExerciseE1RM', () => {
  it('leaves the badge undefined (and not a PR) for an empty active set', () => {
    const view: WorkoutSetView = {
      setNumber: 1,
      kind: 'active',
      reps: [],
      weightLbs: 135,
      targetReps: 8,
      targetWeightLbs: 135,
      previous: null,
    };
    expect(toExerciseE1RM([view], null)).toEqual({ e1rm: undefined, isPR: false });
  });

  it('passes the EXACT WA best-across-sets e1RM (lbs) and no PR without history', () => {
    const views = [
      completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { weightLbs: 100 }),
      completedView([rep(1, 800), rep(2, 700)], { setNumber: 2, weightLbs: 120 }),
    ];
    const expected = bestE1RMAcrossSets([
      { load: 100, reps: 3 },
      { load: 120, reps: 2 },
    ]);
    const { e1rm, isPR } = toExerciseE1RM(views, null);
    expect(e1rm).toEqual({ value: expected, unit: 'lbs' }); // exact — ExerciseCard rounds
    expect(isPR).toBe(false); // no historical baseline -> never a PR
  });

  it('flags a PR only when the live e1RM beats the prior historical best', () => {
    const views = [completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { weightLbs: 100 })];
    const live = bestE1RMAcrossSets([{ load: 100, reps: 3 }]) as number;
    expect(toExerciseE1RM(views, live - 1).isPR).toBe(true);
    expect(toExerciseE1RM(views, live + 1).isPR).toBe(false);
  });
});
