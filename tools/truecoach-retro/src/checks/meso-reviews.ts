// Checks 7 to 9 (VW-549): restart load, the in-meso set ramp and staleness, on the confirmed mesos.

import type { Context } from '../context.js';
import { num, pct, section, signed, table } from '../markdown.js';
import { mesosBetween } from '../meso.js';
import {
  carries,
  MESO_CHECK_RULE,
  mesoRamps,
  restarts,
  type Carry,
  type MesoSpan,
  type Ramp,
  type Restart,
  type RestartKind,
} from '../meso-checks.js';
import { plateauWindows } from '../plateaus.js';
import { weeklyTopLoads } from '../series.js';
import { weeklySetsByMuscle } from '../weekly.js';

import { confirmedBoundaries } from './deload.js';

export type LiftRestart = Restart & { lift: string };
export type LiftCarry = Carry & { lift: string };

export function confirmedMesos(ctx: Context): MesoSpan[] {
  return mesosBetween(ctx.days, confirmedBoundaries(ctx));
}

export function liftRestarts(ctx: Context): LiftRestart[] {
  const mesos = confirmedMesos(ctx);
  return ctx.mainLifts.flatMap((lift) =>
    restarts(weeklyTopLoads(lift.series), mesos).map((r) => ({ lift: lift.series.label, ...r })),
  );
}

export function ramps(ctx: Context): Ramp[] {
  return mesoRamps(weeklySetsByMuscle(ctx.rows, ctx.lookup), confirmedMesos(ctx));
}

export function liftCarries(ctx: Context): LiftCarry[] {
  const mesos = confirmedMesos(ctx);
  return ctx.mainLifts.flatMap((lift) => {
    const flatlines = plateauWindows(lift.series.points, lift.familyDates)
      .filter((w) => w.flatline)
      .map((w) => ({ start: w.startDate, end: w.endDate }));
    return carries(lift.series.points, flatlines, mesos).map((c) => ({
      lift: lift.series.label,
      ...c,
    }));
  });
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

const countText = (counts: ReadonlyMap<string, number>) =>
  [...counts].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

const RESTART_CITATION =
  "Beginners restart the next meso at the final week's load or 5 lb more (`lZYGZOYTS08.md:132-136`, #27); intermediates at the " +
  'week-2 or week-3 load (`xslGdIDByfI.md:44-50`, #39); advanced lifters at week 2 with "just a little bit of an increase" ' +
  '(`jZBSKK-XJP0.md:34-36`, #51). Digest section 1, ranked check 6.';

const RESTART_KINDS: readonly RestartKind[] = [
  'at or above final',
  'mid-meso',
  'at week 1 or below',
];

function plannedLine(ctx: Context): string {
  const planned = ctx.decisions?.filter((d) => d.choice === 'planned_deload').length ?? null;
  if (planned === null)
    return 'No boundary decisions were read, so a boundary here may be a planned deload or a break.';
  return planned === 0
    ? "The human marked no boundary a planned deload, so every restart here follows a break the plan did not schedule; RP's pattern assumes a deload before it."
    : `${planned} boundaries were marked planned deloads; the rest follow breaks the plan did not schedule.`;
}

export function restartSection(ctx: Context): string {
  const rows = liftRestarts(ctx);
  const kinds = countBy(rows, (r) => r.kind);
  const finding = [
    `${rows.length} restarts can be read: a main lift trained in at least 2 weeks of one confirmed meso and again in the next.`,
    `By RP's tier pattern: ${RESTART_KINDS.map((k) => `${k} ${kinds.get(k) ?? 0}`).join(', ')}.`,
    plannedLine(ctx),
  ];
  const body = [
    `The restart load is the lift's heaviest work load in the first week it appears in the new meso. It is "at or above final" within ${MESO_CHECK_RULE.sameLoadLbs} lb of the previous meso's last week or above it (RP's beginner restart), "at week 1 or below" within ${MESO_CHECK_RULE.sameLoadLbs} lb of that meso's first week or under it (a full reset), and "mid-meso" in between (RP's intermediate and advanced restart).`,
    '',
    table(
      [
        'lift',
        'previous meso',
        'next meso',
        'previous weekly top loads',
        'restart load',
        'restart',
      ],
      rows.map((r) => [
        r.lift,
        r.previousStart,
        r.start,
        r.previousLoads.join(', '),
        r.restartLoad,
        r.kind,
      ]),
    ),
  ];
  return section('7. Meso restart load', finding, body, RESTART_CITATION);
}

const RAMP_CITATION =
  'A meso starts near MEV and adds sets towards MRV (`-epbbILmiog.md:34-38`, #59); "weekly chest sets were flat across every meso, ' +
  'with no MEV-to-MRV ramp" is the digest\'s example finding (section 3, ranked check 3, second half). The flat band is an engineering default.';

function rampRow(mesoStart: string, list: readonly Ramp[]): (string | number)[] {
  const kinds = countBy(list, (r) => r.kind);
  return [
    mesoStart,
    list[0]!.sets.length,
    kinds.get('ramped') ?? 0,
    kinds.get('flat') ?? 0,
    kinds.get('fell') ?? 0,
    list
      .filter((r) => r.kind === 'ramped')
      .map((r) => r.muscle)
      .join(', '),
  ];
}

export function rampSection(ctx: Context): string {
  const all = ramps(ctx);
  const byMeso = new Map<string, Ramp[]>();
  for (const r of all) byMeso.set(r.mesoStart, [...(byMeso.get(r.mesoStart) ?? []), r]);
  const ramped = all.filter((r) => r.kind === 'ramped').length;
  const finding = [
    `${byMeso.size} confirmed mesos hold at least ${MESO_CHECK_RULE.minRampWeeks} trained weeks; across them, ${ramped} of ${all.length} muscle-mesos (${pct(ramped, all.length)}) ramped weekly sets up by at least ${MESO_CHECK_RULE.rampSetsPerWeek} a week.`,
    `The rest: ${countText(
      countBy(
        all.filter((r) => r.kind !== 'ramped'),
        (r) => r.kind,
      ),
    )}.`,
    `Read with check 4: the longest meso read here holds ${Math.max(0, ...all.map((r) => r.sets.length))} trained weeks, against the 4 to 6 weeks a ramp is written for.`,
  ];
  const body = [
    `A ramp is the least-squares slope of a muscle's weekly work sets across the meso's trained weeks (a week without that muscle counts as 0 sets). At least ${MESO_CHECK_RULE.rampSetsPerWeek} sets a week up is "ramped", as far down is "fell", and anything between is "flat".`,
    '',
    table(
      ['meso starts', 'trained weeks', 'ramped', 'flat', 'fell', 'muscles that ramped'],
      [...byMeso].map(([start, list]) => rampRow(start, list)),
    ),
    '',
    table(
      ['meso starts', 'muscle', 'weekly sets', 'slope sets/wk', 'ramp'],
      all.map((r) => [r.mesoStart, r.muscle, r.sets.join(' '), signed(r.slope, 2), r.kind]),
    ),
  ];
  return section('8. The ramp of weekly sets inside each meso', finding, body, RAMP_CITATION);
}

const STALE_CITATION =
  "An exercise's SFR declines after about 4 to 8 weeks; swap it once underperformance shows, at the meso's end " +
  '(lecture #9, lines 75-77, 95 and 105-113; `HFikx0R80OY.md:162-170`, #56). "The default is that all exercises stay" while they progress ' +
  '(`xslGdIDByfI.md:32-40`, #39). Digest section 2, ranked check 9.';

function staleFinding(rows: readonly LiftCarry[]): string[] {
  const open = rows.filter((c) => c.plateauOpen);
  const stale = rows.filter((c) => c.stale);
  return [
    `Main lifts were kept across a confirmed boundary ${rows.length} times; ${open.length} of those went in with a VW-452 flatline window still open.`,
    `${stale.length} are stale: the plateau was open and the next meso's peak e1RM did not beat the last one by more than ${MESO_CHECK_RULE.flatE1rmLbs} lb (${countText(countBy(stale, (c) => c.lift))}).`,
    `The other ${open.length - stale.length} open plateaus broke in the next meso without a swap.`,
  ];
}

export function stalenessSection(ctx: Context): string {
  const rows = liftCarries(ctx);
  const body = [
    `A carry is a main lift with an e1RM in two consecutive confirmed mesos. Its plateau is open when a flatline window (check 1) covers its last session before the boundary. It is stale when the plateau was open and the next meso's peak e1RM rose by no more than ${MESO_CHECK_RULE.flatE1rmLbs} lb (RP's "one rep or 5 lb" margin).`,
    '',
    table(
      [
        'lift',
        'previous meso',
        'next meso',
        'peak e1RM before',
        'peak e1RM after',
        'change',
        'plateau open',
        'stale',
      ],
      rows.map((c) => [
        c.lift,
        c.previousStart,
        c.start,
        num(c.peakBefore),
        num(c.peakAfter),
        signed(c.peakAfter - c.peakBefore),
        c.plateauOpen ? 'yes' : 'no',
        c.stale ? 'yes' : 'no',
      ]),
    ),
  ];
  return section('9. Staleness', staleFinding(rows), body, STALE_CITATION);
}
