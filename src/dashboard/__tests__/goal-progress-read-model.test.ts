// Unit tests for the goal-progress read-model (VW-351, plan G4').
//
// Pure shaping only — no store, no HTTP, no clock. Every fixture is a literal
// band plus literal readings, and one test proves the module never reaches for
// `Date.now` by making that call throw.
//
// Covers: one fixture per status word; the fat-loss week-6 flip from `behind`
// to `tolerated`; a cold target rendering the execution ramp only; the
// programming advisory sourced from the MRV verdict leaving the target's two
// numbers untouched; a deload week suppressing verdicts; praise quiet on a
// set-level PR and loud at the mesocycle's end; and the priority rollup.

import { describe, expect, it } from 'vitest';

import {
  buildGoalProgressView,
  buildPriorityRollup,
  type GoalActual,
  type GoalCalibrationEvidence,
  type GoalProgressInput,
  type GoalProgressView,
} from '../read-models/goal-progress.js';
import { deriveGoalBand, type GoalBand, type GoalBandWeek } from '../../analytics/goal-band.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

/** Monday, so every `+7n days` offset lands on the same weekday. */
const START = '2026-08-03T00:00:00.000Z';

const WEEK_3 = '2026-08-18T12:00:00.000Z';
const WEEK_6 = '2026-09-08T12:00:00.000Z';

/** A six-week meso, no deload. Fixtures that need one replace the last entry. */
const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6].map((index) => ({ index, isDeload: false }));

/**
 * A 170 lb start ramping 2.5 lb/wk on the committed edge and 5 lb/wk on the
 * stretch — the shape `deriveGoalBand` produces for a `ramp` strength target,
 * written out so each fixture's deviation is readable at a glance.
 */
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
  blockId: 'blk-1',
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
  acknowledgedStretch: true,
  derivedAt: START,
  endsAt: '2026-09-14T00:00:00.000Z',
};

/** `weekIndex` -> an ISO timestamp that `weeksInPhaseAt` puts in that week. */
function tsInWeek(weekIndex: number): string {
  const dayOffset = (weekIndex - 1) * 7 + 1;
  return new Date(Date.parse(START) + dayOffset * 24 * 60 * 60 * 1000).toISOString();
}

function actual(weekIndex: number, value: number, overrides: Partial<GoalActual> = {}): GoalActual {
  return { ts: tsInWeek(weekIndex), value, matched: true, isPR: false, ...overrides };
}

function input(overrides: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    priority: PRIORITY,
    target: TARGET,
    band: BAND,
    calibrationEvidence: { matchedSessionCount: 6, baselineState: 'CALIBRATED' },
    actuals: [],
    weeks: WEEKS,
    now: WEEK_3,
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    ...overrides,
  };
}

/** Converging on the line from under it: off the band, but the trend is closing. */
const CONVERGING = [actual(1, 168), actual(2, 171), actual(3, 174)];

/** Flat under the line, but starting above the first week's committed edge. */
const FLAT_MISS = [actual(1, 174.5), actual(2, 174.2), actual(3, 174)];

/** Flat under every week's committed edge — the stall shape. */
const FLAT_RUN = [actual(1, 169), actual(2, 169.5), actual(3, 170)];

describe('buildGoalProgressView status vocabulary', () => {
  it('reads on_track when the trend is converging, even below the committed edge', () => {
    const view = buildGoalProgressView(input({ actuals: CONVERGING }));

    expect(view.status).toBe('on_track');
    expect(view.statusBasis).toContain('rp:rp-s12-trend-slope-overrides-raw-deviation');
    expect(view.mesoWeek).toEqual({ n: 3, of: 6, isDeload: false });
    expect(view.advisory).toBeUndefined();
  });

  it('reads ahead past the stretch edge, with no mid-block decision to make', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(2, 177), actual(3, 182)] }));

    expect(view.status).toBe('ahead');
    expect(view.statusBasis).toContain('rp:rp-s5-intermediate-overplanning-risk');
    expect(view.advisory).toBeUndefined();
  });

  it('reads behind on a flat miss, and attaches entry depression as a confounder', () => {
    const view = buildGoalProgressView(
      input({ actuals: FLAT_MISS, fatigue: { entryDepressionPct: 6.2, confidence: 0.6 } }),
    );

    expect(view.status).toBe('behind');
    expect(view.confounder).toEqual({ kind: 'entry_depression', pct: 6.2, confidence: 0.6 });
  });

  it('reads tolerated when the diet phase is what turned the advice down', () => {
    const view = buildGoalProgressView(
      input({ actuals: FLAT_MISS, dietState: { phase: 'fat-loss', weeksInPhase: 6 } }),
    );

    expect(view.status).toBe('tolerated');
    expect(view.statusBasis).toContain('rp:rp-s11-diet-phase-training-fatigue-coupling');
  });

  it('keeps recomposition as its own phase label rather than folding it onto maintenance', () => {
    const view = buildGoalProgressView(
      input({ actuals: FLAT_MISS, dietState: { phase: 'recomposition', weeksInPhase: 6 } }),
    );

    expect(view.status).toBe('behind');
    expect(view.statusBasis).toContain('recomposition phase');
    expect(view.statusBasis).not.toContain('maintenance');
  });

  it('falls back to its own run rule for stalled when no plateau detector ran', () => {
    const view = buildGoalProgressView(input({ actuals: FLAT_RUN }));

    expect(view.status).toBe('stalled');
    expect(view.statusBasis).toContain('no plateau detector run');
    expect(view.statusBasis).toContain('rp:rp-s7-plateau-flatline-vs-slowdown-distinction');
  });

  it('reads deload_week and draws no verdict on the deload week', () => {
    const weeks = WEEKS.map((week) => (week.index === 6 ? { ...week, isDeload: true } : week));
    const view = buildGoalProgressView(
      input({ actuals: [...FLAT_RUN, actual(6, 170)], weeks, now: WEEK_6 }),
    );

    expect(view.status).toBe('deload_week');
    expect(view.statusBasis).toContain('VW-326');
    expect(view.advisory).toBeUndefined();
    expect(view.praise).toBeUndefined();
    expect(view.confounder).toBeUndefined();
  });

  it('reads calibrating below two matched readings', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(3, 174)] }));

    expect(view.status).toBe('calibrating');
    expect(view.statusBasis).toContain('1 more matched session');
  });
});

describe('buildGoalProgressView stalled source', () => {
  it('lets the plateau detector decide stalled, and says it was the detector', () => {
    const view = buildGoalProgressView(
      input({
        actuals: CONVERGING,
        plateauVerdict: { verdict: 'plateau', plateauDays: 21, reasoning: 'Variance under 5%.' },
      }),
    );

    expect(view.status).toBe('stalled');
    expect(view.statusBasis).toContain('history.trend');
    expect(view.statusBasis).toContain('21 days');
    expect(view.statusBasis).toContain('Variance under 5%.');
  });

  it('keeps a calibrating target calibrating when the detector finds a flatline (VW-452)', () => {
    const view = buildGoalProgressView(
      input({
        band: { ...BAND, infoLevel: 'cold' },
        actuals: FLAT_RUN,
        plateauVerdict: { verdict: 'plateau', plateauDays: 14 },
      }),
    );

    expect(view.status).toBe('calibrating');
  });

  it('does not stall on a tolerated plateau, because the phase already explains it', () => {
    const view = buildGoalProgressView(
      input({ actuals: FLAT_RUN, plateauVerdict: { verdict: 'tolerated' } }),
    );

    expect(view.status).not.toBe('stalled');
  });

  it('overrides the local run rule when the detector found no plateau', () => {
    const withDetector = buildGoalProgressView(
      input({ actuals: FLAT_RUN, plateauVerdict: { verdict: 'none' } }),
    );
    const withoutDetector = buildGoalProgressView(input({ actuals: FLAT_RUN }));

    expect(withoutDetector.status).toBe('stalled');
    expect(withDetector.status).toBe('behind');
  });
});

describe('buildGoalProgressView session-count commitment', () => {
  const sessionTarget: StoredGoalTarget = {
    ...TARGET,
    metric: 'sessions_28d',
    anchorReps: undefined,
    exerciseId: undefined,
    startValue: 12,
    committedValue: 12,
    stretchValue: 12,
    infoLevel: 'cold',
    basis: 'execution_ramp',
  };

  /** A session count's band is flat at the declared count, as `sessionCountShape` builds it. */
  const sessionBand: GoalBand = {
    ...BAND,
    basis: 'execution_ramp',
    infoLevel: 'cold',
    corridorPct: 0,
    direction: 'hold',
    expected: WEEKS.map((week) => ({ weekIndex: week.index, low: 12, high: 12 })),
    committedValue: 12,
    stretchValue: 12,
  };

  function sessionView(counted: number, now: string) {
    return buildGoalProgressView(
      input({
        target: sessionTarget,
        band: sessionBand,
        actuals: [{ ts: now, value: counted, matched: true, isPR: false }],
        now,
      }),
    );
  }

  it('reads on pace, not calibrating, when the count keeps up with the elapsed window', () => {
    // Day 14 of the 28-day window, so 6 of the committed 12 are due.
    const view = sessionView(7, '2026-08-17T00:00:00.000Z');

    expect(view.status).toBe('on_track');
    expect(view.statusBasis).toContain('a commitment, not a progression');
    expect(view.statusBasis).toContain('rp:rp-s10-three-month-planning-horizon');
    expect(view.statusBasis).not.toContain('execution ramp');
  });

  it('reads behind under pace, and the lever is the schedule rather than the load', () => {
    const view = sessionView(2, '2026-08-17T00:00:00.000Z');

    expect(view.status).toBe('behind');
    expect(view.statusBasis).toContain('2 of the 6 due by now against a committed 12');
    expect(view.advisory?.source).toBe('commitment');
    expect(view.advisory?.prompt).toContain('the lever is the schedule');
    expect(view.committed).toBe(12);
  });
});

describe('buildGoalProgressView week-axis placement', () => {
  it('places an actual on its meso week and leaves one outside the meso unplaced', () => {
    const beforeStart = { ts: '2026-07-30T00:00:00.000Z', value: 165, matched: true, isPR: false };
    const pastTheEnd = actual(8, 190);
    const view = buildGoalProgressView(
      input({ actuals: [beforeStart, actual(3, 174), pastTheEnd] }),
    );

    expect(view.actuals.map((entry) => entry.weekIndex)).toEqual([undefined, 3, undefined]);
  });

  it('keeps ts alongside the week it resolved', () => {
    const view = buildGoalProgressView(input({ actuals: CONVERGING }));

    expect(view.actuals).toEqual([
      { ...CONVERGING[0], weekIndex: 1 },
      { ...CONVERGING[1], weekIndex: 2 },
      { ...CONVERGING[2], weekIndex: 3 },
    ]);
  });
});

describe('buildGoalProgressView band pass-through', () => {
  it('renders the execution ramp only for a cold target, both edges equal', () => {
    const band = deriveGoalBand({
      metric: 'top_load_at_reps',
      startValue: 170,
      horizonWeeks: 6,
      weeks: WEEKS,
      tier: 'intermediate',
      infoLevel: 'ramp',
      dietState: { phase: 'maintenance', weeksInPhase: 4 },
      layoff: false,
      matchedSessionCount: 0,
      baselineState: 'COLD',
      completedMesoCount: 0,
    });

    const view = buildGoalProgressView(input({ band, actuals: CONVERGING }));

    expect(band.infoLevel).toBe('cold');
    expect(view.expected).toHaveLength(6);
    for (const week of view.expected) {
      expect(week.low).toBe(week.high);
    }
    expect(view.status).toBe('calibrating');
  });

  it('names the next week committed edge as the milestone', () => {
    const view = buildGoalProgressView(input({ actuals: CONVERGING }));

    expect(view.nextMilestone).toEqual({
      label: '177.5 x 8 in week 4',
      value: 177.5,
      dueWeek: 4,
      reps: 8,
      load: 177.5,
      unit: 'lb',
      goalWeek: 4,
    });
  });

  it('reads reps and load off the target, not off the label string', () => {
    // Week 4's low needs rounding (177.549 -> 177.5) and the rep anchor (12) is
    // deliberately far from the rounded load, so a milestone that re-split the
    // label's "177.5 x 12" on ' x ' with the fields swapped — the hero card
    // reads "reps x load", the label prints load first — would fail here.
    const band: GoalBand = {
      ...BAND,
      expected: BAND.expected.map((week) =>
        week.weekIndex === 4 ? { ...week, low: 177.549 } : week,
      ),
    };
    const target: StoredGoalTarget = { ...TARGET, anchorReps: 12 };

    const view = buildGoalProgressView(input({ target, band, actuals: CONVERGING }));

    expect(view.nextMilestone.label).toBe('177.5 x 12 in week 4');
    expect(view.nextMilestone.reps).toBe(12);
    expect(view.nextMilestone.load).toBe(177.5);
    expect(view.nextMilestone.unit).toBe('lb');
    expect(view.nextMilestone.goalWeek).toBe(4);
  });
});

describe('buildGoalProgressView advisories', () => {
  it('sources the programming advisory from the MRV verdict and never moves the target', () => {
    const view = buildGoalProgressView(
      input({
        actuals: FLAT_MISS,
        mrvVerdict: { mrvFlagged: true, reasoning: 'Both matched pairs underperformed.' },
      }),
    );

    expect(view.status).toBe('behind');
    expect(view.advisory?.kind).toBe('programming');
    expect(view.advisory?.source).toBe('checkMrvGuard');
    expect(view.advisory?.prompt).toContain('Both matched pairs underperformed.');
    expect(view.committed).toBe(TARGET.committedValue);
    expect(view.stretch).toBe(TARGET.stretchValue);
  });

  it('falls back to a progression lever when no MRV verdict was run', () => {
    const view = buildGoalProgressView(input({ actuals: FLAT_RUN }));

    expect(view.advisory?.source).toBe('progression');
    expect(view.advisory?.prompt).toContain('The target itself does not move.');
  });

  it('asks the ahead question in the block last week, where past stretch is past the goal', () => {
    const actuals = [actual(4, 186), actual(5, 193), actual(6, 200)];
    const view = buildGoalProgressView(input({ actuals, now: WEEK_6 }));

    expect(view.status).toBe('beyond_goal');
    expect(view.advisory?.kind).toBe('ahead_decision');
  });
});

describe('buildGoalProgressView praise cadence', () => {
  it('is quiet on a set-level PR mid-meso', () => {
    const actuals = [actual(1, 168), actual(2, 171), actual(3, 174, { isPR: true })];
    const view = buildGoalProgressView(input({ actuals }));

    expect(view.praise).toEqual({ level: 'quiet', text: 'Personal best on that set.' });
  });

  it('is loud at the end of the mesocycle, sized against the lifter own target', () => {
    const actuals = [actual(4, 178), actual(5, 182), actual(6, 186)];
    const view = buildGoalProgressView(input({ actuals, now: WEEK_6 }));

    expect(view.status).toBe('beyond_goal');
    expect(view.praise?.level).toBe('loud');
    expect(view.praise?.text).toContain('128%');
    expect(view.praise?.text).toContain('rp:rp-s12-praise-relative-to-goal-not-magnitude');
  });
});

describe('buildGoalProgressView calibration facts (VW-444)', () => {
  /** What `goal.propose_targets` stores for a lift derived before calibration. */
  const COLD_TARGET: StoredGoalTarget = {
    ...TARGET,
    committedValue: 185,
    stretchValue: 185,
    basis: 'execution_ramp',
    infoLevel: 'cold',
  };

  function coldView(evidence: GoalCalibrationEvidence): GoalProgressView {
    const band = deriveGoalBand({
      metric: 'top_load_at_reps',
      startValue: 170,
      horizonWeeks: 6,
      weeks: WEEKS,
      tier: 'intermediate',
      infoLevel: 'own',
      dietState: { phase: 'maintenance', weeksInPhase: 4 },
      layoff: false,
      ...evidence,
      completedMesoCount: 0,
    });
    return buildGoalProgressView(
      input({
        target: COLD_TARGET,
        band,
        calibrationEvidence: evidence,
        actuals: [actual(2, 172)],
      }),
    );
  }

  it('counts the sessions still needed when only the session count blocks', () => {
    const view = coldView({ matchedSessionCount: 1, baselineState: 'PROVISIONAL' });

    expect(view.status).toBe('calibrating');
    expect(view.calibration).toEqual({
      sessionsNeeded: 1,
      blockedBy: 'sessions',
      baselineState: 'PROVISIONAL',
      targetBasis: 'execution_ramp',
      targetInfoLevel: 'cold',
    });
  });

  it('names the baseline, with no sessions owed, when only the baseline blocks', () => {
    const view = coldView({ matchedSessionCount: 4, baselineState: 'SHAPE_ONLY' });

    expect(view.calibration).toMatchObject({
      sessionsNeeded: 0,
      blockedBy: 'baseline',
      baselineState: 'SHAPE_ONLY',
    });
  });

  it('reports both gates when the count and the baseline both block', () => {
    const view = coldView({ matchedSessionCount: 0, baselineState: 'COLD' });

    expect(view.calibration).toMatchObject({
      sessionsNeeded: 2,
      blockedBy: 'both',
      baselineState: 'COLD',
    });
  });

  it('leaves statusBasis prose as it was', () => {
    const view = coldView({ matchedSessionCount: 1, baselineState: 'PROVISIONAL' });

    expect(view.statusBasis).toContain('Calibrating: the band is the programmed execution ramp');
  });

  it('counts matched readings when the band is warm but the readings are not', () => {
    const view = buildGoalProgressView(input({ actuals: [actual(3, 174)] }));

    expect(view.calibration).toEqual({
      sessionsNeeded: 1,
      blockedBy: 'sessions',
      baselineState: 'CALIBRATED',
      targetBasis: 'rp_ramp',
      targetInfoLevel: 'ramp',
    });
  });

  it('carries no calibration facts once the target is judged against its band', () => {
    const view = buildGoalProgressView(input({ actuals: CONVERGING }));

    expect(view.status).toBe('on_track');
    expect(view).not.toHaveProperty('calibration');
  });

  it('carries no calibration facts for a session-count commitment with nothing counted', () => {
    const view = buildGoalProgressView(
      input({
        target: { ...COLD_TARGET, metric: 'sessions_28d', exerciseId: undefined },
        band: { ...BAND, infoLevel: 'cold', basis: 'execution_ramp' },
        calibrationEvidence: { matchedSessionCount: 0, baselineState: 'CALIBRATED' },
      }),
    );

    expect(view.status).toBe('calibrating');
    expect(view).not.toHaveProperty('calibration');
  });
});

describe('buildGoalProgressView recalibration (VW-444 part 2)', () => {
  const RAMP: StoredGoalTarget = {
    ...TARGET,
    committedValue: 185,
    stretchValue: 185,
    basis: 'execution_ramp',
    infoLevel: 'cold',
  };
  const CALIBRATED = { matchedSessionCount: 3, baselineState: 'PROVISIONAL' as const };

  it('offers a data-based target on an accepted starting ramp whose lift has calibrated', () => {
    const view = buildGoalProgressView(
      input({ target: RAMP, calibrationEvidence: CALIBRATED, actuals: CONVERGING }),
    );

    expect(view.recalibration).toEqual({ state: 'offered' });
  });

  it('says the ramp was kept once the lifter declined', () => {
    const view = buildGoalProgressView(
      input({
        target: RAMP,
        calibrationEvidence: CALIBRATED,
        recalibrationDeclined: true,
        actuals: CONVERGING,
      }),
    );

    expect(view.recalibration).toEqual({ state: 'kept_starting_ramp' });
  });

  it('withdraws the offer when the evidence goes backwards', () => {
    const view = buildGoalProgressView(
      input({
        target: RAMP,
        calibrationEvidence: { matchedSessionCount: 1, baselineState: 'PROVISIONAL' },
        actuals: CONVERGING,
      }),
    );

    expect(view).not.toHaveProperty('recalibration');
  });

  it('has nothing to offer on a target that was accepted from data', () => {
    const view = buildGoalProgressView(input({ actuals: CONVERGING }));

    expect(view).not.toHaveProperty('recalibration');
  });

  it('has nothing to offer on an unanswered proposal', () => {
    const view = buildGoalProgressView(
      input({
        target: { ...RAMP, acceptedBy: undefined },
        calibrationEvidence: CALIBRATED,
        actuals: CONVERGING,
      }),
    );

    expect(view).not.toHaveProperty('recalibration');
  });
});

describe('buildGoalProgressView purity', () => {
  it('never reads the clock and returns the same view for the same inputs', () => {
    const args = input({ actuals: CONVERGING });
    const clock = Date.now;
    Date.now = () => {
      throw new Error('buildGoalProgressView read the clock');
    };
    try {
      expect(buildGoalProgressView(args)).toEqual(buildGoalProgressView(args));
    } finally {
      Date.now = clock;
    }
  });

  it('carries the e1RM series inside its pooled standard error, information only', () => {
    const view = buildGoalProgressView(
      input({
        actuals: CONVERGING,
        e1rm: { series: [{ ts: tsInWeek(3), value: 220 }], historyBest: 210 },
      }),
    );

    expect(view.e1rmContext?.seePct).toBe(9.8);
    expect(view.e1rmContext?.isPR).toBe(true);
    expect(view.e1rmContext?.series[0]).toEqual({
      ts: tsInWeek(3),
      value: 220,
      low: 198.44,
      high: 241.56,
    });
  });
});

describe('buildPriorityRollup', () => {
  const musclePriority: StoredPriority = {
    ...PRIORITY,
    id: 'pri-arms',
    kind: 'muscle',
    ref: 'biceps',
  };

  function viewFor(id: string, actuals: GoalActual[]): GoalProgressView {
    return buildGoalProgressView(
      input({ priority: musclePriority, target: { ...TARGET, id }, actuals }),
    );
  }

  it('corroborates a muscle priority when two lifts agree it is progressing', () => {
    const rollup = buildPriorityRollup([
      viewFor('tgt-a', CONVERGING),
      viewFor('tgt-b', CONVERGING),
      viewFor('tgt-c', FLAT_RUN),
    ]);

    expect(rollup).toHaveLength(1);
    expect(rollup[0].corroborated).toBe(true);
    expect(rollup[0].progressingCount).toBe(2);
    expect(rollup[0].status).toBe('stalled');
    expect(rollup[0].summary).toBe(
      'biceps: 2 of 3 lifts on track, corroborated across lifts (week 3 of 6).',
    );
  });

  it('leaves a lift priority uncorroborated, because one lift needs no agreement', () => {
    const rollup = buildPriorityRollup([buildGoalProgressView(input({ actuals: CONVERGING }))]);

    expect(rollup[0].corroborated).toBeNull();
    expect(rollup[0].summary).toBe('bench-press: on track (week 3 of 6).');
  });

  it('splits views across their own priorities', () => {
    const rollup = buildPriorityRollup([
      buildGoalProgressView(input({ actuals: CONVERGING })),
      viewFor('tgt-a', FLAT_RUN),
    ]);

    expect(rollup.map((entry) => entry.priorityId)).toEqual(['pri-bench', 'pri-arms']);
  });
});
