// The read-model invariant of VW-422: no in-block reading sits in a later block week than
// `currentWeek`. The check logs and never changes what is plotted.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  goalReadingWeekViolations,
  mesoMilestoneOf,
  type BlockReading,
  type MesoMilestoneInput,
} from '../read-models/goal-milestone.js';
import { deriveGoalBand } from '../../analytics/goal-band.js';
import { log } from '../../logger.js';
import type { StoredGoalTarget } from '../../store/types.js';

const START = '2026-08-03T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = [1, 2, 3, 4].map((index) => ({ index, isDeload: false }));

const TARGET: StoredGoalTarget = {
  id: 'tgt-bench',
  priorityId: 'pri-bench',
  metric: 'top_load_at_reps',
  exerciseId: 'bench-press',
  anchorReps: 8,
  startValue: 170,
  startMeasuredAt: START,
  bandLowPctPerWeek: 1.5,
  bandHighPctPerWeek: 3,
  committedValue: 180,
  stretchValue: 190,
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  tierUsed: 'early-intermediate',
  tierProvisional: false,
  dietPhaseAtDerivation: 'maintenance',
  acceptedBy: 'user',
  acknowledgedStretch: false,
  derivedAt: START,
  endsAt: '2026-08-31T00:00:00.000Z',
};

function reading(week: number): BlockReading {
  return { value: 170 + week, position: week - 1 };
}

function milestoneInput(readings: BlockReading[], nowWeek: number): MesoMilestoneInput {
  const band = deriveGoalBand({
    metric: 'top_load_at_reps',
    startValue: 170,
    horizonWeeks: 4,
    weeks: WEEKS,
    tier: 'intermediate',
    infoLevel: 'ramp',
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    layoff: false,
    matchedSessionCount: 6,
    baselineState: 'CALIBRATED',
    completedMesoCount: 1,
  });
  return {
    target: TARGET,
    weekOneAt: START,
    band,
    weeks: WEEKS,
    readings,
    now: new Date(Date.parse(START) + ((nowWeek - 1) * 7 + 1) * DAY_MS).toISOString(),
    reach: null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('goalReadingWeekViolations', () => {
  it('returns a reading placed in a block week after the current week', () => {
    const late = reading(4);

    expect(goalReadingWeekViolations([reading(1), late], 3)).toEqual([late]);
  });

  it('passes readings before the current week and one in the current week itself', () => {
    expect(goalReadingWeekViolations([reading(1), reading(2), reading(3)], 3)).toEqual([]);
  });

  it('ignores a reading taken before week one, which never enters the block readings', () => {
    expect(goalReadingWeekViolations([], 1)).toEqual([]);
  });
});

describe('mesoMilestoneOf invariant', () => {
  it('logs once and still reports the latest reading when one is past the current week', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    const milestone = mesoMilestoneOf(milestoneInput([reading(2), reading(4)], 3));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(milestone.latest?.value).toBe(174);
  });

  it('stays silent when the newest reading sits in the current week', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    mesoMilestoneOf(milestoneInput([reading(2), reading(3)], 3));

    expect(warn).not.toHaveBeenCalled();
  });
});
