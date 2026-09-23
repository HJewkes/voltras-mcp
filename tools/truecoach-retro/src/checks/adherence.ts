// Check 5: training days, sessions per week against the modal count, gaps, frequency per muscle.

import { trainingGaps } from '../../../../src/analytics/training-days.js';
import type { TitanMuscleGroup } from '../../../../src/exercises/muscle-map.js';

import type { Context } from '../context.js';
import { num, pct, section, table } from '../markdown.js';
import { MESO_RULE } from '../meso.js';
import { inPeriod, type Period } from '../periods.js';
import { modalWeeklyCount, sessionsPerWeek, weeklyFrequencyByMuscle } from '../weekly.js';

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
}

export function frequencyReads(ctx: Context): FrequencyRead[] {
  const weeks = weeklyFrequencyByMuscle(ctx.rows, ctx.lookup);
  const muscles = new Set([...weeks.values()].flatMap((m) => [...m.keys()]));
  return [...muscles].sort().map((muscle) => {
    const counts = [...weeks.values()].map((m) => m.get(muscle) ?? 0);
    const trained = counts.filter((n) => n > 0);
    const meanWhenTrained = trained.reduce((a, b) => a + b, 0) / Math.max(trained.length, 1);
    return {
      muscle,
      weeksTrained: trained.length,
      meanWhenTrained,
      weeksAtTwo: counts.filter((n) => n >= 2).length,
      weeks: weeks.size,
    };
  });
}

function frequencyRow(read: FrequencyRead): (string | number)[] {
  return [
    read.muscle,
    read.weeksTrained,
    num(read.meanWhenTrained, 2),
    `${read.weeksAtTwo} (${pct(read.weeksAtTwo, read.weeks)})`,
  ];
}

function frequencyFinding(reads: readonly FrequencyRead[]): string {
  const regular = reads.filter((r) => r.weeksTrained >= r.weeks / 2);
  const often = regular.filter((r) => r.weeksAtTwo >= r.weeks / 2).map((r) => r.muscle);
  const once = regular.filter((r) => r.weeksAtTwo === 0).map((r) => r.muscle);
  return `Of the regularly trained muscles, twice a week in at least half the weeks: ${often.join(', ') || 'none'}; never twice in a week: ${once.join(', ') || 'none'}.`;
}

export function adherenceSection(ctx: Context): string {
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
    'A training day is a date with at least one non-warm-up row. Weeks run Monday to Sunday from the first training day to the last, empty weeks included.',
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
      ],
      reads.map(frequencyRow),
    ),
  ];
  return section('5. Adherence', finding, body, CITATION);
}
