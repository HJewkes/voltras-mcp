// Check 1: progression and plateaus per main lift, per programme period.

import type { Context, MainLift } from '../context.js';
import { noonInstant } from '../dates.js';
import { comparisonBlock, num, section, signed, table, type Figure } from '../markdown.js';
import { inPeriod, type Period } from '../periods.js';
import {
  plateauWindows,
  trendOf,
  type FollowUp,
  type PlateauWindow,
  type TrendRead,
} from '../plateaus.js';
import type { SessionPoint } from '../series.js';

const CITATION =
  'Long-run stalling is judged like for like only; "one rep or 5 lb" is inside the margin of error ' +
  '(`QiXUeX1GfJQ.md:84-104, 138-142`, #60), and intermediates add about 2.5 to 10 lb a week ' +
  '(`UPMKGT8dgCE.md:34-38`, #37). A stale exercise is swapped once underperformance shows, at the ' +
  "meso's end (lecture #9, lines 75-77, 95 and 105-113; its video id is in the digest). Digest sections 1, 2 and ranked checks 4 and 9.";

export function e1rmTrend(points: readonly SessionPoint[], period: Period): TrendRead | null {
  const series = points
    .filter((point) => point.bestE1RM !== null && inPeriod(point.date, period))
    .map((point) => ({ ts: noonInstant(point.date), value: point.bestE1RM! }));
  return trendOf(series);
}

export function topLoadTrend(points: readonly SessionPoint[], period: Period): TrendRead | null {
  const series = points
    .filter((point) => point.topLoadAtModal !== null && inPeriod(point.date, period))
    .map((point) => ({ ts: noonInstant(point.date), value: point.topLoadAtModal! }));
  return trendOf(series);
}

export function trendCell(trend: TrendRead | null): string {
  if (trend === null) return 'n/a';
  const ci = trend.ci95PerWeek === null ? '' : ` ± ${num(trend.ci95PerWeek, 2)}`;
  return `${signed(trend.slopePerWeek, 2)}${ci} (n=${trend.points})`;
}

function rising(trend: TrendRead | null): boolean {
  return trend !== null && trend.ci95PerWeek !== null && trend.slopePerWeek - trend.ci95PerWeek > 0;
}

function liftRow(lift: MainLift, periods: readonly Period[]): (string | number)[] {
  const { points, modalReps, label } = lift.series;
  const cells = periods.flatMap((period) => [
    trendCell(e1rmTrend(points, period)),
    trendCell(topLoadTrend(points, period)),
  ]);
  return [
    label,
    lift.family,
    modalReps ?? 'n/a',
    points.length,
    points[0]?.date ?? '',
    points.at(-1)?.date ?? '',
    ...cells,
  ];
}

function trendTable(ctx: Context): string {
  const headers = ['lift', 'family', 'modal reps', 'sessions', 'first', 'last'];
  for (const period of ctx.periods)
    headers.push(`${period.name} e1RM lb/wk`, `${period.name} top load at modal reps lb/wk`);
  return table(
    headers,
    ctx.mainLifts.map((lift) => liftRow(lift, ctx.periods)),
  );
}

function windowRows(lift: MainLift, windows: readonly PlateauWindow[]): (string | number)[][] {
  return windows.map((w) => [
    lift.series.label,
    w.startDate,
    w.endDate,
    w.sessions,
    w.flatline ? 'yes' : 'no',
    w.followUp,
  ]);
}

function followUpCounts(windows: readonly PlateauWindow[]): string {
  const counts = new Map<FollowUp, number>();
  for (const w of windows) counts.set(w.followUp, (counts.get(w.followUp) ?? 0) + 1);
  return (
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${kind} ${n}`)
      .join(', ') || 'none'
  );
}

interface PeriodRise {
  up: number;
  trained: number;
  median: number | null;
}

function periodRise(ctx: Context, period: Period): PeriodRise {
  const trends = ctx.mainLifts.map((lift) => e1rmTrend(lift.series.points, period));
  const slopes = trends.flatMap((t) => (t === null ? [] : [t.slopePerWeek])).sort((a, b) => a - b);
  return {
    up: trends.filter(rising).length,
    trained: slopes.length,
    median: slopes[Math.floor(slopes.length / 2)] ?? null,
  };
}

function allWindows(ctx: Context): PlateauWindow[] {
  return ctx.mainLifts.flatMap((lift) => plateauWindows(lift.series.points, lift.familyDates));
}

function findings(ctx: Context, all: readonly PlateauWindow[]): string[] {
  const perPeriod = ctx.periods.map((period) => {
    const { up, trained, median } = periodRise(ctx, period);
    return `${period.name} ${up} of the ${trained} trained (median ${signed(median, 2)} lb/wk)`;
  });
  const flat = all.filter((w) => w.flatline).length;
  return [
    `Main lifts whose e1RM rose with a 95% interval above zero: ${perPeriod.join('; ')}.`,
    `The e1RM series hold ${all.length} plateau windows by workout-analytics' ±5% detector, which also fires on a steady climb; ${flat} meet the stricter VW-452 flatline rule, the ones to read.`,
    `What the log did after the ${flat} flatlines: ${followUpCounts(all.filter((w) => w.flatline))}.`,
  ];
}

/** The figures check 1 compares between all weeks and regular weeks. */
export function progressionFigures(ctx: Context): Figure[] {
  const rises = ctx.periods.flatMap((period): Figure[] => {
    const { up, trained, median } = periodRise(ctx, period);
    return [
      [`${period.name}: lifts rising, 95% interval above zero`, `${up} of ${trained}`],
      [`${period.name}: median e1RM slope, lb/wk`, signed(median, 2)],
    ];
  });
  const slopes = ctx.mainLifts.flatMap((lift) =>
    ctx.periods.map(
      (period): Figure => [
        `${lift.series.label} e1RM lb/wk, ${period.name}`,
        trendCell(e1rmTrend(lift.series.points, period)),
      ],
    ),
  );
  const windows = allWindows(ctx);
  const flat = windows.filter((w) => w.flatline);
  return [
    ...rises,
    ...slopes,
    ['plateau windows (±5%), of them flatlines', `${windows.length}, ${flat.length}`],
    ['what followed the flatlines', followUpCounts(flat)],
  ];
}

export function progressionSection(ctx: Context, regular: Context | null = null): string {
  const perLift = ctx.mainLifts.map((lift) => ({
    lift,
    windows: plateauWindows(lift.series.points, lift.familyDates),
  }));
  const all = perLift.flatMap((entry) => entry.windows);
  const body = [
    `Programme split: ${ctx.programmeSplit.date ?? 'none'} (${ctx.programmeSplit.source}), where prescriptions switch to load-first lines. The coach was the same on both sides of it; only the way the programme was written changed. Slopes are least-squares lb per week with a 95% interval; e1RM is Epley on sets of 12 reps or fewer.`,
    '',
    trendTable(ctx),
    '',
    'Plateau windows (e1RM within ±5% of the run median for 14+ days). "flatline" is the VW-452 rule; "followed by" reads the family\'s next session: gap = 10+ days, swap = another variant, load reset = top load at or under 90% of the window median.',
    '',
    table(
      ['lift', 'start', 'end', 'sessions', 'flatline', 'followed by'],
      perLift.flatMap((e) => windowRows(e.lift, e.windows)),
    ),
    ...comparisonBlock(
      progressionFigures(ctx),
      regular && progressionFigures(regular),
      'Regular-only slopes and windows read the sessions of regular weeks alone, so a series has holes where broken weeks were; a flatline whose next session fell in a broken week reads as followed by a gap.',
    ),
  ];
  return section('1. Progression and plateaus per main lift', findings(ctx, all), body, CITATION);
}
