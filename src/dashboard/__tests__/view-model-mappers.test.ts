// Unit tests for the shared workout view-model mappers (VMCP-01.52, Track 2).
//
// These map canonical `WorkoutSetView`s onto titan-design component props and
// own the WA-derived RPE / per-rep velocity math that BOTH the dashboard and the
// mobile app will share. Pure logic, node environment.

import { describe, expect, it } from 'vitest';
import { estimateE1RMFromReps, type Rep } from '@voltras/workout-analytics';

import {
  deriveExerciseE1RM,
  deriveRpe,
  toExerciseSummary,
  toSetRowProps,
  type WorkoutSetView,
} from '../spa/view-model/mappers.js';

/** Build a Rep whose concentric peak velocity (mm/s) is `peakMms`. */
function rep(repNumber: number, peakMms: number): Rep {
  return {
    repNumber,
    concentric: { peakVelocity: peakMms },
    eccentric: {},
  } as unknown as Rep;
}

/** Build a Rep carrying the concentric movement-sample aggregates WA needs for
    mean velocity (so velocity-loss / RIR come out deterministically). */
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

describe('deriveExerciseE1RM', () => {
  it('returns the best (max) e1RM across the exercise sets, rounded', () => {
    const light = completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { weightLbs: 100 });
    const heavy = completedView([rep(1, 800), rep(2, 700), rep(3, 650), rep(4, 600), rep(5, 550)], {
      weightLbs: 100,
    });
    // 5 reps yields a higher rep-based e1RM than 3 at the same load.
    const expected = Math.round(estimateE1RMFromReps(100, 5).e1RM);
    expect(deriveExerciseE1RM([light, heavy])).toEqual({ value: expected, unit: 'lbs' });
  });

  it('is null when no set has both a weight and at least one rep', () => {
    expect(deriveExerciseE1RM([])).toBeNull();
    expect(deriveExerciseE1RM([completedView([], { weightLbs: 100 })])).toBeNull();
    expect(deriveExerciseE1RM([completedView([rep(1, 800)], { weightLbs: null })])).toBeNull();
  });
});

describe('deriveRpe', () => {
  it('derives a nearest-0.5 RPE (0–10) from real velocity loss', () => {
    // (800 → 600) mean velocity across two reps = 25% loss → estimable RPE.
    const rpe = deriveRpe([repWithMean(1, 800, 800), repWithMean(2, 600, 600)]);
    expect(rpe).not.toBeNull();
    expect((rpe as number) % 0.5).toBe(0);
    expect(rpe as number).toBeGreaterThanOrEqual(0);
    expect(rpe as number).toBeLessThanOrEqual(10);
  });

  it('returns null when reps carry no movement samples (avoids the RPE-10 floor)', () => {
    expect(deriveRpe([rep(1, 900), rep(2, 800)])).toBeNull();
  });

  it('returns null for a single-rep set (loss needs ≥2 reps)', () => {
    expect(deriveRpe([repWithMean(1, 800, 800)])).toBeNull();
  });
});

describe('toSetRowProps', () => {
  it('maps a completed set: count, rounded weight, velocities, RPE, PREV', () => {
    const view = completedView([repWithMean(1, 800, 800), repWithMean(2, 600, 600)], {
      setNumber: 2,
      weightLbs: 100.4,
      previous: { reps: 8, weightLbs: 95.6 },
    });
    const props = toSetRowProps(view);
    expect(props.mode).toBe('completed');
    expect(props.setNumber).toBe(2);
    expect(props.reps).toBe(2);
    expect(props.weight).toBe(100); // rounded
    expect(props.unit).toBe('lbs');
    expect(props.velocities).toEqual([0.8, 0.6]);
    expect(props.rpe).not.toBeNull();
    expect(props.previous).toEqual({ reps: 8, weight: 96 }); // rounded
    expect(props.isNextSet).toBe(false);
    expect(props.targets).toBeUndefined();
  });

  it('maps an active set: null reps until first rep, isNextSet, targets', () => {
    const view: WorkoutSetView = {
      setNumber: 3,
      kind: 'active',
      reps: [],
      weightLbs: 135,
      targetReps: 8,
      targetWeightLbs: 135,
      previous: null,
    };
    const props = toSetRowProps(view);
    expect(props.mode).toBe('active');
    expect(props.reps).toBeNull(); // no reps yet
    expect(props.isNextSet).toBe(true);
    expect(props.targets).toEqual({ reps: 8, weight: 135 });
    expect(props.velocities).toBeUndefined();
  });

  it('omits targets on an active set with no configured target', () => {
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

  it('falls back to the last set actuals when no target is configured', () => {
    const views: WorkoutSetView[] = [
      completedView([rep(1, 800), rep(2, 700), rep(3, 650)], { setNumber: 1, weightLbs: 120.6 }),
    ];
    expect(toExerciseSummary(views, null)).toEqual({ sets: 1, reps: 3, weight: 121, unit: 'lbs' });
  });

  it('is zeroed when there are no sets', () => {
    expect(toExerciseSummary([], null)).toEqual({ sets: 0, reps: 0, weight: 0, unit: 'lbs' });
  });
});
