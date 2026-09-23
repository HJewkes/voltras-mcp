// Unit tests for the rest-timer defaults module (VW-297): `timer.start`'s
// intent-default resolution and reps-to-VL-threshold extension both compose
// these three pure functions, so these tests cover the rules themselves
// rather than the tool wiring (see `timer-tools.test.ts` for that).

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import {
  DEFAULT_REST_SECONDS,
  HYPERTROPHY_REST_SECONDS,
  MAX_REST_EXTENSION_SECONDS,
  REST_EXTENSION_STEP_SECONDS,
  STRENGTH_REST_SECONDS,
  defaultRestSeconds,
  repsToVelocityLossThreshold,
  resolveRestLength,
  restExtensionSeconds,
} from '../rest-defaults.js';

describe('defaultRestSeconds', () => {
  it('is >=120s for strength', () => {
    expect(defaultRestSeconds('strength')).toBe(STRENGTH_REST_SECONDS);
    expect(defaultRestSeconds('strength')).toBeGreaterThanOrEqual(120);
  });

  it('is 90-120s for hypertrophy', () => {
    const rest = defaultRestSeconds('hypertrophy');
    expect(rest).toBe(HYPERTROPHY_REST_SECONDS);
    expect(rest).toBeGreaterThanOrEqual(90);
    expect(rest).toBeLessThanOrEqual(120);
  });

  it('falls to the named default for an intent it does not special-case', () => {
    expect(defaultRestSeconds('power')).toBe(DEFAULT_REST_SECONDS);
  });

  it('falls to the named default when no intent is known', () => {
    expect(defaultRestSeconds(undefined)).toBe(DEFAULT_REST_SECONDS);
  });
});

describe('restExtensionSeconds', () => {
  it('extends when reps-to-threshold dropped versus the prior set', () => {
    expect(restExtensionSeconds(6, 5)).toBe(REST_EXTENSION_STEP_SECONDS);
  });

  it('scales the extension with the size of the drop, bounded', () => {
    expect(restExtensionSeconds(8, 4)).toBe(
      Math.min(MAX_REST_EXTENSION_SECONDS, 4 * REST_EXTENSION_STEP_SECONDS),
    );
    expect(restExtensionSeconds(8, 4)).toBeLessThanOrEqual(MAX_REST_EXTENSION_SECONDS);
  });

  it('does not extend when reps-to-threshold held steady', () => {
    expect(restExtensionSeconds(6, 6)).toBe(0);
  });

  it('does not extend when reps-to-threshold grew', () => {
    expect(restExtensionSeconds(5, 7)).toBe(0);
  });

  it('does not extend when either set never reached its threshold', () => {
    expect(restExtensionSeconds(null, 5)).toBe(0);
    expect(restExtensionSeconds(6, null)).toBe(0);
    expect(restExtensionSeconds(null, null)).toBe(0);
  });

  // Mutation to report: hard-coding this function to always `return 0` fails
  // exactly this test — the only one that requires a positive result.
  it('returns a positive extension for a genuine drop', () => {
    expect(restExtensionSeconds(6, 5)).toBeGreaterThan(0);
  });
});

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/**
 * `_movementSampleCount: 1` on every rep, matching `report-weekly-tools.test.ts`'s
 * fixture: below `selectEligibleReps`' 2-sample floor, so every rep reads as
 * unmeasurable and the eligibility filter falls back to the untouched list —
 * these tests exercise the threshold walk, not the outlier gate.
 */
function makeRep(repNumber: number, peakVelocity: number): Rep {
  return {
    repNumber,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity,
      _totalVelocity: peakVelocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

function repsOf(velocities: number[]): Rep[] {
  return velocities.map((v, i) => makeRep(i + 1, v));
}

describe('repsToVelocityLossThreshold', () => {
  it('returns the 1-indexed rep at which loss first reaches the threshold', () => {
    // Baseline 1.0: rep4 is the first at >=20% loss (0.79 -> 21%).
    const reps = repsOf([1.0, 0.95, 0.88, 0.79, 0.7]);
    expect(repsToVelocityLossThreshold(reps, 20)).toBe(4);
  });

  it('returns null when the set never reaches the threshold', () => {
    const reps = repsOf([1.0, 0.98, 0.96, 0.95]);
    expect(repsToVelocityLossThreshold(reps, 30)).toBeNull();
  });

  it('returns null for an empty rep list', () => {
    expect(repsToVelocityLossThreshold([], 20)).toBeNull();
  });

  it('a lower reps-to-threshold count reflects faster fatigue set-over-set', () => {
    const steady = repsOf([1.0, 0.95, 0.9, 0.85, 0.8, 0.68, 0.6, 0.55]);
    const faster = repsOf([1.0, 0.92, 0.85, 0.78, 0.68]);
    const prev = repsToVelocityLossThreshold(steady, 30);
    const curr = repsToVelocityLossThreshold(faster, 30);
    expect(prev).toBe(6);
    expect(curr).toBe(5);
    expect(curr).toBeLessThan(prev!);
  });
});

describe('resolveRestLength (VW-441)', () => {
  // Hypertrophy (VL30): the first set crosses at rep 6, the second at rep 5, a one-rep drop.
  const dropping = [
    { reps: repsOf([1.0, 0.95, 0.9, 0.85, 0.8, 0.68, 0.6]) },
    { reps: repsOf([1.0, 0.92, 0.85, 0.78, 0.68]) },
  ];

  it('takes a coach-set rest as-is and never extends it', () => {
    const rest = resolveRestLength({
      planned: { restSec: 90, trainingIntent: 'hypertrophy' },
      exerciseSets: dropping,
    });
    expect(rest).toMatchObject({ seconds: 90, source: 'explicit_plan', extensionSeconds: 0 });
  });

  it('uses the intent default when the plan names no rest', () => {
    const rest = resolveRestLength({ planned: { trainingIntent: 'strength' }, exerciseSets: [] });
    expect(rest).toMatchObject({ seconds: STRENGTH_REST_SECONDS, source: 'intent_default' });
  });

  it('extends the intent default when reps to threshold dropped', () => {
    const rest = resolveRestLength({
      planned: { trainingIntent: 'hypertrophy' },
      exerciseSets: dropping,
    });
    expect(rest).toEqual({
      seconds: HYPERTROPHY_REST_SECONDS + REST_EXTENSION_STEP_SECONDS,
      source: 'intent_default_extended',
      intent: 'hypertrophy',
      prevRepsToThreshold: 6,
      currRepsToThreshold: 5,
      extensionSeconds: REST_EXTENSION_STEP_SECONDS,
    });
  });

  it('gives an unplanned exercise the 120 s default with no intent', () => {
    const rest = resolveRestLength({ planned: undefined, exerciseSets: [] });
    expect(rest).toMatchObject({ seconds: 120, source: 'intent_default', intent: null });
  });
});
