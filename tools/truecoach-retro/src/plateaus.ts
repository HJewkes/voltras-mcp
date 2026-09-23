// Plateau windows along a whole history, and what the log did after each one.

import { analyzeTrend, detectPlateau } from '@voltras/workout-analytics';

import { flatline, plateauReferenceStepLbs } from '../../../src/analytics/flatline.js';
import { slopeStandardError } from '../../../src/analytics/goal-history.js';

import { daysBetween, noonInstant } from './dates.js';
import type { SessionPoint } from './series.js';

/** The shortest plateau window, in days: `detectPlateau`'s own default. */
export const PLATEAU_MIN_DAYS = 14;
/** ENGINEERING DEFAULT: two sessions a fortnight apart are a repeat, not a plateau. */
export const PLATEAU_MIN_SESSIONS = 3;
/** A lift absent this long while its family trains on was swapped out. */
export const SWAP_ABSENCE_DAYS = 21;
/** After a window, a return this many days later counts as a gap. Matches the meso rule's gap. */
export const FOLLOW_UP_GAP_DAYS = 10;
/** A next session this far under the window's median load is a load reset. */
export const LOAD_RESET_SHARE = 0.9;

export type FollowUp =
  | 'gap'
  | 'swap'
  | 'load reset'
  | 'broke through'
  | 'continued flat'
  | 'log ends';

export interface PlateauWindow {
  startDate: string;
  endDate: string;
  sessions: number;
  /** The VW-452 rule also held: WA's window and a slope under a quarter of the reference step. */
  flatline: boolean;
  followUp: FollowUp;
}

export interface TrendRead {
  slopePerWeek: number;
  /** Half-width of a 95% interval, or `null` when the fit cannot support one. */
  ci95PerWeek: number | null;
  rSquared: number;
  points: number;
}

type Valued = SessionPoint & { bestE1RM: number };

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A least-squares slope per week with its interval, from WA's fit and the goal-history identity. */
export function trendOf(series: readonly { ts: string; value: number }[]): TrendRead | null {
  if (series.length < 2) return null;
  const fit = analyzeTrend([...series], { flatThresholdPerDay: 0 });
  const se = slopeStandardError(fit.slope, fit.rSquared, fit.pointCount);
  return {
    slopePerWeek: fit.slope * 7,
    ci95PerWeek: se === null ? null : 1.96 * se * 7,
    rSquared: fit.rSquared,
    points: fit.pointCount,
  };
}

function asSeries(points: readonly Valued[]) {
  return points.map((point) => ({ ts: noonInstant(point.date), value: point.bestE1RM }));
}

/** Trailing windows ending at each session, merged where they overlap. */
function rawWindows(points: readonly Valued[]): { start: number; end: number; flat: boolean }[] {
  const step = plateauReferenceStepLbs(median(points.map((point) => point.topLoad)));
  const windows: { start: number; end: number; flat: boolean }[] = [];
  for (let end = 1; end < points.length; end++) {
    const prefix = asSeries(points.slice(0, end + 1));
    const found = detectPlateau(prefix, undefined, PLATEAU_MIN_DAYS);
    if (!found.isPlateau) continue;
    const startDate = new Date(
      Date.parse(prefix[end]!.ts) - found.plateauDays * 86_400_000,
    ).toISOString();
    const start = prefix.findIndex((point) => point.ts >= startDate);
    const flat =
      flatline(prefix, { expectedStepLbsPerWeek: step, minDays: PLATEAU_MIN_DAYS }) !== null;
    const last = windows.at(-1);
    if (last !== undefined && start <= last.end)
      Object.assign(last, { end, flat: last.flat || flat });
    else windows.push({ start, end, flat });
  }
  return windows;
}

/**
 * What followed a window, checked in this order: the family stopped (gap), the family went on
 * without this lift (swap), the lift came back lighter (load reset), or at a new e1RM high.
 */
export function followUpOf(
  window: readonly SessionPoint[],
  ownNext: SessionPoint | undefined,
  familyAfter: readonly string[],
): FollowUp {
  const endDate = window.at(-1)!.date;
  if (familyAfter.length === 0) return 'log ends';
  if (daysBetween(endDate, familyAfter[0]!) >= FOLLOW_UP_GAP_DAYS) return 'gap';
  if (ownNext === undefined || daysBetween(endDate, ownNext.date) >= SWAP_ABSENCE_DAYS) {
    return daysBetween(endDate, familyAfter.at(-1)!) >= SWAP_ABSENCE_DAYS ? 'swap' : 'log ends';
  }
  if (ownNext.topLoad <= median(window.map((point) => point.topLoad)) * LOAD_RESET_SHARE)
    return 'load reset';
  const high = Math.max(...window.map((point) => point.bestE1RM ?? 0));
  return (ownNext.bestE1RM ?? 0) > high ? 'broke through' : 'continued flat';
}

/** Every plateau window along a lift's e1RM series, oldest first, read against its family's sessions. */
export function plateauWindows(
  points: readonly SessionPoint[],
  familyDates: readonly string[],
): PlateauWindow[] {
  const valued = points.filter((point): point is Valued => point.bestE1RM !== null);
  const windows = rawWindows(valued).filter(
    ({ start, end }) => end - start + 1 >= PLATEAU_MIN_SESSIONS,
  );
  return windows.map(({ start, end, flat }) => {
    const inside = valued.slice(start, end + 1);
    const endDate = inside.at(-1)!.date;
    const ownNext = points.find((point) => point.date > endDate);
    return {
      startDate: inside[0]!.date,
      endDate,
      sessions: inside.length,
      flatline: flat,
      followUp: followUpOf(
        inside,
        ownNext,
        familyDates.filter((date) => date > endDate),
      ),
    };
  });
}
