// A maintenance bodyweight corridor read from both sides (VW-457): outside it
// reads `behind` with the side it left by, inside it reads on track, and the
// block verdict is judged in the final week off the latest reading.
//
// Pure shaping only: a literal ±2% corridor around 180 lb and a caller-supplied `now`.

import { describe, expect, it } from 'vitest';

import {
  buildGoalProgressView,
  type GoalActual,
  type GoalProgressInput,
} from '../read-models/goal-progress.js';
import type { GoalBand, GoalBandWeek } from '../../analytics/goal-band.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-03T00:00:00.000Z';
const [LOW, HIGH] = [176.4, 183.6];

function tsInWeek(weekIndex: number, day = 1): string {
  return new Date(Date.parse(START) + ((weekIndex - 1) * 7 + day) * DAY_MS).toISOString();
}

const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6].map((index) => ({ index, isDeload: false }));

const CORRIDOR: GoalBand = {
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  bandLowPctPerWeek: 0,
  bandHighPctPerWeek: 0,
  corridorPct: 2,
  expected: WEEKS.map((week) => ({ weekIndex: week.index, low: LOW, high: HIGH })),
  committedValue: LOW,
  stretchValue: HIGH,
  direction: 'hold',
  provisional: false,
  notes: [],
};

const PRIORITY: StoredPriority = {
  id: 'pri-body',
  userId: 'u1',
  horizonWeeks: 6,
  kind: 'lift',
  ref: 'bodyweight',
  level: 'maintain',
  declaredAt: START,
  mesosHeld: 1,
};

const TARGET: StoredGoalTarget = {
  id: 'tgt-body',
  priorityId: PRIORITY.id,
  metric: 'bodyweight',
  startValue: 180,
  startMeasuredAt: START,
  bandLowPctPerWeek: 0,
  bandHighPctPerWeek: 0,
  committedValue: LOW,
  stretchValue: HIGH,
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  tierUsed: 'early-intermediate',
  tierProvisional: false,
  dietPhaseAtDerivation: 'maintenance',
  acceptedBy: 'user',
  acknowledgedStretch: false,
  derivedAt: START,
  endsAt: '2026-09-14T00:00:00.000Z',
};

function weighIns(...values: number[]): GoalActual[] {
  return values.map((value, day) => ({ ts: tsInWeek(3, day), value, matched: true, isPR: false }));
}

function input(overrides: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    priority: PRIORITY,
    target: TARGET,
    band: CORRIDOR,
    calibrationEvidence: { matchedSessionCount: 6, baselineState: 'CALIBRATED' },
    actuals: [],
    weeks: WEEKS,
    now: tsInWeek(3, 6),
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    ...overrides,
  };
}

describe('a maintenance corridor, mid-block', () => {
  it('reads behind above the corridor, says so, and names intake and activity', () => {
    const view = buildGoalProgressView(input({ actuals: weighIns(180, 182.5, 185) }));

    expect(view.status).toBe('behind');
    expect(view.corridorSide).toBe('above');
    expect(view.statusBasis).toContain(
      'Above the maintenance corridor: 185 against 176.4 to 183.6',
    );
    expect(view.advisory?.source).toBe('bodyweight');
    expect(view.advisory?.prompt).toContain('intake and activity');
  });

  it('reads behind below the corridor', () => {
    const view = buildGoalProgressView(input({ actuals: weighIns(180, 178, 175) }));

    expect(view.status).toBe('behind');
    expect(view.corridorSide).toBe('below');
    expect(view.statusBasis).toContain('Below the maintenance corridor');
  });

  it('reads on track inside the corridor, with no side and no advisory', () => {
    const view = buildGoalProgressView(input({ actuals: weighIns(180, 181.5, 183) }));

    expect(view.status).toBe('on_track');
    expect(view.corridorSide).toBeUndefined();
    expect(view.advisory).toBeUndefined();
  });

  it('holds the edge exactly: no noise tolerance past the corridor the chart draws', () => {
    const onEdge = buildGoalProgressView(input({ actuals: weighIns(180, 182, HIGH) }));
    const past = buildGoalProgressView(input({ actuals: weighIns(180, 182, 183.7) }));

    expect(onEdge.status).toBe('on_track');
    expect(past.status).toBe('behind');
  });

  it('reads on track while a reading outside is converging back on the middle', () => {
    const view = buildGoalProgressView(input({ actuals: weighIns(190, 187, 184) }));

    expect(view.status).toBe('on_track');
    expect(view.corridorSide).toBeUndefined();
  });

  it('reads behind while a reading outside keeps its distance', () => {
    const view = buildGoalProgressView(input({ actuals: weighIns(185, 185, 185) }));

    expect(view.status).toBe('behind');
  });
});

describe('a maintenance corridor, block verdict', () => {
  function inWeek(weekIndex: number, value: number): GoalActual {
    return { ts: tsInWeek(weekIndex), value, matched: true, isPR: false };
  }

  it('is not met mid-block, however long it has sat inside', () => {
    const view = buildGoalProgressView(
      input({ actuals: [inWeek(1, 180), inWeek(2, 180.5), inWeek(3, 181)] }),
    );

    expect(view.status).toBe('on_track');
    expect(view.mesoMilestone.state).toBe('upcoming');
  });

  it('is met in the final week off a reading inside the corridor, and never beyond it', () => {
    const view = buildGoalProgressView(
      input({ actuals: [inWeek(5, 181), inWeek(6, 180)], now: tsInWeek(6, 3) }),
    );

    expect(view.status).toBe('goal_met');
    expect(view.statusBasis).toContain('held inside the corridor');
    expect(view.mesoMilestone.state).toBe('hit');
    expect(view.praise?.text).toContain('inside the corridor');
  });

  it('is judged off the latest final-week reading, not the best one', () => {
    const view = buildGoalProgressView(
      input({ actuals: [inWeek(6, 180), inWeek(6, 185), inWeek(6, 185)], now: tsInWeek(6, 5) }),
    );

    expect(view.status).toBe('behind');
    expect(view.mesoMilestone.state).toBe('upcoming');
  });

  it('is missed once the block ends outside the corridor', () => {
    const view = buildGoalProgressView(
      input({ actuals: [inWeek(5, 184), inWeek(6, 185)], now: tsInWeek(7) }),
    );

    expect(view.mesoMilestone.state).toBe('missed');
    expect(view.status).not.toBe('goal_met');
  });

  it('is missed once the block ends with no final-week reading', () => {
    const view = buildGoalProgressView(input({ actuals: [inWeek(5, 180)], now: tsInWeek(7) }));

    expect(view.mesoMilestone.state).toBe('missed');
  });
});

describe('a hold band with no corridor', () => {
  it('leaves a lift held through a diet phase to its own rules, with no corridor verdict', () => {
    const liftHold: GoalBand = { ...CORRIDOR, corridorPct: null };
    const view = buildGoalProgressView(
      input({
        band: liftHold,
        target: { ...TARGET, metric: 'top_load_at_reps', anchorReps: 8 },
        actuals: [{ ts: tsInWeek(6), value: 180, matched: true, isPR: false }],
        now: tsInWeek(6, 3),
      }),
    );

    expect(view.status).not.toBe('goal_met');
    expect(view.corridorSide).toBeUndefined();
  });
});
