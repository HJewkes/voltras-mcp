// Check 2: prescribed sets x reps against reported, by month and lift, and the two-session runs.

import type { Context, JudgedBlock } from '../context.js';
import { LOW_CONFIDENCE } from '../log-rules.js';
import { comparisonBlock, pct, section, table, type Figure } from '../markdown.js';
import { inPeriod } from '../periods.js';
import {
  underperformanceRuns,
  type MuscleVerdict,
  type UnderperformanceRun,
} from '../underperformance.js';

const CITATION =
  'Two sequential underperforming sessions for one muscle are MRV "by definition"; sessions, not weeks ' +
  '(`83yM6p9z2WU.md:46-58`, #38; `wvJ_hEL8p1M.md:48-50`, #50; `z7VVaqYEcco.md:54-58`, #58). ' +
  'Digest section 4, ranked check 1. Here underperformance means a missed prescription, not a drop from last week.';

type Tally = { judged: number; misses: number; loadShort: number };

function tallyBy(
  judged: readonly JudgedBlock[],
  keyOf: (entry: JudgedBlock) => string,
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const entry of judged) {
    if (entry.verdict.verdict === 'no-target') continue;
    const tally = tallies.get(keyOf(entry)) ?? { judged: 0, misses: 0, loadShort: 0 };
    tally.judged += 1;
    if (entry.verdict.verdict === 'miss') tally.misses += 1;
    if (entry.verdict.loadShort) tally.loadShort += 1;
    tallies.set(keyOf(entry), tally);
  }
  return tallies;
}

export function muscleVerdicts(ctx: Context): MuscleVerdict[] {
  return ctx.judged.flatMap(({ block, verdict }) =>
    ctx.lookup
      .primaryMuscles(block.exercise)
      .map((muscle) => ({ muscle, date: block.date, verdict: verdict.verdict })),
  );
}

function runRows(runs: readonly UnderperformanceRun[]): (string | number)[][] {
  const byMuscle = new Map<string, UnderperformanceRun[]>();
  for (const run of runs) byMuscle.set(run.muscle, [...(byMuscle.get(run.muscle) ?? []), run]);
  return [...byMuscle]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([muscle, list]) => [
      muscle,
      list.length,
      Math.max(...list.map((run) => run.sessions)),
      list[0]!.startDate,
      list.at(-1)!.endDate,
    ]);
}

function tallyRows(tallies: Map<string, Tally>, limit = Infinity): (string | number)[][] {
  return [...tallies]
    .slice(0, limit)
    .map(([key, t]) => [key, t.judged, t.misses, pct(t.misses, t.judged), t.loadShort]);
}

function caveats(ctx: Context): string {
  const judged = ctx.judged.filter((entry) => entry.verdict.verdict !== 'no-target');
  const byConstruction = judged.filter((entry) => entry.verdict.repsFromPrescription).length;
  const lowConfidence = judged.filter((entry) =>
    entry.block.rows.some((row) => row.confidence < LOW_CONFIDENCE),
  ).length;
  const undivided = judged.filter((entry) =>
    entry.block.rows.some((row) => row.is_warmup === null),
  ).length;
  return (
    `${byConstruction} judged blocks took reps from the prescription (a bare load under a one-rep-count line), so their rep check cannot fail. ` +
    `${lowConfidence} judged blocks hold a row under ${LOW_CONFIDENCE} confidence (included). ` +
    `${undivided} have no warm-up divider; there a row under 90% of the prescribed load is read as a warm-up.`
  );
}

function findings(ctx: Context, runs: readonly UnderperformanceRun[]): string[] {
  const judged = ctx.judged.filter((entry) => entry.verdict.verdict !== 'no-target');
  const misses = judged.filter((entry) => entry.verdict.verdict === 'miss');
  const setsShort = misses.filter((entry) => entry.verdict.setsShort).length;
  const muscles = new Set(runs.map((run) => run.muscle)).size;
  return [
    `${judged.length} of ${ctx.judged.length} blocks carry a fixed sets x reps prescription; ${misses.length} of them (${pct(misses.length, judged.length)}) missed it.`,
    `${setsShort} misses reported fewer sets than prescribed; ${misses.length - setsShort} had every set but some under the rep floor.`,
    `${runs.length} runs of two or more consecutive missed sessions on one muscle, across ${muscles} muscles.`,
  ];
}

function rate(entries: readonly JudgedBlock[]): string {
  const misses = entries.filter((entry) => entry.verdict.verdict === 'miss').length;
  return `${misses} of ${entries.length} (${pct(misses, entries.length)})`;
}

/** The figures check 2 compares between all weeks and regular weeks. */
export function missedFigures(ctx: Context): Figure[] {
  const judged = ctx.judged.filter((entry) => entry.verdict.verdict !== 'no-target');
  const misses = judged.filter((entry) => entry.verdict.verdict === 'miss');
  const runs = underperformanceRuns(muscleVerdicts(ctx));
  const perPeriod = ctx.periods.map(
    (period): Figure => [
      `${period.name}: missed of judged blocks`,
      rate(judged.filter((entry) => inPeriod(entry.block.date, period))),
    ],
  );
  return [
    ['missed of judged blocks', rate(judged)],
    ...perPeriod,
    [
      'misses that were sets short',
      `${misses.filter((e) => e.verdict.setsShort).length} of ${misses.length}`,
    ],
    [
      'two-session miss runs, muscles',
      `${runs.length}, ${new Set(runs.map((r) => r.muscle)).size}`,
    ],
    ['longest run, sessions', `${Math.max(0, ...runs.map((r) => r.sessions))}`],
  ];
}

export function missedSection(ctx: Context, regular: Context | null = null): string {
  const runs = underperformanceRuns(muscleVerdicts(ctx));
  const byMonth = new Map(
    [...tallyBy(ctx.judged, (e) => e.block.date.slice(0, 7))].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  const byLift = new Map(
    [...tallyBy(ctx.judged, (e) => e.block.exercise ?? '(no name)')].sort(
      (a, b) => b[1].judged - a[1].judged,
    ),
  );
  const headers = ['judged', 'missed', 'miss rate', 'under prescribed load'];
  const body = [
    caveats(ctx),
    '',
    table(['month', ...headers], tallyRows(byMonth)),
    '',
    table(['lift (top 20 by judged blocks)', ...headers], tallyRows(byLift, 20)),
    '',
    'Two-session runs per muscle:',
    '',
    table(
      ['muscle', 'runs', 'longest run (sessions)', 'first run starts', 'last run ends'],
      runRows(runs),
    ),
    ...comparisonBlock(missedFigures(ctx), regular && missedFigures(regular)),
  ];
  return section('2. Missed targets', findings(ctx, runs), body, CITATION);
}
