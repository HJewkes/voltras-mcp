// Check 3: weekly work sets per primary muscle against MEV, MAV and MRV, and systemic weeks.

import {
  POPULATION_VOLUME_LANDMARKS,
  type VolumeStatus,
} from '../../../../src/dashboard/read-models/muscle-week.js';
import type { TitanMuscleGroup } from '../../../../src/exercises/muscle-map.js';

import type { Context } from '../context.js';
import { isoWeekStart } from '../dates.js';
import { comparisonBlock, num, pct, section, table, type Figure } from '../markdown.js';
import { underperformanceRuns } from '../underperformance.js';
import { volumeStatus, weeklySetsByMuscle } from '../weekly.js';

import { muscleVerdicts } from './missed.js';

const CITATION =
  'MEV is where a meso starts and MRV the most fatigue that still lets performance progress (`-epbbILmiog.md:34-38`, #59); ' +
  'chronically training well under MRV leaves growth behind (`:46-48`). Systemic fatigue is two muscles, "especially two unrelated ' +
  'ones", hitting a two-time underperformance in the same week (`83yM6p9z2WU.md:86-92`, #38; `wvJ_hEL8p1M.md:52-58, 68`, #50). ' +
  "Landmarks are voltras-mcp's population defaults (muscle-week.ts), not RP's per-muscle pages, whose values differ (digest section 3).";

const ALL_MUSCLES = Object.keys(POPULATION_VOLUME_LANDMARKS) as TitanMuscleGroup[];

type WeekSets = Map<string, Map<TitanMuscleGroup, number>>;

/** A muscle trained as a primary in at least this share of weeks is read as regularly trained. */
export const REGULAR_SHARE = 0.5;

interface MuscleRead {
  muscle: TitanMuscleGroup;
  counts: Record<VolumeStatus, number>;
  median: number;
  trained: number;
}

function muscleRead(muscle: TitanMuscleGroup, weeks: WeekSets): MuscleRead {
  const counts: Record<VolumeStatus, number> = { under: 0, maintenance: 0, productive: 0, over: 0 };
  const sets = [...weeks.values()].map((muscles) => muscles.get(muscle) ?? 0);
  for (const n of sets) counts[volumeStatus(muscle, n)] += 1;
  const sorted = [...sets].sort((a, b) => a - b);
  return {
    muscle,
    counts,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    trained: sets.filter((n) => n > 0).length,
  };
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
  const top = [...reads].sort((a, b) => b.counts[status] - a.counts[status])[0];
  return top === undefined ? 'no muscle' : `${top.muscle} (${top.counts[status]} weeks)`;
}

function findings(
  ctx: Context,
  reads: readonly MuscleRead[],
  weeks: WeekSets,
  systemic: number,
): string[] {
  const regular = reads.filter((r) => r.trained >= weeks.size * REGULAR_SHARE);
  const rare = reads.filter((r) => !regular.includes(r)).map((r) => r.muscle);
  const untrained = ALL_MUSCLES.filter((m) => !reads.some((r) => r.muscle === m));
  return [
    `Across ${weeks.size} weeks with training, among muscles trained in at least half of them, ${mostWeeks(regular, 'under')} sat below MEV most often and ${mostWeeks(regular, 'over')} at or above MRV most often.`,
    `Trained in under half the weeks: ${rare.join(', ') || 'none'}. Never a primary muscle: ${untrained.join(', ') || 'none'}.`,
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
];

function readRow({ muscle, counts, median, trained }: MuscleRead): (string | number)[] {
  const l = POPULATION_VOLUME_LANDMARKS[muscle];
  return [
    muscle,
    `${l.mev}/${l.mav}/${l.mrv}`,
    trained,
    num(median, 0),
    counts.under,
    counts.maintenance,
    counts.productive,
    counts.over,
  ];
}

/** The figures check 3 compares between all weeks and regular weeks. */
export function volumeFigures(ctx: Context): Figure[] {
  const weeks = weeklySetsByMuscle(ctx.rows, ctx.lookup);
  const reads = ALL_MUSCLES.map((m) => muscleRead(m, weeks)).filter((r) => r.trained > 0);
  const perMuscle = reads.map(
    (r): Figure => [
      `${r.muscle}: median sets/wk, weeks below MEV`,
      `${num(r.median, 0)}, ${pct(r.counts.under, weeks.size)}`,
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
  const weeks = weeklySetsByMuscle(ctx.rows, ctx.lookup);
  const reads = ALL_MUSCLES.map((m) => muscleRead(m, weeks)).filter((r) => r.trained > 0);
  const systemic = systemicWeeks(ctx);
  const body = [
    'Weeks counted are weeks with at least one training day. Sets are non-warm-up rows summed by their `sets` field, target-only: a `shoulders` primary counts toward all three delt groups and `back` toward lats and upper back, as muscle-map.ts maps them.',
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
