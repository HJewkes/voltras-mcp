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

export interface FlatlineOptions {
  /** The weekly load step the lifter is expected to add, in the series' own unit. */
  expectedStepLbsPerWeek: number;
  /** Defaults to {@link FLATLINE_FRACTION_OF_STEP}. */
  flatFraction?: number;
  /** Passed to `detectPlateau`; `undefined` keeps WA's own default. */
  thresholdPct?: number | undefined;
  /** The shortest run that can be a flatline, in days. */
  minDays: number;
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
 * reads flat on its tail alone.
 */
export function flatline(series: readonly Point[], options: FlatlineOptions): Flatline | null {
  const sorted = [...series].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const flatBelow =
    options.expectedStepLbsPerWeek * (options.flatFraction ?? FLATLINE_FRACTION_OF_STEP);
  for (let start = 0; start < sorted.length - 1; start++) {
    const run = sorted.slice(start);
    const days = spanDays(run);
    if (days < options.minDays) return null;
    if (!isWholePlateau(run, days, options)) continue;
    const slope = slopePerWeek(run);
    if (slope < flatBelow) return flatlineOf(run, days, slope, flatBelow);
  }
  return null;
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
