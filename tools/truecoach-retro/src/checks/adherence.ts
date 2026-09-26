// Check 5: training days, sessions per week against the modal count, gaps, frequency per muscle.

import { trainingGaps } from '../../../../src/analytics/training-days.js';
import type { TitanMuscleGroup } from '../../../../src/exercises/muscle-map.js';

import type { Context } from '../context.js';
import { comparisonBlock, num, pct, section, table, type Figure } from '../markdown.js';
import { MESO_RULE } from '../meso.js';
import { inPeriod, type Period } from '../periods.js';
import {
  modalWeeklyCount,
  sessionsPerWeek,
  weeklyDoseFrequencyByMuscle,
  weeklyFrequencyByMuscle,
} from '../weekly.js';

const CITATION =
  'Intermediate status needs adherence to the weekly session number; years with "six months off here and there" still read as a ' +
  'beginner (`CgvpnaygIss.md:54-62, 94-98`, #29). Every muscle 2 to 4 times a week; twice-weekly whole body "is generally not ' +
  'enough for intermediates" (`7HtUhJzPUS8.md:56-58`, #31). Digest section 6, ranked check 7. The modal count standing in for ' +
  'the contracted count is inferred.';

function periodRow(ctx: Context, period: Period): (string | number)[] {
  const days = ctx.days.filter((day) => inPeriod(day, period));
  const weeks = [...sessionsPerWeek(days).values()];
  const modal = modalWeeklyCount(weeks);
  const active = weeks.filter((n) => n > 0).length;
  const atModal = weeks.filter((n) => modal !== null && n >= modal).length;
  const zero = weeks.length - active;
  return [
    period.name,
    days.length,
    weeks.length,
    active,
    zero,
    modal ?? 'n/a',
    `${atModal} (${pct(atModal, weeks.length)})`,
  ];
}

interface FrequencyRead {
  muscle: TitanMuscleGroup;
  weeksTrained: number;
  meanWhenTrained: number;
  weeksAtTwo: number;
  weeks: number;
  /** Dose frequency (R15) over the weeks it is above 0: a comparison, never a verdict. */
  doseMeanWhenHit: number;
}

function meanAboveZero(values: readonly number[]): number {
  const hit = values.filter((n) => n > 0);
  return hit.reduce((a, b) => a + b, 0) / Math.max(hit.length, 1);
}

/** Landmark frequency per muscle (R14), with the dose frequency beside it. */
export function frequencyReads(ctx: Context): FrequencyRead[] {
  const weeks = weeklyFrequencyByMuscle(ctx.rows, ctx.lookup);
  const dose = weeklyDoseFrequencyByMuscle(ctx.rows, ctx.lookup);
  const muscles = new Set([...dose.values()].flatMap((m) => [...m.keys()]));
  return [...muscles].sort().map((muscle) => {
    const counts = [...weeks.values()].map((m) => m.get(muscle) ?? 0);
    return {
      muscle,
      weeksTrained: counts.filter((n) => n > 0).length,
      meanWhenTrained: meanAboveZero(counts),
      weeksAtTwo: counts.filter((n) => n >= 2).length,
      weeks: weeks.size,
      doseMeanWhenHit: meanAboveZero([...dose.values()].map((m) => m.get(muscle) ?? 0)),
    };
  });
}

function frequencyRow(read: FrequencyRead): (string | number)[] {
  return [
    read.muscle,
    read.weeksTrained,
    num(read.meanWhenTrained, 2),
    `${read.weeksAtTwo} (${pct(read.weeksAtTwo, read.weeks)})`,
    num(read.doseMeanWhenHit, 2),
  ];
}

function frequencyFinding(reads: readonly FrequencyRead[]): string {
  const regular = reads.filter((r) => r.weeksTrained >= r.weeks / 2);
  const often = regular.filter((r) => r.weeksAtTwo >= r.weeks / 2).map((r) => r.muscle);
  const once = regular.filter((r) => r.weeksAtTwo === 0).map((r) => r.muscle);
  return `Of the regularly trained muscles, twice a week in at least half the weeks: ${often.join(', ') || 'none'}; never twice in a week: ${once.join(', ') || 'none'}.`;
}

/** The figures check 5 compares; read over trained weeks so a window of chosen weeks compares fairly. */
export function adherenceFigures(ctx: Context): Figure[] {
  const trained = [...sessionsPerWeek(ctx.days).values()].filter((n) => n > 0);
  const modal = modalWeeklyCount(trained);
  const atModal = trained.filter((n) => modal !== null && n >= modal).length;
  const mean = trained.reduce((a, b) => a + b, 0) / Math.max(trained.length, 1);
  const twice = frequencyReads(ctx)
    .filter((r) => r.weeksTrained >= r.weeks / 2)
    .map((r): Figure => [`${r.muscle}: trained weeks at 2+ sessions`, pct(r.weeksAtTwo, r.weeks)]);
  return [
    ['trained weeks, training days', `${trained.length}, ${ctx.days.length}`],
    ['mean sessions per trained week', num(mean, 2)],
    ['modal sessions per trained week', `${modal ?? 'n/a'}`],
    ['trained weeks at or above the modal count', `${atModal} (${pct(atModal, trained.length)})`],
    ...twice,
  ];
}

export function adherenceSection(ctx: Context, regular: Context | null = null): string {
  const gaps = trainingGaps(ctx.days).filter((gap) => gap.days > MESO_RULE.gapDays);
  const allWeeks = [...sessionsPerWeek(ctx.days).values()];
  const modal = modalWeeklyCount(allWeeks);
  const atModal = allWeeks.filter((n) => modal !== null && n >= modal).length;
  const longest = [...gaps].sort((a, b) => b.days - a.days)[0];
  const reads = frequencyReads(ctx);
  const finding = [
    `${ctx.days.length} training days over ${allWeeks.length} calendar weeks; the modal week holds ${modal ?? 'no'} sessions and ${atModal} weeks (${pct(atModal, allWeeks.length)}) reached it.`,
    `${gaps.length} gaps longer than ${MESO_RULE.gapDays} days; the longest is ${longest?.days ?? 0} days, ending ${longest?.endsOn ?? 'n/a'}.`,
    frequencyFinding(reads),
  ];
  const body = [
    "A training day is a date with at least one non-warm-up row. Weeks run Monday to Sunday from the first training day to the last, empty weeks included. A day counts toward a muscle's frequency only when one of its target exercises was trained that day. The dose column counts a day 1 for a target and 0.5 for a muscle hit only through a weighted row (Pelland et al. 2025); it is not a frequency verdict.",
    '',
    table(
      [
        'period',
        'training days',
        'calendar weeks',
        'weeks trained',
        'empty weeks',
        'modal sessions/wk',
        'weeks at or above modal',
      ],
      ctx.periods.map((p) => periodRow(ctx, p)),
    ),
    '',
    table(
      ['gap (days)', 'training resumed'],
      gaps.map((gap) => [gap.days, gap.endsOn]),
    ),
    '',
    table(
      [
        'muscle',
        'weeks trained',
        'mean sessions/wk when trained',
        'weeks at 2+ sessions (of weeks with training)',
        'mean dose sessions/wk when hit (fractional; comparison only)',
      ],
      reads.map(frequencyRow),
    ),
    ...comparisonBlock(adherenceFigures(ctx), regular && adherenceFigures(regular)),
  ];
  return section('5. Adherence', finding, body, CITATION);
}
