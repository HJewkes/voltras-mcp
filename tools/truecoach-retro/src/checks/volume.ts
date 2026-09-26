// Check 3: weekly work sets per target muscle against MEV, MAV and MRV, the dose column, and systemic weeks.

import {
  POPULATION_VOLUME_LANDMARKS,
  type VolumeStatus,
} from '../../../../src/dashboard/read-models/muscle-week.js';
import type { TitanMuscleGroup } from '../../../../src/exercises/muscle-map.js';

import type { Context } from '../context.js';
import { isoWeekStart } from '../dates.js';
import { comparisonBlock, num, pct, section, table, type Figure } from '../markdown.js';
import { underperformanceRuns } from '../underperformance.js';
import { volumeStatus, weeklyDoseByMuscle, weeklySetsByMuscle } from '../weekly.js';

import { muscleVerdicts } from './missed.js';

const CITATION =
  'MEV is where a meso starts and MRV the most fatigue that still lets performance progress (`-epbbILmiog.md:34-38`, #59); ' +
  'chronically training well under MRV leaves growth behind (`:46-48`). Systemic fatigue is two muscles, "especially two unrelated ' +
  'ones", hitting a two-time underperformance in the same week (`83yM6p9z2WU.md:86-92`, #38; `wvJ_hEL8p1M.md:52-58, 68`, #50). ' +
  "Landmarks are voltras-mcp's population defaults (muscle-week.ts), not RP's per-muscle pages, whose values differ (digest section 3).";

const ALL_MUSCLES = Object.keys(POPULATION_VOLUME_LANDMARKS) as TitanMuscleGroup[];

type WeekSets = Map<string, Map<TitanMuscleGroup, number>>;

/** A muscle trained as a target in at least this share of weeks is read as regularly trained. */
export const REGULAR_SHARE = 0.5;

interface MuscleRead {
  muscle: TitanMuscleGroup;
  /** Weeks per band; `null` where the landmark is unverified and no verdict is drawn (R8c). */
  counts: Record<VolumeStatus, number> | null;
  median: number;
  trained: number;
  /** The dose read's median: a comparison column, never banded. */
  doseMedian: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bandCounts(muscle: TitanMuscleGroup, sets: readonly number[]) {
  const counts: Record<VolumeStatus, number> = { under: 0, maintenance: 0, productive: 0, over: 0 };
  for (const n of sets) {
    const status = volumeStatus(muscle, n);
    if (status === null) return null;
    counts[status] += 1;
  }
  return counts;
}

function muscleRead(muscle: TitanMuscleGroup, weeks: WeekSets, dose: WeekSets): MuscleRead {
  const sets = [...weeks.values()].map((muscles) => muscles.get(muscle) ?? 0);
  const doses = [...weeks.keys()].map((week) => dose.get(week)?.get(muscle) ?? 0);
  return {
    muscle,
    counts: bandCounts(muscle, sets),
    median: median(sets),
    trained: sets.filter((n) => n > 0).length,
    doseMedian: median(doses),
  };
}

/** Every muscle with a set in either read, in taxonomy order. */
function muscleReads(ctx: Context): { weeks: WeekSets; reads: MuscleRead[] } {
  const weeks = weeklySetsByMuscle(ctx.rows, ctx.lookup);
  const dose = weeklyDoseByMuscle(ctx.rows, ctx.lookup);
  const dosed = new Set([...dose.values()].flatMap((muscles) => [...muscles.keys()]));
  const reads = ALL_MUSCLES.map((m) => muscleRead(m, weeks, dose)).filter(
    (r) => r.trained > 0 || dosed.has(r.muscle),
  );
  return { weeks, reads };
}

/** Weeks where two or more unrelated muscles each had a flagged (second-or-later) missed session. */
export function systemicWeeks(ctx: Context): Map<string, TitanMuscleGroup[]> {
  const flagged = new Map<string, Set<TitanMuscleGroup>>();
  for (const run of underperformanceRuns(muscleVerdicts(ctx))) {
    for (const date of run.dates.slice(1)) {
      const week = isoWeekStart(date);
      flagged.set(week, (flagged.get(week) ?? new Set()).add(run.muscle as TitanMuscleGroup));
    }
  }
  const systemic = new Map<string, TitanMuscleGroup[]>();
  for (const [week, muscles] of flagged) {
    const list = [...muscles];
    if (list.some((a, i) => list.slice(i + 1).some((b) => !ctx.lookup.related(a, b))))
      systemic.set(week, list.sort());
  }
  return new Map([...systemic].sort(([a], [b]) => a.localeCompare(b)));
}

function overMrvWeeks(ctx: Context, weeks: WeekSets): number {
  return [...weeks.values()].filter((muscles) => {
    const over = [...muscles].filter(([m, n]) => volumeStatus(m, n) === 'over').map(([m]) => m);
    return over.some((a, i) => over.slice(i + 1).some((b) => !ctx.lookup.related(a, b)));
  }).length;
}

function mostWeeks(reads: readonly MuscleRead[], status: VolumeStatus): string {
  const banded = reads.flatMap((r) => (r.counts === null ? [] : [{ ...r, counts: r.counts }]));
  const top = banded.sort((a, b) => b.counts[status] - a.counts[status])[0];
  return top === undefined ? 'no muscle' : `${top.muscle} (${top.counts[status]} weeks)`;
}

function findings(
  ctx: Context,
  reads: readonly MuscleRead[],
  weeks: WeekSets,
  systemic: number,
): string[] {
  const targeted = reads.filter((r) => r.trained > 0);
  const regular = targeted.filter((r) => r.trained >= weeks.size * REGULAR_SHARE);
  const rare = targeted.filter((r) => !regular.includes(r)).map((r) => r.muscle);
  const untrained = ALL_MUSCLES.filter((m) => !targeted.some((r) => r.muscle === m));
  const withheld = reads.filter((r) => r.counts === null).map((r) => r.muscle);
  return [
    `Across ${weeks.size} weeks with training, among muscles trained in at least half of them, ${mostWeeks(regular, 'under')} sat below MEV most often and ${mostWeeks(regular, 'over')} at or above MRV most often.`,
    `Trained in under half the weeks: ${rare.join(', ') || 'none'}. Never a target muscle: ${untrained.join(', ') || 'none'}.`,
    `No landmark verdict (the landmark is unverified): ${withheld.join(', ') || 'none'}.`,
    `${systemic} systemic weeks (two or more unrelated muscles flagged by the two-session rule); ${overMrvWeeks(ctx, weeks)} weeks had two or more unrelated muscles at or above MRV.`,
  ];
}

const HEADERS = [
  'muscle',
  'MEV/MAV/MRV',
  'weeks trained',
  'median sets/wk',
  'below MEV',
  'MEV to MAV',
  'MAV to MRV',
  'at or above MRV',
  'median dose sets/wk (fractional; not compared with landmarks)',
];

const NO_VERDICT = 'no verdict';
const NOT_A_TARGET = 'not a target';

/** Why a muscle has no band: an unverified landmark, or no target set in any week. */
function bandlessReason(read: MuscleRead): string | null {
  if (read.counts === null) return NO_VERDICT;
  return read.trained === 0 ? NOT_A_TARGET : null;
}

function readRow(read: MuscleRead): (string | number)[] {
  const l = POPULATION_VOLUME_LANDMARKS[read.muscle];
  const reason = bandlessReason(read);
  const bands =
    reason !== null || read.counts === null
      ? Array<string>(4).fill(reason ?? NO_VERDICT)
      : [read.counts.under, read.counts.maintenance, read.counts.productive, read.counts.over];
  return [
    read.muscle,
    read.counts === null ? 'unverified' : `${l.mev}/${l.mav}/${l.mrv}`,
    read.trained,
    num(read.median, 0),
    ...bands,
    num(read.doseMedian, 1),
  ];
}

/** The figures check 3 compares between all weeks and regular weeks. */
export function volumeFigures(ctx: Context): Figure[] {
  const { weeks, reads } = muscleReads(ctx);
  const perMuscle = reads.map(
    (r): Figure => [
      `${r.muscle}: median sets/wk, weeks below MEV, median dose sets/wk`,
      `${num(r.median, 0)}, ${bandlessReason(r) ?? pct(r.counts!.under, weeks.size)}, ${num(r.doseMedian, 1)}`,
    ],
  );
  return [
    ['weeks counted', `${weeks.size}`],
    ...perMuscle,
    ['systemic weeks', `${systemicWeeks(ctx).size}`],
    ['weeks with two unrelated muscles at or above MRV', `${overMrvWeeks(ctx, weeks)}`],
  ];
}

export function volumeSection(ctx: Context, regular: Context | null = null): string {
  const { weeks, reads } = muscleReads(ctx);
  const systemic = systemicWeeks(ctx);
  const body = [
    "Weeks counted are weeks with at least one training day. Sets are non-warm-up rows summed by their `sets` field. The bands read the landmark read (B47): a set counts 1 toward each target muscle of its map entry and nothing else. The last column is the dose read (Pelland et al. 2025): each set adds its entry's weight (1, 0.5 or 0) per muscle. It is a comparison only and is never banded against a landmark. Glutes, lats and upper back carry no band until RP's glute and back landmarks are verified.",
    '',
    table(HEADERS, reads.map(readRow)),
    '',
    table(
      ['systemic week', 'flagged muscles'],
      [...systemic].map(([week, list]) => [week, list.join(', ')]),
    ),
    ...comparisonBlock(volumeFigures(ctx), regular && volumeFigures(regular)),
  ];
  return section(
    '3. Weekly sets per muscle against the landmarks',
    findings(ctx, reads, weeks, systemic.size),
    body,
    CITATION,
  );
}
