// VW-373 (research W2): fixtures for the §2b control loop.
//
// Every fixture is built from a linear weight series whose trailing 7-day mean
// lands on a chosen distance from the goal line, so a cell of the deviation x
// slope table is selected by arithmetic rather than by luck. Mutating a cited
// threshold moves a fixture into a neighbouring cell and fails a named test
// (see the PR body for the mutation run).

import { describe, expect, it } from 'vitest';

import {
  BODYWEIGHT_RATE_CONSTANTS,
  classifyDeviationBand,
  computeBodyweightRateAdvisory,
  rateBandForPhase,
  type BodyweightRateAdvisory,
  type BodyweightRateAdvisoryInput,
  type WeeklySelfReport,
} from '../bodyweight-rate-advisory.js';
import { type BodyweightReading } from '../bodyweight-trend.js';
import { GOAL_BAND_CONSTANTS } from '../goal-band.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PHASE_STARTED_AT = '2026-01-01T00:00:00.000Z';
const NOW = '2026-03-15T00:00:00.000Z';
const TARGET_LINE = { startWeightLbs: 200, weeklyRateLbs: -1.5 };
const SERIES_DAYS = 28;

function shift(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** Where the goal line sits at `NOW`, the same arithmetic the module does. */
const TARGET_AT_NOW_LBS =
  TARGET_LINE.startWeightLbs +
  (TARGET_LINE.weeklyRateLbs * (new Date(NOW).getTime() - new Date(PHASE_STARTED_AT).getTime())) /
    (7 * DAY_MS);

/**
 * A daily series whose trailing 7-day mean at `NOW` is exactly
 * `TARGET_AT_NOW_LBS + gapLbs`, moving at `lbsPerWeek`. The mean of seven
 * equally spaced points ending at day 0 is the value three days back, which is
 * what the `3 * slopePerDay` offset cancels.
 */
function seriesWithGap(gapLbs: number, lbsPerWeek: number): BodyweightReading[] {
  const slopePerDay = lbsPerWeek / 7;
  const base = TARGET_AT_NOW_LBS + gapLbs + 3 * slopePerDay;
  return Array.from({ length: SERIES_DAYS }, (_, i) => {
    const dayOffset = -(SERIES_DAYS - 1 - i);
    return {
      measuredAt: shift(NOW, dayOffset),
      bodyweightLbs: base + slopePerDay * dayOffset,
    };
  });
}

interface FixtureOptions {
  gapLbs: number;
  lbsPerWeek: number;
  lastProposalDaysAgo?: number;
  phase?: BodyweightRateAdvisoryInput['phase'];
  recompMode?: BodyweightRateAdvisoryInput['recompMode'];
  phaseStartedAt?: string;
  selfReport?: WeeklySelfReport;
  readings?: BodyweightReading[];
}

function advisoryFor(options: FixtureOptions): BodyweightRateAdvisory {
  const input: BodyweightRateAdvisoryInput = {
    trend: {
      readings: options.readings ?? seriesWithGap(options.gapLbs, options.lbsPerWeek),
      now: NOW,
      phaseStartedAt: options.phaseStartedAt ?? PHASE_STARTED_AT,
      targetLine: TARGET_LINE,
    },
    phase: options.phase ?? 'fat-loss',
    lastProposalAt: shift(NOW, -(options.lastProposalDaysAgo ?? 8)),
    ...(options.recompMode === undefined ? {} : { recompMode: options.recompMode }),
    ...(options.selfReport === undefined ? {} : { selfReport: options.selfReport }),
  };
  return computeBodyweightRateAdvisory(input);
}

/** Gaps chosen to land inside each of RP's three deviation bands at ~185 lb. */
const SMALL_GAP_LBS = 0.3;
const MODERATE_GAP_LBS = 1;
const LARGE_GAP_LBS = 3;
/** Slower than the goal line, so the gap widens. */
const DIVERGING_LBS_PER_WEEK = -0.6;
/**
 * Barely slower than the goal line, so a SMALL gap widens without the gap
 * having crossed the line a week ago — an absolute deviation that changed sign
 * reads as converging, which is correct and not the cell under test here.
 */
const SMALL_DIVERGING_LBS_PER_WEEK = -1.2;
/** Exactly the goal line's own rate, so the gap holds. */
const SIMILAR_LBS_PER_WEEK = TARGET_LINE.weeklyRateLbs;
/** Faster than the goal line, so the gap closes. */
const CONVERGING_LBS_PER_WEEK = -3;

describe('rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope: the deviation bands', () => {
  it('classifies below a quarter percent of bodyweight as small', () => {
    expect(classifyDeviationBand(BODYWEIGHT_RATE_CONSTANTS.deviationSmallCeilingPct - 0.01)).toBe(
      'small',
    );
  });

  it('classifies the quarter-to-one percent range as moderate', () => {
    expect(classifyDeviationBand(BODYWEIGHT_RATE_CONSTANTS.deviationSmallCeilingPct)).toBe(
      'moderate',
    );
    expect(classifyDeviationBand(BODYWEIGHT_RATE_CONSTANTS.deviationModerateCeilingPct)).toBe(
      'moderate',
    );
  });

  it('classifies above one percent of bodyweight as large', () => {
    expect(
      classifyDeviationBand(BODYWEIGHT_RATE_CONSTANTS.deviationModerateCeilingPct + 0.01),
    ).toBe('large');
  });
});

describe('the deviation x slope table, one test per cell region', () => {
  it('proposes nothing for a small gap on a converging slope', () => {
    const result = advisoryFor({ gapLbs: SMALL_GAP_LBS, lbsPerWeek: CONVERGING_LBS_PER_WEEK });

    expect(result.observation.deviationBand).toBe('small');
    expect(result.observation.slopeClass).toBe('converging');
    expect(result.urgencyRank).toBe(0);
    expect(result.outcome).toBe('within_band');
    expect(result.advisory).toBeNull();
  });

  it('proposes the lowest urgency for a small gap on a diverging slope', () => {
    const result = advisoryFor({ gapLbs: SMALL_GAP_LBS, lbsPerWeek: SMALL_DIVERGING_LBS_PER_WEEK });

    expect(result.observation.deviationBand).toBe('small');
    expect(result.observation.slopeClass).toBe('diverging');
    expect(result.urgencyRank).toBe(1);
    expect(result.outcome).toBe('advisory');
  });

  it('proposes the middle urgency for a moderate gap on a similar slope', () => {
    const result = advisoryFor({ gapLbs: MODERATE_GAP_LBS, lbsPerWeek: SIMILAR_LBS_PER_WEEK });

    expect(result.observation.deviationBand).toBe('moderate');
    expect(result.observation.slopeClass).toBe('similar');
    expect(result.urgencyRank).toBe(2);
    expect(result.outcome).toBe('advisory');
  });

  it('proposes the highest urgency for a large gap on a diverging slope', () => {
    const result = advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: DIVERGING_LBS_PER_WEEK });

    expect(result.observation.deviationBand).toBe('large');
    expect(result.observation.slopeClass).toBe('diverging');
    expect(result.urgencyRank).toBe(3);
    expect(result.outcome).toBe('advisory');
  });

  it('rp-s12-trend-slope-overrides-raw-deviation: a converging slope silences even a large gap', () => {
    const result = advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: CONVERGING_LBS_PER_WEEK });

    expect(result.observation.deviationBand).toBe('large');
    expect(result.observation.slopeClass).toBe('converging');
    expect(result.urgencyRank).toBe(0);
    expect(result.outcome).toBe('within_band');
  });
});

describe('the emitted advisory', () => {
  const result = advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: DIVERGING_LBS_PER_WEEK });

  it('states the observed rate, the span, and the band it is measured against', () => {
    expect(result.advisory).toContain('%/wk over the last');
    expect(result.advisory).toContain('against a 0.5-1%/wk band');
    expect(result.observation.weeksOutsideBand).toBeGreaterThan(0);
  });

  it('rp-s12-activity-vs-food-adjustment-choice: names both levers and sizes neither', () => {
    expect(result.advisory).toContain('intake and activity');
    expect(result.advisory).toContain('does not size either');
    expect(result.levers).toEqual(['intake', 'activity']);
  });
});

describe('rp-s12-minimum-half-week-before-recalorie-change: cadence', () => {
  it('emits on the weekly cadence', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      lastProposalDaysAgo: BODYWEIGHT_RATE_CONSTANTS.weeklyCadenceDays,
    });

    expect(result.outcome).toBe('advisory');
  });

  it('refuses anything inside the half-week floor, whatever the signal says', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      lastProposalDaysAgo: 2,
      selfReport: { hunger: 'low' },
    });

    expect(result.outcome).toBe('below_half_week_floor');
    expect(result.advisory).toBeNull();
  });
});

describe('rp-s12-early-adjustment-signal-combo: the off-cadence gate', () => {
  const offCadenceDaysAgo = 5;

  it('fires off cadence only when all three conditions hold', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      lastProposalDaysAgo: offCadenceDaysAgo,
      selfReport: { hunger: 'low' },
    });

    expect(result.offCadenceConditions.every((c) => c.met)).toBe(true);
    expect(result.outcome).toBe('advisory');
  });

  it('holds off cadence with two of the three conditions', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      lastProposalDaysAgo: offCadenceDaysAgo,
      selfReport: { hunger: 'high' },
    });

    const met = result.offCadenceConditions.filter((c) => c.met).map((c) => c.condition);
    expect(met).toEqual(['drastic', 'consistent']);
    expect(result.outcome).toBe('awaiting_cadence');
    expect(result.advisory).toBeNull();
  });

  it('holds off cadence when the deviation is not drastic', () => {
    const result = advisoryFor({
      gapLbs: SMALL_GAP_LBS,
      lbsPerWeek: SMALL_DIVERGING_LBS_PER_WEEK,
      lastProposalDaysAgo: offCadenceDaysAgo,
      selfReport: { hunger: 'low' },
    });

    const met = result.offCadenceConditions.filter((c) => c.met).map((c) => c.condition);
    expect(met).toEqual(['consistent', 'corroborated']);
    expect(result.outcome).toBe('awaiting_cadence');
  });
});

describe('the four vetoes of §2b, each named in the result', () => {
  function vetoNames(result: BodyweightRateAdvisory): string[] {
    return result.vetoes.map((v) => v.veto);
  }

  it('rp-s12-exclude-water-weight-from-phase-transition-baseline: settling weeks', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      phaseStartedAt: shift(NOW, -7),
    });

    expect(vetoNames(result)).toContain('settling');
    expect(result.outcome).toBe('vetoed');
    expect(result.advisory).toBeNull();
  });

  it('rp-s12-no-adjustment-under-half-pound-weekly-change: the noise floor', () => {
    const result = advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: -0.2 });

    expect(vetoNames(result)).toContain('noise_floor');
    expect(result.outcome).toBe('vetoed');
  });

  it('rp-s12-scale-opacity-salt-and-water: a single-day spike still inside its window', () => {
    const readings = seriesWithGap(LARGE_GAP_LBS, DIVERGING_LBS_PER_WEEK).map((r) =>
      r.measuredAt === shift(NOW, -3) ? { ...r, bodyweightLbs: r.bodyweightLbs + 3 } : r,
    );
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      readings,
    });

    expect(vetoNames(result)).toContain('spike_in_window');
    expect(result.outcome).toBe('vetoed');
  });

  it('rp-s12-late-diet-salt-sweetener-creep-masks-fat-loss: flat late in a cut with good adherence', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: 0.6,
      selfReport: { dietPlanAdherence: 'high' },
    });

    expect(vetoNames(result)).toContain('salt_and_sweetener_creep');
    expect(result.outcome).toBe('vetoed');
  });

  it('every veto names a mined note id', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      phaseStartedAt: shift(NOW, -7),
    });

    for (const veto of result.vetoes) {
      expect(veto.sourceId).toMatch(/^rp-s\d+-/);
      expect(veto.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('rp-s12-two-week-cap-for-slow-signal-situations', () => {
  it('forces a flag once an unresolved signal has sat for two weeks', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: -0.2,
      lastProposalDaysAgo: BODYWEIGHT_RATE_CONSTANTS.twoWeekCapDays,
    });

    expect(result.outcome).toBe('flagged_for_review');
    expect(result.advisory).toContain('flagged for a decision');
    expect(result.vetoes.map((v) => v.veto)).toContain('noise_floor');
  });

  it('leaves a still-fresh veto alone', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: -0.2,
      lastProposalDaysAgo: BODYWEIGHT_RATE_CONSTANTS.twoWeekCapDays - 1,
    });

    expect(result.outcome).toBe('vetoed');
  });
});

describe('methodology §4: a hold band has no rate to autoregulate', () => {
  it('declines to run on maintenance', () => {
    const result = advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      phase: 'maintenance',
    });

    expect(result.outcome).toBe('no_rate_to_autoregulate');
    expect(result.advisory).toBeNull();
    expect(result.urgencyRank).toBe(0);
  });

  it('declines to run on a recomposition held at bodyweight', () => {
    expect(rateBandForPhase('recomposition', 'hold')).toBeNull();
  });

  it('runs a slow-loss recomposition against the same band the goal derives (VW-468)', () => {
    expect(rateBandForPhase('recomposition', 'slow-loss')).toEqual({ low: 0, high: -0.5 });
    expect(rateBandForPhase('gain')).toEqual(GOAL_BAND_CONSTANTS.bodyweightGainPctPerWeek);
  });
});

describe('methodology §2d: sleep is a confounder line, never a trigger', () => {
  const base = { gapLbs: LARGE_GAP_LBS, lbsPerWeek: DIVERGING_LBS_PER_WEEK };

  it('changes no gate when sleep is reported low', () => {
    const withLowSleep = advisoryFor({ ...base, selfReport: { sleepQuality: 'low' } });
    const withHighSleep = advisoryFor({ ...base, selfReport: { sleepQuality: 'high' } });

    expect(withLowSleep.outcome).toBe(withHighSleep.outcome);
    expect(withLowSleep.urgencyRank).toBe(withHighSleep.urgencyRank);
    expect(withLowSleep.vetoes).toEqual(withHighSleep.vetoes);
    expect(withLowSleep.advisory).toBe(withHighSleep.advisory);
  });

  it('reports low sleep as a confounder', () => {
    const result = advisoryFor({ ...base, selfReport: { sleepQuality: 'low' } });

    expect(result.confounders.join(' ')).toContain('never as a rate trigger');
  });

  it('rp-s12-off-plan-eating-disclosure-pattern: low adherence marks the period low-confidence', () => {
    const result = advisoryFor({ ...base, selfReport: { dietPlanAdherence: 'low' } });

    expect(result.lowConfidence).toBe(true);
    expect(result.confounders.join(' ')).toContain('low-confidence');
  });
});

describe('VW-376 persistence: inputs and thresholds are plain data', () => {
  const result = advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: DIVERGING_LBS_PER_WEEK });

  it('round-trips inputs through JSON unchanged', () => {
    expect(JSON.parse(JSON.stringify(result.inputs))).toEqual(result.inputs);
    expect(result.inputs.phase).toBe('fat-loss');
    expect(result.inputs.readingCount).toBe(SERIES_DAYS);
  });

  it('carries every threshold the decision turned on', () => {
    expect(JSON.parse(JSON.stringify(result.thresholds))).toEqual(result.thresholds);
    expect(result.thresholds.bandLowPctPerWeek).toBe(
      GOAL_BAND_CONSTANTS.bodyweightFatLossPctPerWeek.low,
    );
    expect(result.thresholds.halfWeekFloorDays).toBe(BODYWEIGHT_RATE_CONSTANTS.halfWeekFloorDays);
    expect(result.thresholds.twoWeekCapDays).toBe(BODYWEIGHT_RATE_CONSTANTS.twoWeekCapDays);
  });
});

describe('the module prescribes nothing: no kcal figure, no macro, no sized adjustment', () => {
  const everyOutcome: BodyweightRateAdvisory[] = [
    advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: DIVERGING_LBS_PER_WEEK }),
    advisoryFor({ gapLbs: MODERATE_GAP_LBS, lbsPerWeek: SIMILAR_LBS_PER_WEEK }),
    advisoryFor({ gapLbs: SMALL_GAP_LBS, lbsPerWeek: CONVERGING_LBS_PER_WEEK }),
    advisoryFor({ gapLbs: LARGE_GAP_LBS, lbsPerWeek: -0.2 }),
    advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: -0.2,
      lastProposalDaysAgo: BODYWEIGHT_RATE_CONSTANTS.twoWeekCapDays,
    }),
    advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: 0.6,
      selfReport: { dietPlanAdherence: 'high', sleepQuality: 'low', hunger: 'high' },
    }),
    advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      phaseStartedAt: shift(NOW, -7),
    }),
    advisoryFor({
      gapLbs: LARGE_GAP_LBS,
      lbsPerWeek: DIVERGING_LBS_PER_WEEK,
      phase: 'maintenance',
    }),
  ];

  /** Every string anywhere in the result, however deeply nested. */
  function everyString(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(everyString);
    if (value !== null && typeof value === 'object') {
      return Object.values(value).flatMap(everyString);
    }
    return [];
  }

  const NUTRITION_WORDS = /\b(kcal|calories?|caloric|macros?|protein|carbohydrates?|carbs?)\b/i;
  const RP_SIZING_BANDS = ['0-10%', '10-20%', '20-40%'];
  const SIZED_ADJUSTMENT = /\b(increase|decrease|reduce|raise|cut|add|drop)\b[^.]{0,30}\d+\s*%/i;

  it('never names a calorie or a macro in any string field', () => {
    for (const result of everyOutcome) {
      for (const text of everyString(result)) {
        expect(text).not.toMatch(NUTRITION_WORDS);
      }
    }
  });

  it("never surfaces RP's own adjustment-sizing percentages", () => {
    for (const result of everyOutcome) {
      const strings = everyString(result);
      for (const text of strings) {
        expect(RP_SIZING_BANDS.some((bandText) => text.includes(bandText))).toBe(false);
        expect(text).not.toMatch(SIZED_ADJUSTMENT);
      }
    }
  });

  it('keeps the urgency rank numeric so it cannot leak into copy', () => {
    for (const result of everyOutcome) {
      expect(typeof result.urgencyRank).toBe('number');
      expect(result.urgencyRank).toBeGreaterThanOrEqual(0);
      expect(result.urgencyRank).toBeLessThanOrEqual(3);
    }
  });
});

describe('a slow-loss recomposition commits to holding weight (VW-468)', () => {
  const HOLD_LINE = { startWeightLbs: 190, weeklyRateLbs: 0 };

  /** A daily series whose trailing 7-day mean at `NOW` is `meanLbs`, moving at `lbsPerWeek`. */
  function seriesEndingAt(meanLbs: number, lbsPerWeek: number): BodyweightReading[] {
    const slopePerDay = lbsPerWeek / 7;
    return Array.from({ length: SERIES_DAYS }, (_, i) => {
      const dayOffset = -(SERIES_DAYS - 1 - i);
      return {
        measuredAt: shift(NOW, dayOffset),
        bodyweightLbs: meanLbs + 3 * slopePerDay + slopePerDay * dayOffset,
      };
    });
  }

  function slowLoss(meanLbs: number, lbsPerWeek: number): BodyweightRateAdvisory {
    return computeBodyweightRateAdvisory({
      trend: {
        readings: seriesEndingAt(meanLbs, lbsPerWeek),
        now: NOW,
        phaseStartedAt: PHASE_STARTED_AT,
        targetLine: HOLD_LINE,
      },
      phase: 'recomposition',
      recompMode: 'slow-loss',
      lastProposalAt: shift(NOW, -8),
    });
  }

  it('reads a flat week as on track, not as noise to veto', () => {
    const result = slowLoss(190, 0);
    expect(result.vetoes).toEqual([]);
    expect(result.outcome).toBe('within_band');
  });

  it('reads a sub-noise drift up as flat, so still on track', () => {
    expect(slowLoss(190.2, 0.3).outcome).toBe('within_band');
  });

  it('reads a gaining lifter as behind the hold line, not ahead of it', () => {
    const result = slowLoss(193, 0.8);
    expect(result.observation.deviationDirection).toBe('behind');
    expect(result.outcome).toBe('advisory');
  });

  it('does not correct a loss inside the band: that is the stretch being earned', () => {
    const result = slowLoss(182, -0.8);
    expect(result.observation.deviationDirection).toBe('ahead');
    expect(result.outcome).toBe('within_band');
  });

  it('runs the ladder again once the loss is faster than the stretch edge', () => {
    expect(slowLoss(175, -2.5).outcome).toBe('advisory');
  });
});
