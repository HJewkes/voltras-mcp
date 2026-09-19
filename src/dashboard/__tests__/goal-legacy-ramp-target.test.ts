// A target accepted under the pre-VW-482 ramp keeps its stored numbers
// (GOAL_TARGET_FIXED), while the page re-derives its band in frame under the
// per-class ramp. For the 40 lb cable overhead tricep extension that opened
// VW-482 the old ramp stored 57.5 and the new band ends at 44.2. This pins
// what the page does with that pair.

import { describe, expect, it } from 'vitest';

import {
  buildGoalProgressView,
  type GoalActual,
  type GoalProgressInput,
} from '../read-models/goal-progress.js';
import {
  deriveGoalBand,
  type GoalBandWeek,
  type GoalInfoLevel,
} from '../../analytics/goal-band.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-03T00:00:00.000Z';
const WEEKS: GoalBandWeek[] = Array.from({ length: 8 }, (_, i) => ({
  index: i + 1,
  isDeload: false,
}));

function tsInWeek(weekIndex: number): string {
  return new Date(Date.parse(START) + ((weekIndex - 1) * 7 + 1) * DAY_MS).toISOString();
}

const PRIORITY: StoredPriority = {
  id: 'pri-triceps',
  userId: 'u1',
  horizonWeeks: 8,
  kind: 'lift',
  ref: 'cable-overhead-tricep-extension',
  level: 'specialize',
  declaredAt: START,
  mesosHeld: 1,
};

/** Accepted cold under the old ramp: 7 steps of its 2.5 lb floor from 40 lb. */
const OLD_RAMP_TARGET: StoredGoalTarget = {
  id: 'tgt-triceps',
  priorityId: PRIORITY.id,
  metric: 'top_load_at_reps',
  exerciseId: 'cable-overhead-tricep-extension',
  anchorReps: 12,
  startValue: 40,
  startMeasuredAt: START,
  bandLowPctPerWeek: 6.25,
  bandHighPctPerWeek: 6.25,
  committedValue: 57.5,
  stretchValue: 57.5,
  basis: 'execution_ramp',
  infoLevel: 'cold',
  tierUsed: 'intermediate',
  tierProvisional: false,
  dietPhaseAtDerivation: 'maintenance',
  acceptedBy: 'user',
  acknowledgedStretch: false,
  derivedAt: START,
  endsAt: new Date(Date.parse(START) + 8 * 7 * DAY_MS).toISOString(),
};

function bandToday(calibrated: boolean) {
  const infoLevel: GoalInfoLevel = calibrated ? 'ramp' : 'cold';
  return deriveGoalBand({
    metric: 'top_load_at_reps',
    startValue: 40,
    horizonWeeks: 8,
    weeks: WEEKS,
    tier: 'intermediate',
    rampClass: 'isolation',
    infoLevel,
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    layoff: false,
    matchedSessionCount: calibrated ? 6 : 1,
    baselineState: calibrated ? 'CALIBRATED' : 'COLD',
    completedMesoCount: 0,
  });
}

/** A lifter who climbs the new ramp exactly, a reading every week up to `throughWeek`. */
function onTheNewRamp(throughWeek: number): GoalActual[] {
  return Array.from({ length: throughWeek }, (_, i) => ({
    ts: tsInWeek(i + 1),
    value: 40 + 0.6 * i,
    matched: true,
    isPR: false,
  }));
}

function view(calibrated: boolean, now: string, actuals: GoalActual[]) {
  const input: GoalProgressInput = {
    priority: PRIORITY,
    target: OLD_RAMP_TARGET,
    band: bandToday(calibrated),
    calibrationEvidence: calibrated
      ? { matchedSessionCount: 6, baselineState: 'CALIBRATED' }
      : { matchedSessionCount: 1, baselineState: 'COLD' },
    actuals,
    weeks: WEEKS,
    now,
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
  };
  return buildGoalProgressView(input);
}

describe('a target accepted under the old ramp, read under the class ramp', () => {
  it('draws the new band under the stored goal line, which stays at 57.5', () => {
    const page = view(true, tsInWeek(4), onTheNewRamp(4));

    expect(page.committed).toBe(57.5);
    expect(page.expected[page.expected.length - 1]).toEqual({
      weekIndex: 8,
      low: 42.1,
      high: 44.2,
    });
    expect(page.mesoMilestone.target).toMatchObject({ reps: 12, load: 58 });
  });

  it('reads on_track week by week while the lifter follows the new band', () => {
    expect(view(true, tsInWeek(4), onTheNewRamp(4)).status).toBe('on_track');
  });

  it('offers the recalibrated target once calibration ends', () => {
    expect(view(true, tsInWeek(4), onTheNewRamp(4)).recalibration).toEqual({ state: 'offered' });
  });

  it('stays calibrating, with no offer, before calibration ends', () => {
    const page = view(false, tsInWeek(2), onTheNewRamp(2));

    expect(page.status).toBe('calibrating');
    expect(page.recalibration).toBeUndefined();
  });

  it('misses the stored goal at the block boundary though every week was on the band', () => {
    const page = view(true, tsInWeek(9), onTheNewRamp(8));

    expect(page.weekOutcomes.every((week) => week.outcome !== 'missed')).toBe(true);
    expect(page.mesoMilestone.state).toBe('missed');
  });
});
