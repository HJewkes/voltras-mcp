// A plateau is a flatline, not a slowdown (VW-452).
//
// Every series here is weekly top loads at 100 lb, where the programmed step is
// 2.5 lb/week, so the flatline threshold is 0.625 lb/week. WA's own detector
// calls ALL of the rising cases a plateau; the point of each is what this rule
// keeps of that finding.

import { detectPlateau } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import { FLATLINE_FRACTION_OF_STEP, flatline } from '../flatline.js';
import { programmedRampStepLbs } from '../goal-band.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekly(values: readonly number[]): { ts: string; value: number }[] {
  const start = Date.parse('2026-07-06T12:00:00.000Z');
  return values.map((value, index) => ({
    ts: new Date(start + index * WEEK_MS).toISOString(),
    value,
  }));
}

const RAMP_AT_100 = { expectedStepLbsPerWeek: programmedRampStepLbs(100), minDays: 14 };

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
