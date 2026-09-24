// The whole-body cards' props from the goals payload (VW-455, shape B). Views
// come from `buildGoalProgressView` over literal bands, the same function
// `/api/goal-progress` calls, so each fixture is the shape the route returns.

import { describe, expect, it } from 'vitest';

import type { GoalBand, GoalBandWeek } from '../../analytics/goal-band.js';
import type { GoalPriorityRow } from '../goal-progress-api.js';
import {
  buildGoalProgressView,
  type GoalActual,
  type GoalBodyweightView,
  type GoalProgressInput,
  type GoalProgressView,
} from '../read-models/goal-progress.js';
import type { GoalsPageData } from '../spa/goals/goals-model.js';
import {
  priorityIndexEntries,
  sessionsRow,
  weightRow,
  wholeBodyCards,
} from '../spa/goals/whole-body-cards.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-31T12:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(START) + days * DAY_MS).toISOString();
const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({ index, isDeload: false }));

/** F6: a cut from 200 lb, 0.5 to 1 %/wk. `low` is the committed edge, so it is the higher number. */
const CUT_BAND: GoalBand = {
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  bandLowPctPerWeek: -0.5,
  bandHighPctPerWeek: -1,
  corridorPct: null,
  expected: WEEKS.map(({ index }) => ({
    weekIndex: index,
    low: 200 * (1 - 0.005 * (index - 1)),
    high: 200 * (1 - 0.01 * (index - 1)),
  })),
  committedValue: 193,
  stretchValue: 186,
  direction: 'down',
  provisional: false,
  notes: [],
};

const SESSIONS_BAND: GoalBand = {
  basis: 'execution_ramp',
  infoLevel: 'cold',
  bandLowPctPerWeek: 0,
  bandHighPctPerWeek: 0,
  corridorPct: 0,
  expected: WEEKS.map(({ index }) => ({ weekIndex: index, low: 12, high: 12 })),
  committedValue: 12,
  stretchValue: 12,
  direction: 'hold',
  provisional: false,
  notes: [],
};

const CUT_BODYWEIGHT: GoalBodyweightView = {
  dietPhase: { phase: 'fat-loss', weeksInPhase: 3, recompMode: null },
  rate: {
    observedPctPerWeek: -0.6,
    bandLowPctPerWeek: -0.5,
    bandHighPctPerWeek: -1,
    weeksOutsideBand: 0,
    vetoed: false,
  },
};

function priority(id: string, ref: string, over: Partial<StoredPriority> = {}): StoredPriority {
  return {
    id,
    userId: 'local',
    horizonWeeks: 8,
    kind: 'muscle',
    ref,
    level: 'maintain',
    declaredAt: START,
    mesosHeld: 1,
    ...over,
  };
}

function target(id: string, pri: StoredPriority, band: GoalBand, metric: string): StoredGoalTarget {
  return {
    id,
    priorityId: pri.id,
    metric,
    startValue: band.expected[0]!.low,
    startMeasuredAt: START,
    bandLowPctPerWeek: band.bandLowPctPerWeek,
    bandHighPctPerWeek: band.bandHighPctPerWeek,
    committedValue: band.committedValue,
    stretchValue: band.stretchValue,
    basis: band.basis,
    infoLevel: band.infoLevel,
    tierUsed: 'early-intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'fat-loss',
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: START,
    endsAt: at(56),
  } as StoredGoalTarget;
}

function reading(ts: string, value: number): GoalActual {
  return { ts, value, matched: true, isPR: false };
}

function view(
  pri: StoredPriority,
  tgt: StoredGoalTarget,
  band: GoalBand,
  input: Partial<GoalProgressInput> & { now: string },
): GoalProgressView {
  return buildGoalProgressView({
    priority: pri,
    target: tgt,
    band,
    calibrationEvidence: { matchedSessionCount: 6, baselineState: 'CALIBRATED' },
    actuals: [],
    weeks: WEEKS,
    dietState: { phase: 'fat-loss', weeksInPhase: 3 },
    ...input,
  });
}

const WEEK_3 = at(16);
const BODYWEIGHT = priority('pri-bw', 'bodyweight');
const SESSIONS = priority('pri-sessions', 'sessions');
const BENCH = priority('pri-bench', 'bench-press', { kind: 'lift', level: 'specialize' });

function cutView(input: Partial<GoalProgressInput> = {}): GoalProgressView {
  return view(BODYWEIGHT, target('tgt-bw', BODYWEIGHT, CUT_BAND, 'bodyweight'), CUT_BAND, {
    now: WEEK_3,
    actuals: [reading(at(9), 198.4), reading(at(15), 196.8)],
    bodyweight: CUT_BODYWEIGHT,
    ...input,
  });
}

function sessionsView(): GoalProgressView {
  const tgt = target('tgt-sessions', SESSIONS, SESSIONS_BAND, 'sessions_28d');
  return view(SESSIONS, tgt, SESSIONS_BAND, {
    now: WEEK_3,
    actuals: [reading(WEEK_3, 9)],
    sessionWindow: { days: [], agingOutNext7d: 3 },
  });
}

function page(...rows: [StoredPriority, GoalProgressView[]][]): GoalsPageData {
  const priorities: GoalPriorityRow[] = rows.map(([pri, views]) => ({
    priority: pri,
    targets: views.map((v) => v.target),
    rollup: null,
  }));
  return { priorities, progress: Object.fromEntries(rows.map(([pri, v]) => [pri.id, v])) };
}

describe('which whole-body cards the page draws', () => {
  it('drops the section with no bodyweight or sessions goal', () => {
    expect(wholeBodyCards(page([BENCH, []]))).toBeNull();
  });

  it('draws only the bodyweight card when only bodyweight is tracked', () => {
    const cards = wholeBodyCards(page([BODYWEIGHT, [cutView()]]));

    expect(cards?.bodyweight?.latest?.value).toBe(196.8);
    expect(cards?.sessions).toBeNull();
  });

  it('draws only the sessions card when only sessions are tracked', () => {
    const cards = wholeBodyCards(page([SESSIONS, [sessionsView()]]));

    expect(cards?.bodyweight).toBeNull();
    expect(cards?.sessions?.counted).toBe(9);
  });

  it('draws both cards when both goals are tracked', () => {
    const cards = wholeBodyCards(page([BODYWEIGHT, [cutView()]], [SESSIONS, [sessionsView()]]));

    expect(cards?.bodyweight).not.toBeNull();
    expect(cards?.sessions).not.toBeNull();
  });

  it('keeps an accepted bodyweight goal with no weigh-in yet, as "No weigh-in yet"', () => {
    const cards = wholeBodyCards(page([BODYWEIGHT, [cutView({ actuals: [] })]]));

    expect(cards?.bodyweight?.latest).toBeNull();
  });
});

describe('the bodyweight card', () => {
  it('carries the weigh-in, the cut direction, the phase and this week of the band', () => {
    const row = weightRow(cutView());

    expect(row).toMatchObject({
      unit: 'lb',
      direction: 'down',
      phase: { name: 'fat-loss' },
      latest: { value: 196.8, ts: at(15) },
      week: { index: 3, of: 8, low: 198, high: 196 },
      rate: {
        observedPctPerWeek: -0.6,
        bandLowPctPerWeek: -0.5,
        bandHighPctPerWeek: -1,
        vetoed: false,
      },
    });
    expect(row.basis).toBe(cutView().statusBasis);
  });

  it('passes no rate when the review has none, which the card reads as N/A', () => {
    const row = weightRow(cutView({ bodyweight: { ...CUT_BODYWEIGHT, rate: null } }));

    expect(row.rate).toBeNull();
  });

  it('names the phase unknown when the view carries no diet phase', () => {
    const { bodyweight: _omitted, ...input } = cutView();
    const row = weightRow({ ...input });

    expect(row.phase).toEqual({ name: 'unknown' });
    expect(row.rate).toBeNull();
  });

  it('marks a slow-loss recomposition so the tag says so', () => {
    const recomp: GoalBodyweightView = {
      dietPhase: { phase: 'recomposition', weeksInPhase: 2, recompMode: 'slow-loss' },
      rate: null,
    };

    expect(weightRow(cutView({ bodyweight: recomp })).phase).toEqual({
      name: 'recomposition',
      slowLoss: true,
    });
  });

  it('reads week 1 of a block that is calibrating on one weigh-in', () => {
    const calibrating = view(
      BODYWEIGHT,
      { ...target('tgt-bw', BODYWEIGHT, CUT_BAND, 'bodyweight'), infoLevel: 'cold' },
      { ...CUT_BAND, infoLevel: 'cold' },
      {
        now: at(1),
        actuals: [reading(at(0), 200)],
        bodyweight: { ...CUT_BODYWEIGHT, rate: null },
        calibrationEvidence: { matchedSessionCount: 0, baselineState: 'COLD' },
      },
    );

    const row = weightRow(calibrating);

    expect(row.status).toBe('calibrating');
    // The read model's own week-1 band, which opens to the first week's stretch step (VW-459).
    expect(row.week).toEqual({ index: 1, of: 8, low: 200, high: 198 });
    expect(row.rate).toBeNull();
  });
});

describe('the sessions card', () => {
  it('counts the window against the commitment, with what is due and what leaves', () => {
    const row = sessionsRow(sessionsView());

    expect(row).toMatchObject({
      counted: 9,
      committed: 12,
      windowDays: 28,
      agingOutNext7d: 3,
    });
    // 16 of the first window's 28 days have run, so 12 x 16/28 are due.
    expect(row.dueByNow).toBeCloseTo((12 * 16) / 28, 1);
  });
});

describe('the priority index', () => {
  it('lists every declared priority and names one nothing tracks', () => {
    const strength = priority('pri-strength', 'strength');

    const entries = priorityIndexEntries(
      page([BENCH, []], [BODYWEIGHT, [cutView()]], [strength, []]),
    );

    expect(entries).toEqual([
      { name: 'Bench press', level: 'specialize', hasTarget: false },
      { name: 'Bodyweight', level: 'maintain', hasTarget: true },
      { name: 'Strength', level: 'maintain', hasTarget: false },
    ]);
  });
});
