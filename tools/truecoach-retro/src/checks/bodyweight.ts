// Check 6: bodyweight and waist phases joined to the main-lift e1RM trends.

import {
  bodyweightPhases,
  PHASE_RULE,
  readingsOf,
  type BodyweightPhase,
  type FieldReadings,
  type Reading,
} from '../bodyweight.js';
import type { Context } from '../context.js';
import { addDays } from '../dates.js';
import { num, section, signed, table } from '../markdown.js';

import { e1rmTrend, trendCell } from './progression.js';

const CITATION =
  'Fat loss runs 0.5 to 1% of bodyweight a week for 8 to 12 weeks; diet fatigue tracks cumulative percent lost (3 to 5% little, ' +
  '7 to 10% some, over 10% almost certainly) (`nKxk4_khp1I.md:32, 50-58, 74-88`, #83). Compare strength only between like phases; ' +
  'a small dip on a cut is "probably just general fatigue" (`QiXUeX1GfJQ.md:84-88`, #60). Nothing in the RP corpus reads waist, ' +
  'so it is reported, not interpreted (digest section 7, ranked check 8).';

function waistChange(waist: readonly Reading[], phase: BodyweightPhase): string {
  const inside = waist.filter((r) => r.date >= phase.startDate && r.date <= phase.endDate);
  if (inside.length < 2) return 'n/a';
  return `${num(inside[0]!.value)} to ${num(inside.at(-1)!.value)}`;
}

function phaseRow(phase: BodyweightPhase, waist: readonly Reading[]): (string | number)[] {
  const weeks = (Date.parse(phase.endDate) - Date.parse(phase.startDate)) / (7 * 86_400_000);
  return [
    phase.startDate,
    phase.endDate,
    num(weeks),
    phase.readings.length,
    `${num(phase.readings[0]!.value)} to ${num(phase.readings.at(-1)!.value)}`,
    signed(phase.slopeLbsPerWeek, 2),
    signed(phase.pctPerWeek, 2),
    phase.label,
    signed(phase.cumulativePct, 1),
    phase.dietFatigueBand ?? '',
    waistChange(waist, phase),
  ];
}

function joinRows(ctx: Context, phases: readonly BodyweightPhase[]): (string | number)[][] {
  return phases.flatMap((phase) =>
    ctx.mainLifts.map((lift) => {
      const period = { name: '', from: phase.startDate, to: addDays(phase.endDate, 1) };
      return [
        `${phase.startDate} (${phase.label})`,
        lift.series.label,
        trendCell(e1rmTrend(lift.series.points, period)),
      ];
    }),
  );
}

function findings(
  weight: FieldReadings,
  waist: FieldReadings,
  phases: readonly BodyweightPhase[],
): string[] {
  const labelled = (label: string) => phases.filter((p) => p.label === label);
  const deepest = [...labelled('loss')].sort((a, b) => a.cumulativePct - b.cumulativePct)[0];
  const dropped = weight.dropped.length + waist.dropped.length;
  return [
    `${weight.readings.length} bodyweight and ${waist.readings.length} waist readings (${dropped} dropped as implausible for their field), split into ${phases.length} phases: ${labelled('loss').length} loss, ${labelled('gain').length} gain, ${labelled('maintenance').length} maintenance.`,
    deepest === undefined
      ? 'No phase lost weight at 0.25% a week or faster.'
      : `The deepest loss phase ran ${deepest.startDate} to ${deepest.endDate} at ${signed(deepest.pctPerWeek, 2)}% a week, ${signed(deepest.cumulativePct, 1)}% in all (RP band: ${deepest.dietFatigueBand}).`,
    "The join table gives each main lift's e1RM slope inside each phase; many cells are thin, so read the n.",
  ];
}

const PHASE_HEADERS = [
  'start',
  'end',
  'weeks',
  'readings',
  'lb',
  'lb/wk',
  '%/wk',
  'phase',
  'cumulative %',
  'RP diet-fatigue band',
  'waist',
];

export function bodyweightSection(ctx: Context): string {
  const weight = readingsOf(ctx.checkins, 'Weight');
  const waist = readingsOf(ctx.checkins, 'Waist');
  const phases = bodyweightPhases(weight.readings);
  const dropped = [...weight.dropped, ...waist.dropped].map((r) => r.date).join(', ') || 'none';
  const body = [
    `A phase ends where the week-on-week sign of the weekly mean flips and holds ${PHASE_RULE.holdWeeks} weeks, or where check-ins stop for more than ${PHASE_RULE.gapDays} days. Loss or gain means a fitted rate of at least 0.25% of bodyweight a week. A reading more than 20% from its field's median is dropped (dates: ${dropped}).`,
    '',
    table(
      PHASE_HEADERS,
      phases.map((p) => phaseRow(p, waist.readings)),
    ),
    '',
    table(['phase', 'lift', 'e1RM lb/wk in phase'], joinRows(ctx, phases)),
  ];
  return section(
    '6. Bodyweight and waist against strength',
    findings(weight, waist, phases),
    body,
    CITATION,
  );
}
