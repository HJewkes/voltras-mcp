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
  toAutoRegStatus,
  toExerciseIsPR,
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
  it('maps a completed set to a `done` row with EXACT weight, velocity, and RPE', () => {
    const reps = [repWithMean(1, 800, 800), repWithMean(2, 600, 600)];
    const view = completedView(reps, { setNumber: 2, weightLbs: 100.4 });
    const props = toSetRowProps(view);

    expect(props.state).toBe('done');
    expect(props.setNumber).toBe(2);
    expect(props.unit).toBe('lbs');
    if (props.state !== 'done') throw new Error('expected a done row');
    expect(props.reps).toBe(2);
    expect(props.weight).toBe(100.4); // exact — SetRow rounds for display
    expect(props.velocities).toEqual([0.8, 0.6]); // mm/s → m/s, unrounded
    // RPE is exactly WA's value — not rounded to 0.5 at this layer.
    expect(props.rpe).toBe(estimateSetRpe({ reps }));
    expect(props.rpe).not.toBeNull();
  });

  it('maps an active set to a `live` row: reps-so-far + exact target', () => {
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
    expect(props.state).toBe('live');
    if (props.state !== 'live') throw new Error('expected a live row');
    expect(props.reps).toBe(0); // no reps yet — the row displays the target
    expect(props.weight).toBe(135);
    expect(props.target).toEqual({ reps: 8, weight: 134.5 }); // exact
    expect(props.velocities).toEqual([]);
  });

  it('falls a `live` row target back to reps-done + working weight when unplanned', () => {
    const view: WorkoutSetView = {
      setNumber: 1,
      kind: 'active',
      reps: [rep(1, 800)],
      weightLbs: 135,
      targetReps: null,
      targetWeightLbs: null,
      previous: null,
    };
    const props = toSetRowProps(view);
    if (props.state !== 'live') throw new Error('expected a live row');
    expect(props.reps).toBe(1);
    expect(props.target).toEqual({ reps: 1, weight: 135 }); // fallback: reps-done + weight
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

describe('toAutoRegStatus', () => {
  // The coaching auto-reg boundaries shared by StatusPill + LiveAuraFrame +
  // FatigueMeter, on the canonical VL20/VL30 bands: <20 productive, 20–30
  // threshold, 30+ stop. These MUST match `verdictFromLoss` (live-page/model.ts)
  // so the live pill and the rest-view aura never disagree. Lock the edges.
  it('is null when loss is not yet derivable', () => {
    expect(toAutoRegStatus(null)).toBeNull();
  });

  it('is productive below VL20', () => {
    expect(toAutoRegStatus(0)).toBe('productive');
    expect(toAutoRegStatus(19.9)).toBe('productive');
  });

  it('is threshold from VL20 up to (not including) VL30', () => {
    expect(toAutoRegStatus(20)).toBe('threshold');
    expect(toAutoRegStatus(28)).toBe('threshold');
    expect(toAutoRegStatus(29.9)).toBe('threshold');
  });

  it('is stop at VL30 and above', () => {
    expect(toAutoRegStatus(30)).toBe('stop');
    expect(toAutoRegStatus(45)).toBe('stop');
  });
});

describe('toExerciseIsPR', () => {
  // titan 0.7.0's unified ExerciseCard dropped the numeric e1RM badge; the
  // dashboard keeps PR *detection* (the `isPR` chip) off the same WA estimate.
  it('is not a PR for an empty active set', () => {
    const view: WorkoutSetView = {
      setNumber: 1,
      kind: 'active',
      reps: [],
      weightLbs: 135,
      targetReps: 8,
      targetWeightLbs: 135,
      previous: null,
    };
    expect(toExerciseIsPR([view], null)).toBe(false);
  });

  it('is not a PR without a historical baseline', () => {
    const views = [
      completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { weightLbs: 100 }),
      completedView([rep(1, 800), rep(2, 700)], { setNumber: 2, weightLbs: 120 }),
    ];
    expect(toExerciseIsPR(views, null)).toBe(false); // no baseline -> never a PR
  });

  it('flags a PR only when the live e1RM beats the prior historical best', () => {
    const views = [completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { weightLbs: 100 })];
    const live = bestE1RMAcrossSets([{ load: 100, reps: 3 }]) as number;
    expect(toExerciseIsPR(views, live - 1)).toBe(true);
    expect(toExerciseIsPR(views, live + 1)).toBe(false);
  });
});
