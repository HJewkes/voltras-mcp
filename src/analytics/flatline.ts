// A plateau is a flatline, not a slowdown (VW-452). PURE: same series, same answer.
//
// `detectPlateau` (workout-analytics) calls any run of 14+ days inside ±5% of
// its median a plateau. A lifter climbing on the programmed ramp moves about
// 5% in two weeks, so the ideal lifter sat inside that window and read
// `stalled`. The corpus defines a stall by RATE, not by a window: the gain rate
// collapsing far below the expected one
// (rp:rp-s7-plateau-flatline-vs-slowdown-distinction). So a run WA calls a
// plateau is kept only when its own fitted slope is also a small fraction of
// the expected weekly step. That makes this a strict subset of WA's finding:
// it can only withdraw a plateau, never add one.
//
// The expected step is an argument, not a lookup, so a later change can drive
// it from the goal band's own rate or a research-backed source.
//
// VW-458: three or four noisy weekly points cannot resolve a slope that small,
// so a slow climber read flat about one read in six. The input is now steadied
// (`FlatlineSmoothing`); `scripts/flatline-sim.mjs` holds the measured trade.

import { detectPlateau } from '@voltras/workout-analytics';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Share of the expected weekly step below which a run's slope is a flatline.
 *
 * ENGINEERING DEFAULT. The corpus's own example puts a flatline at about 10%
 * of the expected rate (+5 lb after +50 lb) and a healthy slowdown at about 60%
 * (+30 lb after +50 lb) (rp:rp-s7-plateau-flatline-vs-slowdown-distinction),
 * but states no threshold. A quarter sits between the two and is half the
 * goal band's committed (low-edge) rate, so a lifter on the committed pace is
 * twice the threshold away from reading flat.
 */
export const FLATLINE_FRACTION_OF_STEP = 0.25;

/** How the input is steadied before a run is judged (VW-458). */
export interface FlatlineSmoothing {
  /** The slope reads each point as the top value of the trailing window this many days long. */
  rollingTopDays: number;
  /** The shortest run that can be a flatline while the run is still wobbling, in days. */
  unsettledMinDays: number;
  /** A run is settled when its whole range fits inside this many weeks of flatline-rate movement. */
  settledRangeWeeks: number;
}

/**
 * ENGINEERING DEFAULT, picked from `scripts/flatline-sim.mjs`. A wobbling run
 * waits one more week (21 days) before it can read flat; a lifter repeating
 * one load still reads flat at the 14-day floor.
 */
export const FLATLINE_SMOOTHING: FlatlineSmoothing = {
  rollingTopDays: 14,
  unsettledMinDays: 21,
  settledRangeWeeks: 1,
};

export interface FlatlineOptions {
  /** The weekly load step the lifter is expected to add, in the series' own unit. */
  expectedStepLbsPerWeek: number;
  /** Defaults to {@link FLATLINE_FRACTION_OF_STEP}. */
  flatFraction?: number;
  /** Passed to `detectPlateau`; `undefined` keeps WA's own default. */
  thresholdPct?: number | undefined;
  /** The shortest run that can be a flatline, in days. */
  minDays: number;
  /** Defaults to {@link FLATLINE_SMOOTHING}; `null` judges the raw points on `minDays` alone. */
  smoothing?: FlatlineSmoothing | null;
}

/** The trailing run that is a flatline, with the evidence that made it one. */
export interface Flatline {
  days: number;
  points: number;
  slopeLbsPerWeek: number;
  flatBelowLbsPerWeek: number;
  reasoning: string;
}

interface Point {
  ts: string;
  value: number;
}

/**
 * The longest trailing run that WA calls a plateau AND whose own least-squares
 * slope is under `flatFraction` of the expected step, or `null` when none is.
 * Trailing runs are tried longest first, so a climb that then goes flat still
 * reads flat on its tail alone. WA always judges the RAW run, so smoothing can
 * only withdraw a plateau; the slope alone reads the rolling top.
 */
export function flatline(series: readonly Point[], options: FlatlineOptions): Flatline | null {
  const sorted = [...series].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const smoothing = options.smoothing === undefined ? FLATLINE_SMOOTHING : options.smoothing;
  const steadied = smoothing === null ? sorted : rollingTop(sorted, smoothing.rollingTopDays);
  const flatBelow =
    options.expectedStepLbsPerWeek * (options.flatFraction ?? FLATLINE_FRACTION_OF_STEP);
  for (let start = 0; start < sorted.length - 1; start++) {
    const run = sorted.slice(start);
    const days = spanDays(run);
    if (days < options.minDays) return null;
    if (!isWholePlateau(run, days, options)) continue;
    if (smoothing !== null && !isLongEnough(run, days, flatBelow, smoothing)) continue;
    const slope = slopePerWeek(steadied.slice(start));
    if (slope < flatBelow) return flatlineOf(run, days, slope, flatBelow);
  }
  return null;
}

/** Each point carries the top value seen in the `windowDays` up to and including it. */
function rollingTop(sorted: readonly Point[], windowDays: number): Point[] {
  return sorted.map((point, index) => {
    const from = Date.parse(point.ts) - windowDays * DAY_MS;
    let top = point.value;
    for (let j = index - 1; j >= 0 && Date.parse(sorted[j]!.ts) > from; j--) {
      top = Math.max(top, sorted[j]!.value);
    }
    return { ts: point.ts, value: top };
  });
}

/** A wobbling run needs `unsettledMinDays`; a settled one is judged as soon as `minDays` allows. */
function isLongEnough(
  run: readonly Point[],
  days: number,
  flatBelow: number,
  smoothing: FlatlineSmoothing,
): boolean {
  if (days >= smoothing.unsettledMinDays) return true;
  const values = run.map((point) => point.value);
  return Math.max(...values) - Math.min(...values) <= flatBelow * smoothing.settledRangeWeeks;
}

function flatlineOf(
  run: readonly Point[],
  days: number,
  slope: number,
  flatBelow: number,
): Flatline {
  return {
    days,
    points: run.length,
    slopeLbsPerWeek: round2(slope),
    flatBelowLbsPerWeek: round2(flatBelow),
    reasoning:
      `Moved ${round2(slope)} per week over ${days.toFixed(0)} days (${run.length} points), ` +
      `under the flatline threshold of ${round2(flatBelow)} per week`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** WA calls the whole of `run` a plateau, not just a shorter tail of it. */
function isWholePlateau(run: readonly Point[], days: number, options: FlatlineOptions): boolean {
  const detected = detectPlateau([...run], options.thresholdPct, options.minDays);
  return detected.isPlateau && detected.plateauDays >= days;
}

function spanDays(run: readonly Point[]): number {
  return (Date.parse(run[run.length - 1]!.ts) - Date.parse(run[0]!.ts)) / DAY_MS;
}

/** Ordinary least-squares slope, per week. */
function slopePerWeek(run: readonly Point[]): number {
  const xs = run.map((point) => Date.parse(point.ts) / WEEK_MS);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = run.reduce((sum, point) => sum + point.value, 0) / run.length;
  let covariance = 0;
  let varianceX = 0;
  run.forEach((point, index) => {
    const dx = xs[index]! - meanX;
    covariance += dx * (point.value - meanY);
    varianceX += dx * dx;
  });
  return varianceX === 0 ? 0 : covariance / varianceX;
}
