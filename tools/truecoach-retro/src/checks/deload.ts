// Check 4: meso boundaries by the simple rule, and meso lengths against RP's 3:1 to 5:1.

import type { Context } from '../context.js';
import { addDays, daysBetween, isoWeekStart } from '../dates.js';
import { pct, section, table } from '../markdown.js';
import {
  classifyMesoLength,
  loadDropWeeks,
  MESO_RULE,
  mesoBoundaries,
  mesosBetween,
  type MesoBoundary,
} from '../meso.js';
import type { BoundaryChoice } from '../segmentation.js';
import { weeklyTopLoads } from '../series.js';

const CITATION =
  'Intermediates run 3:1 to 5:1 accumulation to deload, mostly 4:1 or 5:1 (`83yM6p9z2WU.md:30-32`, #38); advanced lifters ' +
  '3:1 or 4:1 and "never" past 5:1 (`wvJ_hEL8p1M.md:32-34`, #50). Detecting a deload from load and gap drops is inferred ' +
  '(digest section 4, ranked check 2).';

function topLoads(ctx: Context): Map<string, Map<string, number>> {
  return new Map(ctx.mainLifts.map((lift) => [lift.series.label, weeklyTopLoads(lift.series)]));
}

export function boundariesOf(ctx: Context): MesoBoundary[] {
  return mesoBoundaries(ctx.days, topLoads(ctx));
}

export function choiceOf(ctx: Context, week: string): BoundaryChoice | null {
  return ctx.decisions?.find((d) => d.week === week)?.choice ?? null;
}

/** The boundaries the mesos are cut at: every one the rule found, less those the human marked not a boundary. */
export function confirmedBoundaries(ctx: Context): MesoBoundary[] {
  return boundariesOf(ctx).filter((b) => choiceOf(ctx, b.week) !== 'not_a_boundary');
}

/** The human's marks as one finding line; `null` when no decisions file was read. */
export function decisionsFinding(ctx: Context, boundaries: readonly MesoBoundary[]): string | null {
  if (ctx.decisions === null) return null;
  const tally = new Map<string, number>();
  for (const b of boundaries) {
    const choice = choiceOf(ctx, b.week) ?? 'unmarked';
    tally.set(choice, (tally.get(choice) ?? 0) + 1);
  }
  const parts = [...tally].map(([choice, n]) => `${n} ${choice.replace(/_/g, ' ')}`).join(', ');
  const planned = tally.get('planned_deload') ?? 0;
  const months = Math.round(daysBetween(ctx.days[0]!, ctx.days.at(-1)!) / 30.44);
  const verdict =
    planned === 0
      ? `The human marked zero planned deloads across ${months} months: that is the deload-cadence finding, where RP's 3:1 to 5:1 expects one every 4 to 6 weeks.`
      : `${planned} planned deloads across ${months} months, against RP's one every 4 to 6 weeks.`;
  return `The human marked all ${boundaries.length} boundaries (${parts}). ${verdict}`;
}

/** Weeks where only one main lift dropped: how close the load half of the rule came to firing. */
function singleDropWeeks(ctx: Context): number {
  return [...loadDropWeeks(topLoads(ctx)).values()].filter((lifts) => lifts.length === 1).length;
}

/** Miss rate in the two weeks before each boundary against every other week. */
function missClustering(ctx: Context, boundaries: readonly MesoBoundary[]): string {
  const before = new Set(boundaries.flatMap((b) => [addDays(b.week, -7), addDays(b.week, -14)]));
  const tally = { before: [0, 0], other: [0, 0] };
  for (const { block, verdict } of ctx.judged) {
    if (verdict.verdict === 'no-target') continue;
    const bucket = before.has(isoWeekStart(block.date)) ? tally.before : tally.other;
    bucket[0]! += verdict.verdict === 'miss' ? 1 : 0;
    bucket[1]! += 1;
  }
  return `Miss rate in the two weeks before a boundary: ${pct(tally.before[0]!, tally.before[1]!)} of ${tally.before[1]} judged blocks; in every other week: ${pct(tally.other[0]!, tally.other[1]!)} of ${tally.other[1]}.`;
}

export function deloadSection(ctx: Context): string {
  const boundaries = boundariesOf(ctx);
  const mesos = mesosBetween(ctx.days, confirmedBoundaries(ctx));
  const classes = mesos.map((meso) => classifyMesoLength(meso.trainedWeeks));
  const count = (label: string) => classes.filter((c) => c === label).length;
  const byGap = boundaries.filter((b) => b.triggers.some((t) => t.startsWith('gap'))).length;
  const marks = decisionsFinding(ctx, boundaries);
  const finding = [
    ...(marks === null ? [] : [marks]),
    `The rule (a ${MESO_RULE.dropPct}% top-load drop on ${MESO_RULE.liftsDropping} main lifts in one week, or a ${MESO_RULE.gapDays}-day gap) finds ${boundaries.length} boundaries, ${byGap} of them gaps.`,
    `That makes ${mesos.length} mesos: ${count('short')} shorter than 4 trained weeks, ${count('within 3:1 to 5:1')} within 3:1 to 5:1, ${count('long')} longer than 6.`,
    missClustering(ctx, boundaries),
  ];
  const body = [
    `Every boundary found, for the human to sanity-check against memory. A load drop compares a lift's heaviest work load with its own previous trained week; ${singleDropWeeks(ctx)} further weeks had a drop on one main lift only, which the rule does not count.`,
    '',
    table(
      ['boundary week', 'triggers', "human's mark"],
      boundaries.map((b) => [
        b.week,
        b.triggers.join('; '),
        choiceOf(ctx, b.week)?.replace(/_/g, ' ') ?? 'unmarked',
      ]),
    ),
    '',
    table(
      ['meso starts', 'next starts', 'calendar weeks', 'trained weeks', 'against 3:1 to 5:1'],
      mesos.map((meso, i) => [
        meso.startWeek,
        meso.endWeek,
        meso.weeks,
        meso.trainedWeeks,
        classes[i]!,
      ]),
    ),
  ];
  return section('4. Deload cadence', finding, body, CITATION);
}
