// The three checks that read confirmed mesos (VW-549): restart load, the in-meso set ramp, staleness.

import { isoWeekStart } from './dates.js';
import type { SessionPoint } from './series.js';

export const MESO_CHECK_RULE = {
  /** RP's margin of error: "one rep or 5 lb" reads as the same load. */
  sameLoadLbs: 5,
  /** ENGINEERING DEFAULT: a fitted weekly change in sets under this reads as flat. */
  rampSetsPerWeek: 0.5,
  /** A ramp needs at least this many trained weeks in the meso. */
  minRampWeeks: 3,
  /** A peak e1RM that rose by no more than this across a boundary did not progress. */
  flatE1rmLbs: 5,
} as const;

/** One meso: its Monday weeks from `startWeek` up to, not including, `endWeek`. */
export interface MesoSpan {
  startWeek: string;
  endWeek: string;
}

const inside = (week: string, meso: MesoSpan) => week >= meso.startWeek && week < meso.endWeek;

/** RP's restart by tier: the final week's load (beginner), a mid-meso load (intermediate and up), or a full reset. */
export type RestartKind = 'at or above final' | 'mid-meso' | 'at week 1 or below';

export interface Restart {
  previousStart: string;
  start: string;
  /** The lift's top load in each trained week of the previous meso, in order. */
  previousLoads: number[];
  restartLoad: number;
  kind: RestartKind;
}

export function restartKind(previousLoads: readonly number[], restartLoad: number): RestartKind {
  if (restartLoad >= previousLoads.at(-1)! - MESO_CHECK_RULE.sameLoadLbs)
    return 'at or above final';
  if (restartLoad <= previousLoads[0]! + MESO_CHECK_RULE.sameLoadLbs) return 'at week 1 or below';
  return 'mid-meso';
}

function loadsIn(weeklyTop: ReadonlyMap<string, number>, meso: MesoSpan): number[] {
  return [...weeklyTop]
    .filter(([week]) => inside(week, meso))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, load]) => load);
}

/** Each meso's first top load for a lift against the previous meso's week-by-week loads. */
export function restarts(
  weeklyTop: ReadonlyMap<string, number>,
  mesos: readonly MesoSpan[],
): Restart[] {
  return mesos.slice(1).flatMap((meso, i): Restart[] => {
    const previousLoads = loadsIn(weeklyTop, mesos[i]!);
    const restartLoad = loadsIn(weeklyTop, meso)[0];
    if (previousLoads.length < 2 || restartLoad === undefined) return [];
    return [
      {
        previousStart: mesos[i]!.startWeek,
        start: meso.startWeek,
        previousLoads,
        restartLoad,
        kind: restartKind(previousLoads, restartLoad),
      },
    ];
  });
}

/** Least-squares slope over equally spaced points: per trained week, not per calendar week. */
export function slopePerStep(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  return num / den;
}

export type RampKind = 'ramped' | 'flat' | 'fell';

export function rampKind(slope: number): RampKind {
  if (slope >= MESO_CHECK_RULE.rampSetsPerWeek) return 'ramped';
  return slope <= -MESO_CHECK_RULE.rampSetsPerWeek ? 'fell' : 'flat';
}

export interface Ramp {
  mesoStart: string;
  muscle: string;
  /** Sets in each trained week of the meso, zero where the muscle was not trained that week. */
  sets: number[];
  slope: number;
  kind: RampKind;
}

/** The weekly set ramp per muscle inside every meso with enough trained weeks. */
export function mesoRamps(
  weekSets: ReadonlyMap<string, ReadonlyMap<string, number>>,
  mesos: readonly MesoSpan[],
): Ramp[] {
  return mesos.flatMap((meso) => {
    const weeks = [...weekSets.keys()].filter((week) => inside(week, meso)).sort();
    if (weeks.length < MESO_CHECK_RULE.minRampWeeks) return [];
    const muscles = [...new Set(weeks.flatMap((week) => [...weekSets.get(week)!.keys()]))].sort();
    return muscles.map((muscle): Ramp => {
      const sets = weeks.map((week) => weekSets.get(week)!.get(muscle) ?? 0);
      const slope = slopePerStep(sets);
      return { mesoStart: meso.startWeek, muscle, sets, slope, kind: rampKind(slope) };
    });
  });
}

export interface Carry {
  previousStart: string;
  start: string;
  peakBefore: number;
  peakAfter: number;
  /** The peak e1RM rose by no more than RP's margin. */
  flat: boolean;
  /** A flatline window covered the lift's last session before the boundary. */
  plateauOpen: boolean;
  /** Kept into the next meso while its plateau held, and that meso's peak did not beat it: RP's staleness. */
  stale: boolean;
}

function valuedIn(points: readonly SessionPoint[], meso: MesoSpan): SessionPoint[] {
  return points.filter((p) => p.bestE1RM !== null && inside(isoWeekStart(p.date), meso));
}

/** Every boundary a lift was kept across, with whether its plateau window was still open. */
export function carries(
  points: readonly SessionPoint[],
  flatlines: readonly { start: string; end: string }[],
  mesos: readonly MesoSpan[],
): Carry[] {
  return mesos.slice(1).flatMap((meso, i): Carry[] => {
    const before = valuedIn(points, mesos[i]!);
    const after = valuedIn(points, meso);
    if (before.length === 0 || after.length === 0) return [];
    const peakBefore = Math.max(...before.map((p) => p.bestE1RM!));
    const peakAfter = Math.max(...after.map((p) => p.bestE1RM!));
    const last = before.at(-1)!.date;
    const plateauOpen = flatlines.some((w) => w.start <= last && w.end >= last);
    const flat = peakAfter - peakBefore <= MESO_CHECK_RULE.flatE1rmLbs;
    const base = { previousStart: mesos[i]!.startWeek, start: meso.startWeek };
    return [{ ...base, peakBefore, peakAfter, flat, plateauOpen, stale: plateauOpen && flat }];
  });
}
