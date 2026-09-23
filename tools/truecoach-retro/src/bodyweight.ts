// Bodyweight phases: continuous runs split at a slope sign change held three weeks or a 21-day gap.

import { analyzeTrend } from '@voltras/workout-analytics';

import { GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK } from '../../../src/analytics/bodyweight-trend.js';
import {
  classifyCumulativeLossPct,
  type DietFatigueProxyBand,
} from '../../../src/analytics/cumulative-loss.js';

import { daysBetween, isoWeekStart, noonInstant } from './dates.js';
import type { CheckinRecord } from './types.js';

export const PHASE_RULE = { holdWeeks: 3, gapDays: 21 } as const;
/** A reading this far from its field's median is a mislabelled field (a waist logged as weight), not a body change. */
export const IMPLAUSIBLE_SHARE = 0.2;

export interface Reading {
  date: string;
  value: number;
}

export interface BodyweightPhase {
  startDate: string;
  endDate: string;
  readings: Reading[];
  slopeLbsPerWeek: number;
  pctPerWeek: number;
  label: 'loss' | 'gain' | 'maintenance';
  cumulativePct: number;
  /** RP's diet-fatigue band for a loss phase; `null` for any other phase. */
  dietFatigueBand: DietFatigueProxyBand | null;
}

export interface FieldReadings {
  readings: Reading[];
  /** Readings dropped as implausible; counted in the report, never silently. */
  dropped: Reading[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** One field's readings, oldest first, dated by due date and falling back to the email date. */
export function readingsOf(checkins: readonly CheckinRecord[], field: string): FieldReadings {
  const all = checkins
    .filter((row) => row.field === field && row.value !== null)
    .map((row) => ({
      date: row.workout_due_date ?? (row.email_date ?? '').slice(0, 10),
      value: row.value!,
    }))
    .filter((reading) => reading.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date));
  const middle = median(all.map((reading) => reading.value));
  const plausible = (reading: Reading) =>
    Math.abs(reading.value - middle) <= middle * IMPLAUSIBLE_SHARE;
  return { readings: all.filter(plausible), dropped: all.filter((reading) => !plausible(reading)) };
}

function splitOnGaps(readings: readonly Reading[], gapDays: number): Reading[][] {
  const segments: Reading[][] = [];
  for (const reading of readings) {
    const last = segments.at(-1)?.at(-1);
    if (last === undefined || daysBetween(last.date, reading.date) > gapDays) segments.push([]);
    segments.at(-1)!.push(reading);
  }
  return segments;
}

function weeklyMeans(readings: readonly Reading[]): Reading[] {
  const weeks = new Map<string, number[]>();
  for (const { date, value } of readings)
    weeks.set(isoWeekStart(date), [...(weeks.get(isoWeekStart(date)) ?? []), value]);
  return [...weeks].map(([date, values]) => ({
    date,
    value: values.reduce((a, b) => a + b, 0) / values.length,
  }));
}

/** Indexes of the weekly means where a new slope sign has held `holdWeeks` week-on-week steps. */
export function turningWeeks(means: readonly Reading[], holdWeeks: number): number[] {
  const signs = means.slice(1).map((mean, index) => Math.sign(mean.value - means[index]!.value));
  const turns: number[] = [];
  let phaseSign = signs.find((sign) => sign !== 0) ?? 0;
  for (let start = 0; start + holdWeeks <= signs.length; start++) {
    const held = signs.slice(start, start + holdWeeks);
    const flipped = -phaseSign;
    if (phaseSign !== 0 && held.every((sign) => sign === flipped)) {
      turns.push(start);
      phaseSign = flipped;
    }
  }
  return turns;
}

function phaseOf(readings: Reading[]): BodyweightPhase {
  const trend = analyzeTrend(readings.map((r) => ({ ts: noonInstant(r.date), value: r.value })));
  const start = readings[0]!.value;
  const slopeLbsPerWeek = trend.slope * 7;
  const pctPerWeek = (slopeLbsPerWeek / start) * 100;
  const cumulativePct = ((readings.at(-1)!.value - start) / start) * 100;
  const label =
    Math.abs(pctPerWeek) < GAIN_BAND_SLOW_EDGE_PCT_PER_WEEK
      ? 'maintenance'
      : pctPerWeek < 0
        ? 'loss'
        : 'gain';
  return {
    startDate: readings[0]!.date,
    endDate: readings.at(-1)!.date,
    readings,
    slopeLbsPerWeek,
    pctPerWeek,
    label,
    cumulativePct,
    dietFatigueBand: label === 'loss' ? classifyCumulativeLossPct(-cumulativePct) : null,
  };
}

/** Readings cut into phases; a turning week's readings open the new phase. */
export function bodyweightPhases(readings: readonly Reading[]): BodyweightPhase[] {
  return splitOnGaps(readings, PHASE_RULE.gapDays).flatMap((segment) => {
    const means = weeklyMeans(segment);
    const cuts = turningWeeks(means, PHASE_RULE.holdWeeks).map((index) => means[index]!.date);
    const pieces: Reading[][] = [[]];
    for (const reading of segment) {
      if (cuts.includes(isoWeekStart(reading.date)) && pieces.at(-1)!.length > 0) {
        cuts.splice(cuts.indexOf(isoWeekStart(reading.date)), 1);
        pieces.push([]);
      }
      pieces.at(-1)!.push(reading);
    }
    return pieces.filter((piece) => piece.length >= 2).map(phaseOf);
  });
}
