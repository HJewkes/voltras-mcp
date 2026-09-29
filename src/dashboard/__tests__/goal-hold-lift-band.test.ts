// A lift held through a diet phase reads one-sided (VW-486 S1): below its low
// edge is behind (or tolerated when the fat-loss phase softens the advice),
// above its high edge is ahead.
//
// Every band comes from `deriveGoalBand` with a non-beginner tier, so the
// fixtures carry the shape production builds: `direction: 'hold'`, no corridor.

import { describe, expect, it } from 'vitest';

import {
  buildGoalProgressView,
  type GoalActual,
  type GoalProgressInput,
} from '../read-models/goal-progress.js';
import {
  deriveGoalBand,
  type GoalBand,
  type GoalBandWeek,
  type GoalDietState,
} from '../../analytics/goal-band.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-03T00:00:00.000Z';
const WEEK_3 = '2026-08-18T12:00:00.000Z';
const START_VALUE = 170;

const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6].map((index) => ({ index, isDeload: false }));

const FAT_LOSS: GoalDietState = { phase: 'fat-loss', weeksInPhase: 6 };
const RECOMPOSITION: GoalDietState = { phase: 'recomposition', weeksInPhase: 6 };

const PRIORITY: StoredPriority = {
  id: 'pri-squat',
  userId: 'u1',
  blockId: 'blk-1',
  horizonWeeks: 6,
  kind: 'lift',
  ref: 'back-squat',
  level: 'maintain',
  declaredAt: START,
  mesosHeld: 1,
};

function heldBand(dietState: GoalDietState): GoalBand {
  return deriveGoalBand({
    metric: 'top_load_at_reps',
    startValue: START_VALUE,
    horizonWeeks: 6,
    weeks: WEEKS,
    tier: 'intermediate',
    infoLevel: 'ramp',
    dietState,
    layoff: false,
    matchedSessionCount: 6,
    baselineState: 'CALIBRATED',
    completedMesoCount: 1,
  });
}

function targetFor(band: GoalBand, dietState: GoalDietState): StoredGoalTarget {
  return {
    id: 'tgt-squat',
    priorityId: PRIORITY.id,
    metric: 'top_load_at_reps',
    exerciseId: 'back-squat',
    anchorReps: 5,
    startValue: START_VALUE,
    startMeasuredAt: START,
    bandLowPctPerWeek: band.bandLowPctPerWeek,
    bandHighPctPerWeek: band.bandHighPctPerWeek,
    committedValue: band.committedValue,
    stretchValue: band.stretchValue,
    basis: band.basis,
    infoLevel: band.infoLevel,
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: dietState.phase,
    acceptedBy: 'user',
    acknowledgedStretch: true,
    derivedAt: START,
    endsAt: '2026-09-14T00:00:00.000Z',
  };
}

function actual(weekIndex: number, value: number): GoalActual {
  const ts = new Date(Date.parse(START) + ((weekIndex - 1) * 7 + 1) * DAY_MS).toISOString();
  return { ts, value, matched: true, isPR: false };
}

/** Two flat readings in weeks 2 and 3, judged in week 3. */
function viewOf(band: GoalBand, value: number, readAs: GoalDietState, derivedUnder = readAs) {
  return runViewOf(band, [actual(2, value), actual(3, value)], readAs, derivedUnder);
}

function runViewOf(
  band: GoalBand,
  actuals: GoalActual[],
  readAs: GoalDietState,
  derivedUnder = readAs,
) {
  const input: GoalProgressInput = {
    priority: PRIORITY,
    target: targetFor(band, derivedUnder),
    band,
    calibrationEvidence: { matchedSessionCount: 6, baselineState: 'CALIBRATED' },
    actuals,
    weeks: WEEKS,
    now: WEEK_3,
    dietState: readAs,
  };
  return buildGoalProgressView(input);
}

/** Week 3's band row, and a value `spans` half-widths away from its midline. */
function week3(band: GoalBand) {
  const row = band.expected[2];
  const mid = (row.low + row.high) / 2;
  const halfSpan = (row.high - row.low) / 2;
  return { ...row, at: (spans: number) => mid + spans * halfSpan };
}

describe('a fat-loss lift band', () => {
  const band = heldBand(FAT_LOSS);
  const row = week3(band);

  it('derives as a one-sided hold', () => {
    expect(band.direction).toBe('hold');
    expect(band.corridorPct).toBeNull();
    expect(band.infoLevel).not.toBe('cold');
    expect(row.low).toBeLessThan(START_VALUE);
    expect(row.high).toBeGreaterThan(START_VALUE);
  });

  it('reads tolerated below its low edge when the phase softens the advice', () => {
    const view = viewOf(band, row.at(-1.2), FAT_LOSS);

    expect(view.status).toBe('tolerated');
    expect(view.statusBasis).toContain('rp:rp-s11-diet-phase-training-fatigue-coupling');
  });

  it('reads behind on the same reading once no phase softens the advice', () => {
    const view = viewOf(band, row.at(-1.2), { phase: 'maintenance', weeksInPhase: 6 }, FAT_LOSS);

    expect(view.status).toBe('behind');
  });

  it('reads ahead above its high edge', () => {
    const view = viewOf(band, row.at(1.2), FAT_LOSS);

    expect(view.status).toBe('ahead');
  });

  it('reads on track inside the band, above the midline', () => {
    const view = viewOf(band, row.at(0.5), FAT_LOSS);

    expect(view.status).toBe('on_track');
  });
});

describe('a recomposition lift band', () => {
  const band = heldBand(RECOMPOSITION);
  const row = week3(band);

  it('derives as a one-sided hold committed to the start value', () => {
    expect(band.direction).toBe('hold');
    expect(band.corridorPct).toBeNull();
    expect(row.low).toBe(START_VALUE);
    expect(row.high).toBeGreaterThan(START_VALUE);
  });

  it('reads behind below its low edge, since recomposition softens nothing', () => {
    const view = viewOf(band, START_VALUE - 5, RECOMPOSITION);

    expect(view.status).toBe('behind');
  });

  it('reads ahead above its high edge', () => {
    const view = viewOf(band, row.high + 5, RECOMPOSITION);

    expect(view.status).toBe('ahead');
  });

  // Measured from the midline, falling from above the band would read as closing on it.
  it('reads behind on a fall from above the band to below its low edge', () => {
    const view = runViewOf(band, [actual(2, row.at(4)), actual(3, row.at(-2.6))], RECOMPOSITION);

    expect(view.status).toBe('behind');
  });

  it('reads on track while climbing toward its low edge from under it', () => {
    const climb = [actual(1, row.at(-4)), actual(2, row.at(-3.3)), actual(3, row.at(-2.6))];
    const view = runViewOf(band, climb, RECOMPOSITION);

    expect(view.status).toBe('on_track');
  });
});
