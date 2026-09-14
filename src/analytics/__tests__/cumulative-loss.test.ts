// VW-375 (research W4): fixtures for the shared cumulative-loss facts.
//
// Every band fixture is a weight that lands on or beside a cited cut point, so
// mutating that cut point moves the fixture into a different band and fails a
// named test (see the PR body for the mutation run).

import { describe, expect, it } from 'vitest';

import {
  classifyCumulativeLossPct,
  computeCumulativeLossFacts,
  CUMULATIVE_LOSS_CONSTANTS,
  CUMULATIVE_LOSS_SOURCE_ID,
  DIET_FATIGUE_BAND_ORDER,
  dietFatigueBandRank,
} from '../cumulative-loss.js';
import { computeBodyweightTrend, type BodyweightReading } from '../bodyweight-trend.js';
import { PHASE_SETTLING_WEEKS } from '../diet-phase-tolerance.js';

const PHASE_START_WEIGHT_LBS = 200;
const PHASE_STARTED_AT = '2026-01-01';
const NOW = '2026-03-15';

/** A settled week at one weight, so the 7-day mean is exactly that weight. */
function steadyWeek(bodyweightLbs: number): BodyweightReading[] {
  const days = ['03-09', '03-10', '03-11', '03-12', '03-13', '03-14', '03-15'];
  return days.map((day) => ({ measuredAt: `2026-${day}`, bodyweightLbs }));
}

function factsAt(bodyweightLbs: number, overrides: { now?: string; phaseStartedAt?: string } = {}) {
  return computeCumulativeLossFacts({
    readings: steadyWeek(bodyweightLbs),
    now: overrides.now ?? NOW,
    phaseStartedAt: overrides.phaseStartedAt ?? PHASE_STARTED_AT,
    targetLine: { startWeightLbs: PHASE_START_WEIGHT_LBS, weeklyRateLbs: -1 },
  });
}

describe('rp-s11-diet-fatigue-pct-weight-lost-proxy: the cited bands', () => {
  it('names the note it cites', () => {
    expect(CUMULATIVE_LOSS_SOURCE_ID).toBe('rp-s11-diet-fatigue-pct-weight-lost-proxy');
  });

  it('reports loss as a positive percent of phase-start weight', () => {
    const facts = factsAt(186);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(7, 10);
  });

  it('leaves a lifter below the lowest named band unbanded', () => {
    const facts = factsAt(197);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(1.5, 10);
    expect(facts.band).toBe('none');
    expect(facts.bandFloorPct).toBeNull();
  });

  // Pins `lowBandFloorPct` (3): mutate it to 4 and this fixture falls to 'none'.
  it('opens the low band exactly at the cited 3% lost', () => {
    const facts = factsAt(194);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(CUMULATIVE_LOSS_CONSTANTS.lowBandFloorPct, 10);
    expect(facts.band).toBe('low');
    expect(facts.bandFloorPct).toBe(CUMULATIVE_LOSS_CONSTANTS.lowBandFloorPct);
  });

  // Pins `noticeableBandFloorPct` (7): mutate it to 8 and this falls to 'low'.
  it('opens the noticeable band exactly at the cited 7% lost', () => {
    const facts = factsAt(186);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(
      CUMULATIVE_LOSS_CONSTANTS.noticeableBandFloorPct,
      10,
    );
    expect(facts.band).toBe('noticeable');
    expect(facts.bandFloorPct).toBe(CUMULATIVE_LOSS_CONSTANTS.noticeableBandFloorPct);
  });

  // Pins `significantBandFloorPct` (10): mutate it to 11 and this falls to
  // 'noticeable'. The note says "more than 10%"; the boundary is inclusive so
  // VW-346 §2d's crossing trigger fires at the crossing, not one step past it.
  it('opens the significant band at the cited 10% lost, inclusive', () => {
    const facts = factsAt(180);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(
      CUMULATIVE_LOSS_CONSTANTS.significantBandFloorPct,
      10,
    );
    expect(facts.band).toBe('significant');
    expect(facts.bandFloorPct).toBe(CUMULATIVE_LOSS_CONSTANTS.significantBandFloorPct);
  });

  // Pins `lowBandCitedCeilingPct` (5): mutate it and the equality below fails.
  it('holds the low band through the unnamed 5-7% gap rather than escalating early', () => {
    const atCitedCeiling = factsAt(190);
    const insideTheGap = factsAt(188);

    expect(atCitedCeiling.pctLostSincePhaseStart).toBeCloseTo(
      CUMULATIVE_LOSS_CONSTANTS.lowBandCitedCeilingPct,
      10,
    );
    expect(atCitedCeiling.band).toBe('low');
    expect(insideTheGap.pctLostSincePhaseStart).toBeGreaterThan(
      CUMULATIVE_LOSS_CONSTANTS.lowBandCitedCeilingPct,
    );
    expect(insideTheGap.band).toBe('low');
  });

  it('treats a gain as no diet-fatigue band at all', () => {
    const facts = factsAt(204);

    expect(facts.pctLostSincePhaseStart).toBeCloseTo(-2, 10);
    expect(facts.band).toBe('none');
  });
});

describe('classifyCumulativeLossPct: the bands without the series', () => {
  it('maps each cited cut point to the band it opens', () => {
    expect(classifyCumulativeLossPct(0)).toBe('none');
    expect(classifyCumulativeLossPct(CUMULATIVE_LOSS_CONSTANTS.lowBandFloorPct)).toBe('low');
    expect(classifyCumulativeLossPct(CUMULATIVE_LOSS_CONSTANTS.noticeableBandFloorPct)).toBe(
      'noticeable',
    );
    expect(classifyCumulativeLossPct(CUMULATIVE_LOSS_CONSTANTS.significantBandFloorPct)).toBe(
      'significant',
    );
  });

  it('ranks the bands weakest first, so an escalation is distinguishable', () => {
    expect(DIET_FATIGUE_BAND_ORDER).toEqual(['none', 'low', 'noticeable', 'significant']);
    expect(dietFatigueBandRank('significant')).toBeGreaterThan(dietFatigueBandRank('noticeable'));
    expect(dietFatigueBandRank('low')).toBeGreaterThan(dietFatigueBandRank('none'));
  });
});

describe('the trend facts come from computeBodyweightTrend, not a second implementation', () => {
  const input = {
    readings: steadyWeek(186),
    now: NOW,
    phaseStartedAt: PHASE_STARTED_AT,
    targetLine: { startWeightLbs: PHASE_START_WEIGHT_LBS, weeklyRateLbs: -1 },
  };

  it('passes the mean series, weekly delta and slope class through unchanged', () => {
    const facts = computeCumulativeLossFacts(input);
    const trend = computeBodyweightTrend(input);

    expect(facts.meanSeries).toEqual(trend.meanSeries);
    expect(facts.weeklyDeltaLbs).toBe(trend.weeklyDeltaLbs);
    expect(facts.slopeClass).toBe(trend.slopeClass);
    expect(facts.weeksInPhase).toBe(trend.weeksInPhase);
    expect(facts.rateClass).toBe(trend.rateClass);
  });

  it('reports the loss as unevaluable when the series is too thin for a mean', () => {
    const facts = computeCumulativeLossFacts({
      readings: [
        { measuredAt: '2026-03-14', bodyweightLbs: 186 },
        { measuredAt: '2026-03-15', bodyweightLbs: 186 },
      ],
      now: NOW,
      phaseStartedAt: PHASE_STARTED_AT,
      targetLine: { startWeightLbs: PHASE_START_WEIGHT_LBS, weeklyRateLbs: -1 },
    });

    expect(facts.pctLostSincePhaseStart).toBeNull();
    expect(facts.band).toBeNull();
    expect(facts.bandFloorPct).toBeNull();
  });

  it('still bands the loss inside the settling window, but says it is settling', () => {
    const facts = factsAt(186, { phaseStartedAt: '2026-03-08' });

    expect(facts.weeksInPhase).toBeLessThanOrEqual(PHASE_SETTLING_WEEKS);
    expect(facts.rateClass).toBe('settling');
    expect(facts.band).toBe('noticeable');
  });
});
