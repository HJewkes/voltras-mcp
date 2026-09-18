// Unit tests for the block-end half of the goal read model (VW-400, VW-399):
// `mesoMilestone`, `weekOutcomes`, and the two block verdicts `goal_met` and
// `beyond_goal` that outrank every pace status once earned.
//
// Pure shaping only: literal bands, literal readings, a caller-supplied `now`.

import { describe, expect, it } from 'vitest';

import {
  buildGoalProgressView,
  buildPriorityRollup,
  type GoalActual,
  type GoalProgressInput,
} from '../read-models/goal-progress.js';
import type { GoalBand, GoalBandWeek } from '../../analytics/goal-band.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-03T00:00:00.000Z';

function tsInWeek(weekIndex: number, start = START): string {
  return new Date(Date.parse(start) + ((weekIndex - 1) * 7 + 1) * DAY_MS).toISOString();
}

const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6].map((index) => ({ index, isDeload: false }));

const BAND: GoalBand = {
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  bandLowPctPerWeek: 1.470588,
  bandHighPctPerWeek: 2.941176,
  corridorPct: null,
  expected: [
    { weekIndex: 1, low: 170, high: 170 },
    { weekIndex: 2, low: 172.5, high: 175 },
    { weekIndex: 3, low: 175, high: 180 },
    { weekIndex: 4, low: 177.5, high: 185 },
    { weekIndex: 5, low: 180, high: 190 },
    { weekIndex: 6, low: 182.5, high: 195 },
  ],
  committedValue: 182.5,
  stretchValue: 195,
  direction: 'up',
  provisional: false,
  notes: [],
};

const PRIORITY: StoredPriority = {
  id: 'pri-bench',
  userId: 'u1',
  horizonWeeks: 6,
  kind: 'lift',
  ref: 'bench-press',
  level: 'specialize',
  declaredAt: START,
  mesosHeld: 1,
};

const TARGET: StoredGoalTarget = {
  id: 'tgt-bench',
  priorityId: PRIORITY.id,
  metric: 'top_load_at_reps',
  exerciseId: 'bench-press',
  anchorReps: 8,
  startValue: 170,
  startMeasuredAt: START,
  bandLowPctPerWeek: 1.470588,
  bandHighPctPerWeek: 2.941176,
  committedValue: 182.5,
  stretchValue: 195,
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

function actual(weekIndex: number, value: number, start = START): GoalActual {
  return { ts: tsInWeek(weekIndex, start), value, matched: true, isPR: false };
}

function input(overrides: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    priority: PRIORITY,
    target: TARGET,
    band: BAND,
    actuals: [],
    weeks: WEEKS,
    now: tsInWeek(3),
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    ...overrides,
  };
}

describe('mesoMilestone', () => {
  it('states the committed number as a set due in the block last week', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(1, 170), actual(3, 176)] }));

    expect(view.mesoMilestone).toEqual({
      target: { metric: 'top_load_at_reps', reps: 8, load: 182.5, unit: 'lb' },
      goalWeek: 6,
      currentWeek: 3,
      weekCount: 6,
      direction: 'up',
      latest: { reps: 8, load: 176 },
      state: 'upcoming',
    });
  });

  it('is missed once the block ends without the committed number', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(6, 181)], now: tsInWeek(7) }));

    expect(view.mesoMilestone.currentWeek).toBe(7);
    expect(view.mesoMilestone.state).toBe('missed');
  });

  it('is hit at the boundary when the last week lifted it', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(6, 182.5)], now: tsInWeek(7) }));

    expect(view.mesoMilestone.state).toBe('hit');
    expect(view.status).toBe('goal_met');
  });

  it('does not count a reading taken after the block ended', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(7, 190)], now: tsInWeek(7) }));

    expect(view.mesoMilestone.state).toBe('missed');
    expect(view.mesoMilestone.latest).toBeUndefined();
    expect(view.status).not.toBe('beyond_goal');
  });

  it('falls back to a bare value when a load metric never recorded its anchor', () => {
    const target: StoredGoalTarget = { ...TARGET, metric: 'reps_at_load', committedValue: 12 };
    const view = buildGoalProgressView(input({ target }));

    expect(view.mesoMilestone.target).toEqual({ metric: 'reps_at_load', value: 12, unit: 'reps' });
  });
});

describe('weekOutcomes', () => {
  it('reads each week latest reading against that week band row', () => {
    const actuals = [actual(1, 172), actual(2, 170), actual(2, 173), actual(3, 174)];
    const view = buildGoalProgressView(input({ actuals }));

    expect(view.weekOutcomes.map((week) => week.outcome)).toEqual([
      'ahead',
      'on_track',
      'missed',
      'none',
      'none',
      'none',
    ]);
    expect(view.weekOutcomes[1]).toEqual({
      weekIndex: 2,
      outcome: 'on_track',
      reading: { reps: 8, load: 173 },
    });
  });

  it('ignores unmatched readings', () => {
    const view = buildGoalProgressView(input({ actuals: [{ ...actual(1, 172), matched: false }] }));

    expect(view.weekOutcomes[0]).toEqual({ weekIndex: 1, outcome: 'none' });
  });
});

describe('goal_met and beyond_goal', () => {
  it('reads goal_met when the best matched reading equals the committed number', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(2, 175), actual(3, 182.5)] }));

    expect(view.status).toBe('goal_met');
    expect(view.statusBasis).toContain('rp:rp-s10-underpromise-overdeliver-goal-setting');
    expect(view.mesoMilestone.state).toBe('hit');
  });

  it('compares at the metric precision, so a reading that rounds onto the number meets it', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(3, 182.46)] }));

    expect(view.status).toBe('goal_met');
  });

  it('reads beyond_goal when the best matched reading is strictly past it', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(3, 183)] }));

    expect(view.status).toBe('beyond_goal');
    expect(view.statusBasis).toContain('183');
  });

  it('never regresses to a pace status after a later dip', () => {
    const view = buildGoalProgressView(
      input({ actuals: [actual(2, 183), actual(3, 171)], now: tsInWeek(4) }),
    );

    expect(view.status).toBe('beyond_goal');
    expect(view.mesoMilestone.latest).toEqual({ reps: 8, load: 171 });
    expect(view.mesoMilestone.state).toBe('hit');
  });

  it('outranks a deload week', () => {
    const weeks = WEEKS.map((week) => ({ ...week, isDeload: week.index === 3 }));
    const view = buildGoalProgressView(input({ actuals: [actual(2, 182.5)], weeks }));

    expect(view.status).toBe('goal_met');
  });

  it('counts both as progressing in the priority rollup', () => {
    const met = buildGoalProgressView(input({ actuals: [actual(3, 182.5)] }));
    const beyond = buildGoalProgressView(
      input({ target: { ...TARGET, id: 'tgt-b' }, actuals: [actual(3, 190)] }),
    );

    const [rollup] = buildPriorityRollup([met, beyond]);

    expect(rollup.progressingCount).toBe(2);
    expect(rollup.status).toBe('goal_met');
  });
});

describe('a loss goal', () => {
  const LOSS_BAND: GoalBand = {
    ...BAND,
    expected: [
      { weekIndex: 1, low: 200, high: 199 },
      { weekIndex: 2, low: 199, high: 197 },
      { weekIndex: 3, low: 198, high: 195 },
      { weekIndex: 4, low: 197, high: 193 },
      { weekIndex: 5, low: 196, high: 192 },
      { weekIndex: 6, low: 195, high: 190 },
    ],
    committedValue: 195,
    stretchValue: 190,
    direction: 'down',
  };
  const LOSS_TARGET: StoredGoalTarget = {
    ...TARGET,
    metric: 'bodyweight',
    exerciseId: undefined,
    anchorReps: undefined,
    startValue: 200,
    committedValue: 195,
    stretchValue: 190,
  };

  function lossView(actuals: GoalActual[]) {
    return buildGoalProgressView(input({ target: LOSS_TARGET, band: LOSS_BAND, actuals }));
  }

  it('reads week outcomes in the direction of the loss', () => {
    const view = lossView([actual(1, 199.5), actual(2, 196), actual(3, 199)]);

    expect(view.weekOutcomes.slice(0, 3).map((week) => week.outcome)).toEqual([
      'on_track',
      'ahead',
      'missed',
    ]);
    expect(view.mesoMilestone.target).toEqual({ metric: 'bodyweight', value: 195, unit: 'lb' });
    expect(view.mesoMilestone.latest).toEqual({ value: 199 });
    expect(view.mesoMilestone.direction).toBe('down');
  });

  it('stays short above the committed weight, meets it on it, and goes beyond under it', () => {
    expect(lossView([actual(3, 196)]).mesoMilestone.state).toBe('upcoming');
    expect(lossView([actual(3, 195)]).status).toBe('goal_met');
    expect(lossView([actual(3, 194)]).status).toBe('beyond_goal');
  });
});

describe('a hold goal', () => {
  const HOLD_BAND: GoalBand = {
    ...BAND,
    expected: WEEKS.map((week) => ({ weekIndex: week.index, low: 178, high: 182 })),
    committedValue: 178,
    stretchValue: 182,
    direction: 'hold',
  };
  const HOLD_TARGET: StoredGoalTarget = {
    ...TARGET,
    metric: 'bodyweight',
    committedValue: 178,
    stretchValue: 182,
  };

  it('earns no block verdict mid-block, and is held at the boundary inside the corridor', () => {
    const hold = { target: HOLD_TARGET, band: HOLD_BAND };
    const mid = buildGoalProgressView(input({ ...hold, actuals: [actual(3, 180)] }));
    const ended = buildGoalProgressView(
      input({ ...hold, actuals: [actual(6, 180)], now: tsInWeek(7) }),
    );

    expect(mid.status).not.toBe('goal_met');
    expect(mid.mesoMilestone.state).toBe('upcoming');
    expect(ended.mesoMilestone.state).toBe('hit');
  });
});

describe('reps_at_load with an anchor load (VW-399)', () => {
  const REPS_TARGET: StoredGoalTarget = {
    ...TARGET,
    metric: 'reps_at_load',
    anchorReps: undefined,
    anchorLoad: 185,
    startValue: 8,
    committedValue: 12,
    stretchValue: 14,
  };
  const REPS_BAND: GoalBand = {
    ...BAND,
    expected: WEEKS.map((week) => ({
      weekIndex: week.index,
      low: 8 + (week.index - 1) * 0.8,
      high: 8 + (week.index - 1) * 1.2,
    })),
    committedValue: 12,
    stretchValue: 14,
  };

  it('prints the milestone and the meso target as a whole set', () => {
    const view = buildGoalProgressView(
      input({ target: REPS_TARGET, band: REPS_BAND, actuals: [actual(3, 10)] }),
    );

    expect(view.nextMilestone.label).toBe('10.4 reps at 185 lb in week 4');
    expect(view.nextMilestone.load).toBe(185);
    expect(view.mesoMilestone.target).toEqual({
      metric: 'reps_at_load',
      reps: 12,
      load: 185,
      unit: 'lb',
    });
    expect(view.mesoMilestone.latest).toEqual({ reps: 10, load: 185 });
  });
});

// Transcribed from the VW-385 chart capture `calibrating-cable-chest-press.json`:
// a cold band where committed === stretch, and one matched reading in week 1.
describe('the calibrating capture', () => {
  const CAL_START = '2026-09-14T00:00:00.000Z';
  const CAL_WEEKS: GoalBandWeek[] = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    isDeload: false,
  }));
  const CAL_BAND: GoalBand = {
    ...BAND,
    basis: 'execution_ramp',
    infoLevel: 'cold',
    expected: CAL_WEEKS.map((week) => {
      const edge = 100 + (week.index - 1) * 2.5;
      return { weekIndex: week.index, low: edge, high: edge };
    }),
    committedValue: 127.5,
    stretchValue: 127.5,
  };
  const CAL_TARGET: StoredGoalTarget = {
    ...TARGET,
    exerciseId: 'cable-chest-press',
    startValue: 100,
    startMeasuredAt: CAL_START,
    committedValue: 127.5,
    stretchValue: 127.5,
    basis: 'execution_ramp',
    infoLevel: 'cold',
  };
  const CAL_ACTUALS: GoalActual[] = [
    { ts: '2026-09-07T00:00:00.000Z', value: 100, matched: true, isPR: false },
    { ts: '2026-09-14T00:00:00.000Z', value: 110, matched: true, isPR: true },
  ];

  function calView(actuals: GoalActual[]) {
    return buildGoalProgressView(
      input({
        target: CAL_TARGET,
        band: CAL_BAND,
        weeks: CAL_WEEKS,
        actuals,
        now: '2026-09-17T12:00:00.000Z',
      }),
    );
  }

  it('stays calibrating with an open milestone and one ahead week', () => {
    const view = calView(CAL_ACTUALS);

    expect(view.status).toBe('calibrating');
    expect(view.mesoMilestone).toMatchObject({
      target: { reps: 8, load: 127.5 },
      goalWeek: 12,
      currentWeek: 1,
      latest: { reps: 8, load: 110 },
      state: 'upcoming',
    });
    expect(view.weekOutcomes[0].outcome).toBe('ahead');
    expect(view.weekOutcomes.slice(1).every((week) => week.outcome === 'none')).toBe(true);
  });

  it('is not swallowed by calibrating once the committed number is lifted', () => {
    const view = calView([...CAL_ACTUALS, { ...actual(1, 127.5, CAL_START) }]);

    expect(view.status).toBe('goal_met');
  });
});
