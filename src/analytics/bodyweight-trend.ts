// VW-372 (research W1): the pure bodyweight-trend facts — a smoothed daily
// mean, the weekly delta computed from it, a slope class against a target
// line, and cumulative percent change since phase start.
//
// PURE. No store, no clock: `now` is an input, like `weeksInPhaseAt`'s own
// `nowIso`. This module answers "what does the series say", never "what
// should change" — the deviation x slope sizing table, cadence, and vetoes
// that turn this into a proposal are VW-373/W2's job, reading these facts.
//
// EVERY CONSTANT NAMES ITS SOURCE, same convention as `diet-phase-tolerance.ts`
// and `goal-band.ts`: `rp:<id>` for a mined note, ENGINEERING DEFAULT for a
// number the corpus does not state.

import { PHASE_SETTLING_WEEKS, weeksInPhaseAt } from './diet-phase-tolerance.js';

/** One logged bodyweight reading. Readings need not arrive in order. */
export interface BodyweightReading {
  measuredAt: string;
  bodyweightLbs: number;
}

/**
 * The goal line this trend is judged against: a starting weight and a signed
 * weekly rate (negative for loss, positive for gain) declared at phase start.
 */
export interface BodyweightTargetLine {
  startWeightLbs: number;
  weeklyRateLbs: number;
}

export interface BodyweightTrendInput {
  readings: readonly BodyweightReading[];
  /** ISO instant this trend is computed as of. Never `Date.now()` inside the module. */
  now: string;
  phaseStartedAt: string;
  targetLine: BodyweightTargetLine;
}

/** One point of the smoothed daily series. */
export interface BodyweightMeanPoint {
  measuredAt: string;
  meanLbs: number;
  readingCount: number;
}

/** A single-day jump the mean series down-weighted, and why. */
export interface BodyweightSpikeAdjustment {
  measuredAt: string;
  deltaLbs: number;
  reason: string;
}

/** Whether a weekly change is worth reporting a rate for at all. */
export type BodyweightRateClass = 'noise' | 'settling' | 'reportable';

/** RP's own words for the slope of the deviation from the goal line. */
export type BodyweightSlopeClass = 'converging' | 'similar' | 'diverging';

export interface BodyweightTrendResult {
  meanSeries: readonly BodyweightMeanPoint[];
  weeklyDeltaLbs: number | null;
  rateClass: BodyweightRateClass;
  slopeClass: BodyweightSlopeClass | null;
  cumulativePctChangeSincePhaseStart: number | null;
  weeksInPhase: number;
  adjustments: readonly BodyweightSpikeAdjustment[];
}

/**
 * Every magnitude this module runs on, labelled by source. Mirrors
 * `GOAL_BAND_CONSTANTS`'s labelling convention (`diet-phase-tolerance.ts`,
 * `goal-band.ts`): `rp:<id>` is a citation, ENGINEERING DEFAULT is not.
 */
export const BODYWEIGHT_TREND_CONSTANTS = {
  /**
   * Trailing window the daily mean is smoothed over, in days.
   *
   * ENGINEERING DEFAULT, OURS NOT RP'S. The corpus specifies no window for the
   * rolling average, only a weekly cadence "with some recency-weighting"
   * (rp:rp-s12-minimum-half-week-before-recalorie-change) and a slope over
   * "the last several data points" (rp:rp-s12-trend-slope-overrides-raw-deviation).
   * 7 days matches the window `profile.get_body_metrics` already reports
   * (`SEVEN_DAY_MEAN_WINDOW_DAYS`, `src/tools/profile-tools.ts`), not imported
   * from there because `src/analytics/**` may not depend on `src/tools/**`
   * (VW-362, enforced by `no-tools-imports.test.ts`) — this is a second
   * statement of the same engineering choice, not a second source of truth.
   */
  meanWindowDays: 7,
  /**
   * Readings required inside the window before a mean is reported at all.
   *
   * ENGINEERING DEFAULT, OURS NOT RP'S, matching
   * `SEVEN_DAY_MEAN_MIN_READINGS` (`src/tools/profile-tools.ts`) for the same
   * reason `meanWindowDays` does.
   */
  meanWindowMinReadings: 3,
  /**
   * Below this weekly change, in lb/week, nothing fires: `rateClass` reports
   * `'noise'` and no rate is reported. rp:rp-s12-no-adjustment-under-half-pound-weekly-change
   */
  noiseFloorLbsPerWeek: 0.5,
  /**
   * A single-day jump at or above this many lbs is scale opacity (salt,
   * water, a phase transition), not tissue change.
   *
   * rp:rp-s12-scale-opacity-salt-and-water is the citation for the RULE — it
   * names the trigger as a "multi-pound" single-day swing, no numeric
   * threshold. Its own "2 lb" is illustrative calorie math (2 lb of true
   * tissue needs ~7,000+ excess kcal in a day), not a stated cut point. The
   * exact lb value here is an ENGINEERING DEFAULT the note does not supply.
   */
  singleDaySpikeThresholdLbs: 2.5,
  /**
   * How many days a flagged spike reading stays down-weighted.
   *
   * rp:rp-s12-scale-opacity-salt-and-water ("wait roughly a week").
   */
  spikeDownweightDays: 7,
  /**
   * Weight applied to a flagged spike reading inside a mean window, instead
   * of dropping it outright.
   *
   * ENGINEERING DEFAULT. The note says to wait, not to discard the reading.
   */
  spikeDownweightFactor: 0.5,
  /**
   * How much a deviation from the target line has to shrink or grow, in lbs,
   * to count as `'converging'` / `'diverging'` rather than `'similar'`.
   *
   * ENGINEERING DEFAULT. The corpus states the three-way slope vocabulary
   * (rp:rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope) but no
   * numeric width for the flat middle case.
   */
  slopeSimilarBandLbs: 0.2,
} as const;

/**
 * DERIVED ARITHMETIC, NOT A CITATION. 0.25%/wk (the gain band's slow edge,
 * `rp:rp-s11-muscle-gain-rate-heuristic`) is 0.5 lb/wk at 200 lb — exactly
 * `noiseFloorLbsPerWeek`. Below 200 lb bodyweight the gain band's slow edge
 * sits inside the noise floor, so a weekly verdict on a gain phase is
 * unresolvable for most people; a fat-loss verdict (slow edge 0.5%/wk) clears
 * the same floor down to 100 lb. Exercised directly in the test file.
 */
export const GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK = 0.25;

function sortedReadings(readings: readonly BodyweightReading[]): BodyweightReading[] {
  return [...readings].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
}

/** The readings taken at or before `nowIso`: a trend as of an instant cannot see past it. */
export function readingsAsOf<T extends BodyweightReading>(
  readings: readonly T[],
  nowIso: string,
): T[] {
  const cutoff = Date.parse(nowIso);
  return readings.filter((r) => Date.parse(r.measuredAt) <= cutoff);
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * Which readings are flagged as a single-day spike, keyed by `measuredAt`,
 * paired with the adjustment record naming why.
 */
function detectSpikes(ascending: readonly BodyweightReading[]): {
  flagged: ReadonlySet<string>;
  adjustments: BodyweightSpikeAdjustment[];
} {
  const flagged = new Set<string>();
  const adjustments: BodyweightSpikeAdjustment[] = [];
  for (let i = 1; i < ascending.length; i++) {
    const deltaLbs = ascending[i].bodyweightLbs - ascending[i - 1].bodyweightLbs;
    if (Math.abs(deltaLbs) < BODYWEIGHT_TREND_CONSTANTS.singleDaySpikeThresholdLbs) continue;
    flagged.add(ascending[i].measuredAt);
    adjustments.push({
      measuredAt: ascending[i].measuredAt,
      deltaLbs,
      reason:
        'single-day jump treated as scale opacity (salt/water), down-weighted rather than tissue change',
    });
  }
  return { flagged, adjustments };
}

/** The weight a reading contributes to a mean window ending `windowEndIso`. */
function readingWeight(flaggedAt: string | null, windowEndIso: string): number {
  if (flaggedAt === null) return 1;
  const daysSinceSpike = daysBetween(flaggedAt, windowEndIso);
  const stillDownweighted =
    daysSinceSpike >= 0 && daysSinceSpike < BODYWEIGHT_TREND_CONSTANTS.spikeDownweightDays;
  return stillDownweighted ? BODYWEIGHT_TREND_CONSTANTS.spikeDownweightFactor : 1;
}

function meanPointAt(
  windowEndIso: string,
  ascending: readonly BodyweightReading[],
  flagged: ReadonlySet<string>,
): BodyweightMeanPoint | null {
  const window = ascending.filter(
    (r) =>
      daysBetween(r.measuredAt, windowEndIso) >= 0 &&
      daysBetween(r.measuredAt, windowEndIso) < BODYWEIGHT_TREND_CONSTANTS.meanWindowDays,
  );
  if (window.length < BODYWEIGHT_TREND_CONSTANTS.meanWindowMinReadings) return null;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const r of window) {
    const flaggedAt = flagged.has(r.measuredAt) ? r.measuredAt : null;
    const weight = readingWeight(flaggedAt, windowEndIso);
    weightedSum += r.bodyweightLbs * weight;
    weightTotal += weight;
  }
  return {
    measuredAt: windowEndIso,
    meanLbs: weightedSum / weightTotal,
    readingCount: window.length,
  };
}

/** One mean point per distinct reading day, oldest first. */
function buildMeanSeries(
  ascending: readonly BodyweightReading[],
  flagged: ReadonlySet<string>,
): BodyweightMeanPoint[] {
  const days = [...new Set(ascending.map((r) => r.measuredAt))];
  return days.flatMap((day) => {
    const point = meanPointAt(day, ascending, flagged);
    return point === null ? [] : [point];
  });
}

/** The series point nearest exactly one mean window back from `series` end. */
function priorWeekPoint(
  series: readonly BodyweightMeanPoint[],
  endIso: string,
): BodyweightMeanPoint | null {
  const targetDaysBack = BODYWEIGHT_TREND_CONSTANTS.meanWindowDays;
  let best: BodyweightMeanPoint | null = null;
  let bestGap = Infinity;
  for (const point of series) {
    const daysBack = daysBetween(point.measuredAt, endIso);
    if (daysBack <= 0) continue;
    const gap = Math.abs(daysBack - targetDaysBack);
    if (gap < bestGap) {
      best = point;
      bestGap = gap;
    }
  }
  return best;
}

function classifyRate(weeklyDeltaLbs: number | null, weeksInPhase: number): BodyweightRateClass {
  if (weeksInPhase <= PHASE_SETTLING_WEEKS) return 'settling';
  if (weeklyDeltaLbs === null) return 'noise';
  return Math.abs(weeklyDeltaLbs) < BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek
    ? 'noise'
    : 'reportable';
}

function targetPositionLbs(
  targetLine: BodyweightTargetLine,
  phaseStartedAt: string,
  atIso: string,
): number {
  const weeksElapsed = daysBetween(phaseStartedAt, atIso) / 7;
  return targetLine.startWeightLbs + targetLine.weeklyRateLbs * weeksElapsed;
}

function classifySlope(
  series: readonly BodyweightMeanPoint[],
  targetLine: BodyweightTargetLine,
  phaseStartedAt: string,
  now: string,
): BodyweightSlopeClass | null {
  const current = series.length > 0 ? series[series.length - 1] : null;
  const prior = current === null ? null : priorWeekPoint(series, current.measuredAt);
  if (current === null || prior === null) return null;
  const deviationNow = Math.abs(
    current.meanLbs - targetPositionLbs(targetLine, phaseStartedAt, now),
  );
  const deviationPrior = Math.abs(
    prior.meanLbs - targetPositionLbs(targetLine, phaseStartedAt, prior.measuredAt),
  );
  const gap = deviationNow - deviationPrior;
  if (gap <= -BODYWEIGHT_TREND_CONSTANTS.slopeSimilarBandLbs) return 'converging';
  if (gap >= BODYWEIGHT_TREND_CONSTANTS.slopeSimilarBandLbs) return 'diverging';
  return 'similar';
}

function cumulativePctChange(
  series: readonly BodyweightMeanPoint[],
  startWeightLbs: number,
): number | null {
  if (series.length === 0) return null;
  const latest = series[series.length - 1];
  return ((latest.meanLbs - startWeightLbs) / startWeightLbs) * 100;
}

/**
 * Compute the bodyweight-trend facts for one lifter at one instant. No I/O,
 * no `Date.now()` — `input.now` is the only clock.
 */
export function computeBodyweightTrend(input: BodyweightTrendInput): BodyweightTrendResult {
  const ascending = sortedReadings(readingsAsOf(input.readings, input.now));
  const { flagged, adjustments } = detectSpikes(ascending);
  const meanSeries = buildMeanSeries(ascending, flagged);
  const current = meanSeries.length > 0 ? meanSeries[meanSeries.length - 1] : null;
  const prior = current === null ? null : priorWeekPoint(meanSeries, current.measuredAt);
  const weeklyDeltaLbs =
    current !== null && prior !== null ? current.meanLbs - prior.meanLbs : null;
  const weeksInPhase = weeksInPhaseAt(input.phaseStartedAt, input.now);

  return {
    meanSeries,
    weeklyDeltaLbs,
    rateClass: classifyRate(weeklyDeltaLbs, weeksInPhase),
    slopeClass: classifySlope(meanSeries, input.targetLine, input.phaseStartedAt, input.now),
    cumulativePctChangeSincePhaseStart: cumulativePctChange(
      meanSeries,
      input.targetLine.startWeightLbs,
    ),
    weeksInPhase,
    adjustments,
  };
}
