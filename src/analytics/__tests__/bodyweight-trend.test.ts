// VW-372 (research W1): fixtures for the pure bodyweight-trend facts.
//
// Each fixture pins a value against the specific cited constant it exercises,
// so a wrong constant fails a named test rather than sliding through
// (see PR body for the mutation proof: `noiseFloorLbsPerWeek` was flipped to
// 0.05 and reverted, and the noise-classification test below failed while it
// was wrong).

import { describe, expect, it } from 'vitest';

import {
  BODYWEIGHT_TREND_CONSTANTS,
  computeBodyweightTrend,
  GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK,
  type BodyweightReading,
  type BodyweightTargetLine,
} from '../bodyweight-trend.js';
import { GOAL_BAND_CONSTANTS } from '../goal-band.js';
import { PHASE_SETTLING_WEEKS } from '../diet-phase-tolerance.js';

const FLAT_TARGET: BodyweightTargetLine = { startWeightLbs: 180, weeklyRateLbs: 0 };

function readings(entries: readonly [string, number][]): BodyweightReading[] {
  return entries.map(([measuredAt, bodyweightLbs]) => ({ measuredAt, bodyweightLbs }));
}

describe('rp-s12-no-adjustment-under-half-pound-weekly-change: noise floor', () => {
  // Two 7-day windows a week apart, mean-to-mean delta 0.1 lb/wk — pinned
  // against `noiseFloorLbsPerWeek` (0.5): mutating that constant down below
  // 0.1 flips this fixture from `noise` to `reportable`.
  const RAW: readonly [string, number][] = [
    ['2026-03-02', 180.0],
    ['2026-03-03', 180.1],
    ['2026-03-04', 179.9],
    ['2026-03-05', 180.0],
    ['2026-03-06', 180.1],
    ['2026-03-07', 179.9],
    ['2026-03-08', 180.0],
    ['2026-03-09', 180.0],
    ['2026-03-10', 180.1],
    ['2026-03-11', 180.2],
    ['2026-03-12', 180.1],
    ['2026-03-13', 180.0],
    ['2026-03-14', 180.2],
    ['2026-03-15', 180.1],
  ];

  it('classifies a sub-noise-floor weekly change as noise and reports the delta', () => {
    const result = computeBodyweightTrend({
      readings: readings(RAW),
      now: '2026-03-15',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });

    expect(result.weeklyDeltaLbs).toBeCloseTo(0.1, 5);
    expect(Math.abs(result.weeklyDeltaLbs!)).toBeLessThan(
      BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek,
    );
    expect(result.rateClass).toBe('noise');
    expect(result.adjustments).toEqual([]);
  });

  it('is past the settling window, so noise (not settling) is what suppresses the rate', () => {
    const result = computeBodyweightTrend({
      readings: readings(RAW),
      now: '2026-03-15',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });

    expect(result.weeksInPhase).toBeGreaterThan(PHASE_SETTLING_WEEKS);
  });
});

describe('now is the only clock: readings after it are not seen (VW-463)', () => {
  it('computes the same trend with or without readings taken after now', () => {
    const upToNow = readings([
      ['2026-03-01', 182.0],
      ['2026-03-04', 181.5],
      ['2026-03-08', 181.0],
      ['2026-03-11', 180.5],
      ['2026-03-15', 180.0],
    ]);
    const later = readings([
      ['2026-03-18', 176.0],
      ['2026-03-22', 172.0],
    ]);
    const input = { now: '2026-03-15', phaseStartedAt: '2026-01-01', targetLine: FLAT_TARGET };

    const withLater = computeBodyweightTrend({ ...input, readings: [...upToNow, ...later] });

    expect(withLater).toEqual(computeBodyweightTrend({ ...input, readings: upToNow }));
  });
});

describe('rp-s12-scale-opacity-salt-and-water: single-day spike down-weighting', () => {
  // 03-09 -> 03-10 is a +3 lb jump, at/above `singleDaySpikeThresholdLbs`
  // (2.5). The window ending 03-10 down-weights that one reading by
  // `spikeDownweightFactor` (0.5) instead of excluding or fully counting it.
  const RAW: readonly [string, number][] = [
    ['2026-03-04', 180.0],
    ['2026-03-05', 180.0],
    ['2026-03-06', 180.0],
    ['2026-03-07', 180.0],
    ['2026-03-08', 180.0],
    ['2026-03-09', 180.0],
    ['2026-03-10', 183.0],
  ];

  it('names the spike as the reason, with the observed delta', () => {
    const result = computeBodyweightTrend({
      readings: readings(RAW),
      now: '2026-03-10',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });

    expect(result.adjustments).toEqual([
      expect.objectContaining({
        measuredAt: '2026-03-10',
        deltaLbs: 3,
        reason: expect.stringContaining('scale opacity'),
      }),
    ]);
  });

  it('pulls the window mean toward the down-weighted value, not the naive average', () => {
    const result = computeBodyweightTrend({
      readings: readings(RAW),
      now: '2026-03-10',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });
    const point = result.meanSeries.find((p) => p.measuredAt === '2026-03-10');

    // Naive average of six 180s and one 183 is ~180.4286; down-weighting the
    // spike to `spikeDownweightFactor` (0.5) pulls it to 180.2308. Mutating
    // either the threshold (so 03-10 goes undetected) or the factor changes
    // this number.
    const naiveAverage = (180 * 6 + 183) / 7;
    expect(point?.readingCount).toBe(7);
    expect(point?.meanLbs).toBeCloseTo(180.2308, 3);
    expect(point!.meanLbs).toBeLessThan(naiveAverage);
  });

  it('a spike that has aged out of the window entirely no longer touches the mean', () => {
    // `spikeDownweightDays` equals `meanWindowDays` (both 7), so the spike
    // reading leaves the window at the same moment its down-weighting would
    // have expired. Window ending 03-18 (03-12..03-18) never includes 03-10.
    const later: [string, number][] = [
      ...RAW,
      ['2026-03-16', 180.0],
      ['2026-03-17', 180.0],
      ['2026-03-18', 180.0],
    ];
    const result = computeBodyweightTrend({
      readings: readings(later),
      now: '2026-03-18',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });
    const point = result.meanSeries.find((p) => p.measuredAt === '2026-03-18');

    expect(point?.readingCount).toBe(3);
    expect(point?.meanLbs).toBeCloseTo(180.0, 5);
  });
});

describe('rp-s12-two-week-cap-for-slow-signal-situations / PHASE_SETTLING_WEEKS: settling', () => {
  it('returns settling, not a rate, inside week 1-2 of a phase even with a large weekly move', () => {
    const raw: [string, number][] = Array.from({ length: 19 }, (_, i) => {
      const day = new Date('2026-02-20T00:00:00.000Z');
      day.setUTCDate(day.getUTCDate() + i);
      return [day.toISOString().slice(0, 10), 190 - i] as [string, number];
    });

    const result = computeBodyweightTrend({
      readings: readings(raw),
      now: '2026-03-10',
      phaseStartedAt: '2026-03-01',
      targetLine: FLAT_TARGET,
    });

    expect(result.weeksInPhase).toBeLessThanOrEqual(PHASE_SETTLING_WEEKS);
    expect(Math.abs(result.weeklyDeltaLbs!)).toBeGreaterThanOrEqual(
      BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek,
    );
    expect(result.rateClass).toBe('settling');
  });
});

describe('rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope: slope class vs the target line', () => {
  // Actual bodyweight is flat at 180 for two windows a week apart; only the
  // target line's own slope changes across these three cases.
  const FLAT_ACTUAL: readonly [string, number][] = Array.from({ length: 14 }, (_, i) => {
    const day = new Date('2026-03-01T00:00:00.000Z');
    day.setUTCDate(day.getUTCDate() + i);
    return [day.toISOString().slice(0, 10), 180] as [string, number];
  });

  function slopeClassFor(targetLine: BodyweightTargetLine) {
    return computeBodyweightTrend({
      readings: readings(FLAT_ACTUAL),
      now: '2026-03-14',
      phaseStartedAt: '2026-02-01',
      targetLine,
    }).slopeClass;
  }

  it('a target line descending toward flat actual weight converges', () => {
    expect(slopeClassFor({ startWeightLbs: 186, weeklyRateLbs: -1 })).toBe('converging');
  });

  it('a target line matching flat actual weight is similar', () => {
    expect(slopeClassFor({ startWeightLbs: 180, weeklyRateLbs: 0 })).toBe('similar');
  });

  it('a target line climbing away from flat actual weight diverges', () => {
    expect(slopeClassFor({ startWeightLbs: 176, weeklyRateLbs: 1 })).toBe('diverging');
  });
});

describe('meanWindowMinReadings: below-threshold windows report no mean', () => {
  it('two readings inside the window do not clear the 3-reading floor', () => {
    const result = computeBodyweightTrend({
      readings: readings([
        ['2026-03-01', 180],
        ['2026-03-02', 180.2],
      ]),
      now: '2026-03-02',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });

    expect(result.meanSeries).toEqual([]);
    expect(result.weeklyDeltaLbs).toBeNull();
    expect(result.cumulativePctChangeSincePhaseStart).toBeNull();
  });
});

describe('meanWindowDays: the trailing window boundary is exclusive', () => {
  it('a reading exactly meanWindowDays back is outside the window', () => {
    const result = computeBodyweightTrend({
      readings: readings([
        ['2026-02-21', 170.0],
        ['2026-02-25', 180.0],
        ['2026-02-26', 180.0],
        ['2026-02-27', 180.0],
        ['2026-02-28', 180.0],
      ]),
      now: '2026-02-28',
      phaseStartedAt: '2026-01-01',
      targetLine: FLAT_TARGET,
    });
    const point = result.meanSeries.find((p) => p.measuredAt === '2026-02-28');

    expect(BODYWEIGHT_TREND_CONSTANTS.meanWindowDays).toBe(7);
    expect(point?.readingCount).toBe(4);
    expect(point?.meanLbs).toBeCloseTo(180.0, 5);
  });
});

describe('derived arithmetic (not a citation): the gain band slow edge sits inside the noise floor under 200 lb', () => {
  it('0.25%/wk at 200 lb equals the 0.5 lb/wk noise floor', () => {
    expect(GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK).toBe(GOAL_BAND_CONSTANTS.bodyweightGainPctPerWeek.low);
    expect((GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK / 100) * 200).toBeCloseTo(
      BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek,
      10,
    );
  });
});
