// The regular/broken labels (VW-548): counts, runs, how they sit in the mesos, and the rule in prose.

import { restrictToWeeks, type Context } from '../context.js';
import { pct, section, table } from '../markdown.js';
import { mesosBetween } from '../meso.js';
import {
  BREAK_REASONS,
  regularWeeks,
  reportedExercisesByWeek,
  ruleText,
  segmentWeeks,
  SEGMENT_RULE,
  type BreakReason,
  type LabelledWeek,
  type Segmentation,
} from '../segmentation.js';

import { confirmedBoundaries } from './deload.js';

export interface Segmented {
  segmentation: Segmentation;
  /** The context restricted to regular weeks: what every "regular weeks only" figure reads. */
  regular: Context;
}

export function segmentContext(ctx: Context): Segmented {
  const segmentation = segmentWeeks(ctx.days, reportedExercisesByWeek(ctx.rows), ctx.decisions);
  return { segmentation, regular: restrictToWeeks(ctx, regularWeeks(segmentation)) };
}

export interface LabelCounts {
  regular: number;
  broken: number;
  /** Weeks (or sessions) carrying each reason; one week can carry several. */
  byReason: Record<BreakReason, number>;
  /** Broken weeks (or sessions) by their first reason in precedence order; these sum to `broken`. */
  byFirstReason: Record<BreakReason, number>;
}

function emptyTally(): Record<BreakReason, number> {
  return Object.fromEntries(BREAK_REASONS.map((r) => [r, 0])) as Record<BreakReason, number>;
}

/** Counts over trained weeks; `weight` turns a week into its sessions for the session counts. */
export function labelCounts(
  weeks: readonly LabelledWeek[],
  weight: (week: LabelledWeek) => number = () => 1,
): LabelCounts {
  const counts = { regular: 0, broken: 0, byReason: emptyTally(), byFirstReason: emptyTally() };
  for (const week of weeks) {
    if (week.label === 'untrained') continue;
    counts[week.label] += weight(week);
    for (const reason of week.reasons) counts.byReason[reason] += weight(week);
    if (week.reasons[0] !== undefined) counts.byFirstReason[week.reasons[0]] += weight(week);
  }
  return counts;
}

export interface MesoLabels {
  start: string;
  nextStart: string;
  trainedWeeks: number;
  regular: number;
  broken: number;
  reasons: Partial<Record<BreakReason, number>>;
}

/** How the labels fall inside each meso the check-4 rule found. */
export function mesoLabels(ctx: Context, segmentation: Segmentation): MesoLabels[] {
  return mesosBetween(ctx.days, confirmedBoundaries(ctx)).map((meso) => {
    const inside = segmentation.weeks.filter(
      (w) => w.week >= meso.startWeek && w.week < meso.endWeek && w.label !== 'untrained',
    );
    const reasons: Partial<Record<BreakReason, number>> = {};
    for (const reason of inside.flatMap((w) => w.reasons))
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    return {
      start: meso.startWeek,
      nextStart: meso.endWeek,
      trainedWeeks: inside.length,
      regular: inside.filter((w) => w.label === 'regular').length,
      broken: inside.filter((w) => w.label === 'broken').length,
      reasons,
    };
  });
}

function reasonText(reasons: Partial<Record<BreakReason, number>>): string {
  return (
    BREAK_REASONS.filter((r) => reasons[r])
      .map((r) => `${r} ${reasons[r]}`)
      .join(', ') || ''
  );
}

function decisionsLine(ctx: Context, segmentation: Segmentation): string {
  const long = segmentation.gaps;
  const kept = long.filter((g) => !g.breaksRun).length;
  if (ctx.decisions === null)
    return `boundary-decisions.json was not given, so all ${long.length} gaps over ${SEGMENT_RULE.breakGapDays} days end a run; re-run with --boundary-decisions once the human has marked them.`;
  const marked = ctx.decisions.filter((d) => d.choice !== null).length;
  return `boundary-decisions.json was read: ${marked} of ${ctx.decisions.length} boundaries marked; ${kept} of the ${long.length} gaps over ${SEGMENT_RULE.breakGapDays} days stay inside a run because of a mark.`;
}

function countRows(weeks: LabelCounts, sessions: LabelCounts): (string | number)[][] {
  return [
    ['regular', weeks.regular, sessions.regular],
    ['broken', weeks.broken, sessions.broken],
    ...BREAK_REASONS.map((r) => [
      `broken, first reason ${r} (any reason ${r})`,
      `${weeks.byFirstReason[r]} (${weeks.byReason[r]})`,
      `${sessions.byFirstReason[r]} (${sessions.byReason[r]})`,
    ]),
  ];
}

function findings(segmentation: Segmentation, weeks: LabelCounts, sessions: LabelCounts): string[] {
  const trained = weeks.regular + weeks.broken;
  const total = sessions.regular + sessions.broken;
  const top = [...BREAK_REASONS].sort((a, b) => weeks.byReason[b] - weeks.byReason[a])[0]!;
  const longRuns = segmentation.runs.filter(
    (r) => r.trainedWeeks >= SEGMENT_RULE.minRunWeeks,
  ).length;
  return [
    `${weeks.regular} of ${trained} trained weeks (${pct(weeks.regular, trained)}) are regular, holding ${sessions.regular} of ${total} sessions (${pct(sessions.regular, total)}).`,
    `The most common reason a week is broken is ${top} (${weeks.byReason[top]} weeks); a week can carry several reasons.`,
    `The gaps split the log into ${segmentation.runs.length} runs of trained weeks, ${longRuns} of them ${SEGMENT_RULE.minRunWeeks} weeks or longer.`,
  ];
}

function brokenWeekRows(trained: readonly LabelledWeek[]): (string | number)[][] {
  return trained
    .filter((w) => w.label === 'broken')
    .map((w) => [w.week, w.sessions, w.reportedExercises, w.reasons.join(', ')]);
}

function mesoRows(ctx: Context, segmentation: Segmentation): (string | number)[][] {
  return mesoLabels(ctx, segmentation).map((m) => [
    m.start,
    m.nextStart,
    m.trainedWeeks,
    m.regular,
    m.broken,
    reasonText(m.reasons),
  ]);
}

const CITATION =
  'Intermediate status reads adherence to the weekly session number, and long-run progress is judged like for like (digest sections 1 and 6). ' +
  'Which weeks count as steady training is inferred for this log, not an RP rule; the human approves it.';

export function segmentsSection(ctx: Context, { segmentation }: Segmented): string {
  const trained = segmentation.weeks.filter((w) => w.label !== 'untrained');
  const weeks = labelCounts(trained);
  const sessions = labelCounts(trained, (w) => w.sessions);
  const runRows = segmentation.runs.map((r, i) => [i + 1, r.firstWeek, r.lastWeek, r.trainedWeeks]);
  const body = [
    decisionsLine(ctx, segmentation),
    '',
    table(['label', 'trained weeks', 'sessions'], countRows(weeks, sessions)),
    '',
    table(['run', 'first week', 'last week', 'trained weeks'], runRows),
    '',
    table(
      ['meso starts', 'next starts', 'trained weeks', 'regular', 'broken', 'reasons'],
      mesoRows(ctx, segmentation),
    ),
    '',
    table(
      ['broken week', 'sessions', 'exercises with a written-out set', 'reasons'],
      brokenWeekRows(trained),
    ),
  ];
  const rule = `**The rule.** ${ruleText(segmentation.modalSessionsPerWeek)}`;
  return section(
    'Regular and broken weeks',
    findings(segmentation, weeks, sessions),
    body,
    CITATION,
    rule,
  );
}
