// A plateau is a flatline, not a slowdown (VW-452).
//
// Every series here is weekly top loads at 100 lb, where the programmed step is
// 2.5 lb/week, so the flatline threshold is 0.625 lb/week. WA's own detector
// calls ALL of the rising cases a plateau; the point of each is what this rule
// keeps of that finding.

import { detectPlateau } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import {
  FLATLINE_FRACTION_OF_STEP,
  FLATLINE_SMOOTHING,
  flatline,
  plateauReferenceStepLbs,
} from '../flatline.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekly(values: readonly number[]): { ts: string; value: number }[] {
  const start = Date.parse('2026-07-06T12:00:00.000Z');
  return values.map((value, index) => ({
    ts: new Date(start + index * WEEK_MS).toISOString(),
    value,
  }));
}

const RAMP_AT_100 = { expectedStepLbsPerWeek: plateauReferenceStepLbs(100), minDays: 14 };
const RAW_AT_100 = { ...RAMP_AT_100, smoothing: null };

describe('flatline', () => {
  it('uses the programmed step at 100 lb, so the threshold is a quarter of 2.5 lb', () => {
    expect(RAMP_AT_100.expectedStepLbsPerWeek).toBe(2.5);
    expect(FLATLINE_FRACTION_OF_STEP).toBe(0.25);
  });

  it('does not call a lifter climbing exactly on the ramp flat, though WA calls it a plateau', () => {
    const onRamp = weekly([100, 102.5, 105, 107.5, 110]);

    expect(detectPlateau(onRamp).isPlateau).toBe(true);
    expect(flatline(onRamp, RAMP_AT_100)).toBeNull();
  });

  it('does not call a climb at the committed (half-ramp) pace flat', () => {
    expect(flatline(weekly([100, 101.25, 102.5, 103.75, 105]), RAMP_AT_100)).toBeNull();
  });

  it('does not call a slow-but-rising lifter flat: a slowdown is not a stall', () => {
    expect(flatline(weekly([100, 101, 102, 103, 104]), RAMP_AT_100)).toBeNull();
  });

  it('calls three flat weeks at the same top load a flatline', () => {
    const run = flatline(weekly([100, 100, 100]), RAMP_AT_100);

    expect(run).toMatchObject({ days: 14, points: 3, slopeLbsPerWeek: 0 });
    expect(run?.flatBelowLbsPerWeek).toBeCloseTo(0.63, 2);
  });

  it('calls a noisy run around one load a flatline', () => {
    const run = flatline(weekly([100, 103, 98, 102, 99]), RAMP_AT_100);

    expect(run).toMatchObject({ days: 28, points: 5 });
    expect(run!.slopeLbsPerWeek).toBeLessThan(run!.flatBelowLbsPerWeek);
  });

  it('calls a gentle fall inside the window a flatline: a collapsed gain rate', () => {
    expect(flatline(weekly([104, 103, 102, 101, 100]), RAMP_AT_100)).toMatchObject({
      days: 28,
    });
  });

  it('leaves a steep fall to the other rules, because WA finds no plateau in it', () => {
    expect(flatline(weekly([146, 133, 121, 110, 100]), RAMP_AT_100)).toBeNull();
  });

  it('does not let one deload week inside a climb read as flat', () => {
    expect(flatline(weekly([100, 102.5, 105, 96, 107.5, 110]), RAMP_AT_100)).toBeNull();
  });

  it('finds the flat tail of a climb that stopped, and reports only the tail', () => {
    const run = flatline(weekly([90, 93, 96, 99, 100, 100, 100]), RAMP_AT_100);

    expect(run).toMatchObject({ days: 21, points: 4 });
  });

  it('keeps the 14-day floor: two flat weeks are not yet a flatline', () => {
    expect(flatline(weekly([100, 100]), RAMP_AT_100)).toBeNull();
  });

  it('judges against the step it is given, so a smaller expected step flags less', () => {
    const slow = weekly([100, 101, 102, 103, 104]);

    expect(flatline(slow, { ...RAMP_AT_100, expectedStepLbsPerWeek: 10 })).not.toBeNull();
    expect(flatline(slow, { ...RAMP_AT_100, expectedStepLbsPerWeek: 2 })).toBeNull();
  });

  it('takes the fraction as an argument', () => {
    const slow = weekly([100, 101, 102, 103, 104]);

    expect(flatline(slow, { ...RAMP_AT_100, flatFraction: 0.5 })).not.toBeNull();
  });

  it('never adds a plateau WA did not find', () => {
    const wide = weekly([100, 80, 120, 80, 120]);

    expect(detectPlateau(wide).isPlateau).toBe(false);
    expect(flatline(wide, { ...RAMP_AT_100, expectedStepLbsPerWeek: 1000 })).toBeNull();
  });
});

// VW-458: three or four noisy weekly points cannot resolve a slope as small as
// the threshold, so the input is steadied. One rule per test, and each one is
// the case a mutant of that rule gets wrong.
describe('flatline input smoothing', () => {
  it('defaults to a 14-day rolling top, a 21-day floor for a wobbling run, and one week of settled range', () => {
    expect(FLATLINE_SMOOTHING).toEqual({
      rollingTopDays: 14,
      unsettledMinDays: 21,
      settledRangeWeeks: 1,
    });
  });

  it('reads the slope off the rolling top, so one bad week at the end of a climb is not a flatline', () => {
    const climbThenBadWeek = weekly([100, 101.5, 103, 104.5, 100]);

    expect(flatline(climbThenBadWeek, RAW_AT_100)).not.toBeNull();
    expect(flatline(climbThenBadWeek, RAMP_AT_100)).toBeNull();
  });

  it('keeps the rolling top to 14 days, so one good week three reads ago does not hide a flatline', () => {
    expect(flatline(weekly([100, 100, 100, 103, 100, 100]), RAMP_AT_100)).toMatchObject({
      days: 35,
    });
  });

  it('makes a wobbling run wait for 21 days', () => {
    expect(flatline(weekly([102, 99, 101]), RAW_AT_100)).toMatchObject({ days: 14 });
    expect(flatline(weekly([102, 99, 101]), RAMP_AT_100)).toBeNull();
    expect(flatline(weekly([102, 99, 101, 100]), RAMP_AT_100)).toMatchObject({ days: 21 });
  });

  it('reads a settled run at the 14-day floor: within one week of flatline-rate movement', () => {
    expect(flatline(weekly([100, 100.5, 100]), RAMP_AT_100)).toMatchObject({ days: 14 });
    expect(flatline(weekly([100, 101, 100]), RAMP_AT_100)).toBeNull();
  });

  it('scales the settled range with the step, so a heavy lift may move a pound and stay settled', () => {
    const rampAt315 = { expectedStepLbsPerWeek: plateauReferenceStepLbs(315), minDays: 14 };

    expect(flatline(weekly([315, 316, 315]), rampAt315)).toMatchObject({ days: 14 });
  });

  it('adds no delay to a climb that stops dead: flat two weeks after the last step', () => {
    expect(flatline(weekly([95, 97.5, 100, 100]), RAMP_AT_100)).toBeNull();
    expect(flatline(weekly([95, 97.5, 100, 100, 100]), RAMP_AT_100)).toMatchObject({ days: 14 });
  });

  it('takes the smoothing as an argument', () => {
    const patient = { ...FLATLINE_SMOOTHING, unsettledMinDays: 28 };
    const lenient = { ...FLATLINE_SMOOTHING, settledRangeWeeks: 2 };
    const longMemory = { ...FLATLINE_SMOOTHING, rollingTopDays: 21 };
    const oneGoodWeek = weekly([100, 100, 100, 103, 100, 100]);

    const unsettled = weekly([102, 99, 101, 100]);
    const nearlySettled = weekly([100, 101, 100]);

    expect(flatline(unsettled, { ...RAMP_AT_100, smoothing: patient })).toBeNull();
    expect(flatline(nearlySettled, { ...RAMP_AT_100, smoothing: lenient })).not.toBeNull();
    expect(flatline(oneGoodWeek, { ...RAMP_AT_100, smoothing: longMemory })).toBeNull();
  });

  it('lets WA judge the raw run, so a rolling top cannot manufacture a plateau', () => {
    const wide = weekly([100, 80, 120, 80, 120]);

    expect(flatline(wide, { ...RAMP_AT_100, expectedStepLbsPerWeek: 1000 })).toBeNull();
  });
});

// How often does a noisy climber read flat on ONE read of 3 to 5 weekly points
// at 100 lb, ±3 lb uniform noise? A REPORT, not a tuning target: the rates are
// pinned so a change to the rule shows up as a changed number. `wa` is WA's
// detector alone, `raw` is VW-452's rule, `now` is VW-458's default. The
// week-by-week study, with delay, is `scripts/flatline-sim.mjs`.
describe('flatline false-stall rate for a noisy climber', () => {
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  function falseStallRates(points: number, stepLbs: number, draws: number) {
    const random = seeded(452);
    const flat = { wa: 0, raw: 0, now: 0 };
    for (let draw = 0; draw < draws; draw++) {
      const noisy = weekly(
        Array.from({ length: points }, (_, week) => 100 + stepLbs * week + (random() * 6 - 3)),
      );
      if (detectPlateau(noisy).isPlateau) flat.wa++;
      if (flatline(noisy, RAW_AT_100) !== null) flat.raw++;
      if (flatline(noisy, RAMP_AT_100) !== null) flat.now++;
    }
    return { wa: flat.wa / draws, raw: flat.raw / draws, now: flat.now / draws };
  }

  it.each([
    ['full ramp', 2.5, 3, 0.752, 0.068, 0.006],
    ['full ramp', 2.5, 4, 0.826, 0.068, 0.009],
    ['full ramp', 2.5, 5, 0.842, 0.076, 0.012],
    ['half ramp', 1.25, 3, 0.936, 0.32, 0.019],
    ['half ramp', 1.25, 4, 0.972, 0.384, 0.175],
    ['half ramp', 1.25, 5, 0.976, 0.419, 0.234],
  ])('%s (%f lb/wk) over %i weekly points', (_name, stepLbs, points, wa, raw, now) => {
    const rates = falseStallRates(points, stepLbs, 4000);

    expect(rates.wa).toBeCloseTo(wa, 2);
    expect(rates.raw).toBeCloseTo(raw, 2);
    expect(rates.now).toBeCloseTo(now, 2);
    expect(rates.now).toBeLessThan(rates.raw);
  });
});
