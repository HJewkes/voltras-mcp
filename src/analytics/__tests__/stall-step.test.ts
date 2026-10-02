// The stall step and the flatline it reports (VW-452, VW-677). The rate rule
// itself is WA's `detectPlateau` rate mode and is tested there.

import { detectPlateau, type RatePlateauDetection } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import { PLATEAU_REFERENCE_STEP, flatlineOf, plateauReferenceStepLbs } from '../stall-step.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekly(values: readonly number[]): { ts: string; value: number }[] {
  const start = Date.parse('2026-07-06T12:00:00.000Z');
  return values.map((value, index) => ({
    ts: new Date(start + index * WEEK_MS).toISOString(),
    value,
  }));
}

function rateAt100(values: readonly number[]): RatePlateauDetection {
  return detectPlateau(weekly(values), {
    expectedRatePerWeek: plateauReferenceStepLbs(100),
    minDays: 14,
  });
}

describe('plateau reference step', () => {
  it('is 2.5% of the load, floored at 2.5 lb and capped at 10 lb', () => {
    expect(PLATEAU_REFERENCE_STEP).toEqual({ percentOfLoad: 2.5, floorLbs: 2.5, capLbs: 10 });
  });

  it('reads 2.5 lb at 100 lb, so the flatline threshold there is a quarter of that', () => {
    expect(plateauReferenceStepLbs(100)).toBe(2.5);
    expect(rateAt100([100, 100, 100]).flatBelowPerWeek).toBeCloseTo(0.63, 2);
  });

  it('holds the floor at a light load', () => {
    expect(plateauReferenceStepLbs(40)).toBe(2.5);
  });

  it("rounds down to the device's 1 lb step at a heavy load", () => {
    expect(plateauReferenceStepLbs(315)).toBe(7);
  });

  it('holds the cap at a very heavy load', () => {
    expect(plateauReferenceStepLbs(500)).toBe(10);
  });
});

describe('flatlineOf', () => {
  it('reports the flat run WA found, in pounds a week', () => {
    expect(flatlineOf(rateAt100([100, 100, 100]))).toEqual({
      days: 14,
      points: 3,
      slopeLbsPerWeek: 0,
      flatBelowLbsPerWeek: 0.63,
      reasoning:
        'Moved 0 per week over 14 days (3 points), under the flatline threshold of 0.63 per week',
    });
  });

  it('is null for a lifter climbing on the reference step, though the window form calls it a plateau', () => {
    const onRamp = [100, 102.5, 105, 107.5, 110];

    expect(detectPlateau(weekly(onRamp)).isPlateau).toBe(true);
    expect(flatlineOf(rateAt100(onRamp))).toBeNull();
  });
});

// How often does a noisy climber read flat on ONE read of 3 to 5 weekly points
// at 100 lb, ±3 lb uniform noise, judged at the reference step? A REPORT, not a
// tuning target: the rates are pinned so a change to the rule or the step shows
// up as a changed number. `wa` is WA's window form alone, `raw` is VW-452's rule,
// `now` is VW-458's default. The week-by-week study is `scripts/flatline-sim.mjs`.
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
    const rule = { expectedRatePerWeek: plateauReferenceStepLbs(100), minDays: 14 };
    const flat = { wa: 0, raw: 0, now: 0 };
    for (let draw = 0; draw < draws; draw++) {
      const noisy = weekly(
        Array.from({ length: points }, (_, week) => 100 + stepLbs * week + (random() * 6 - 3)),
      );
      if (detectPlateau(noisy).isPlateau) flat.wa++;
      if (detectPlateau(noisy, { ...rule, smoothing: null }).isPlateau) flat.raw++;
      if (detectPlateau(noisy, rule).isPlateau) flat.now++;
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
