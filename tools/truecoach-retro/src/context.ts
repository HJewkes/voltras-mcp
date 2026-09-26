// Everything the six checks share, computed once from the three inputs.

import { isoWeekStart } from './dates.js';
import { buildExerciseLookup, type ExerciseLookup } from './exercise-map.js';
import { groupBlocks, trainingDays } from './log-rules.js';
import { judgeBlock, UNDIVIDED_WARMUP_LOAD_SHARE, type BlockVerdict } from './missed-targets.js';
import { detectProgrammeSplit, periodsAround, type Period } from './periods.js';
import type { BoundaryDecision } from './segmentation.js';
import { buildSeries, loadedRowsBy, mainLiftRows, type LiftSeries } from './series.js';
import type { Block, CheckinRecord, ExerciseMapEntry, SetRecord } from './types.js';

export interface JudgedBlock {
  block: Block;
  verdict: BlockVerdict;
}

export interface MainLift {
  series: LiftSeries;
  family: string;
  /** Training days on which any variant of the family was trained. */
  familyDates: string[];
}

export interface Context {
  rows: SetRecord[];
  checkins: CheckinRecord[];
  lookup: ExerciseLookup;
  days: string[];
  judged: JudgedBlock[];
  /** The share of the prescribed load under which an undivided row reads as a warm-up. */
  warmupShare: number;
  periods: Period[];
  programmeSplit: { date: string | null; source: 'detected' | 'argument' };
  mainLifts: MainLift[];
  /** The human's boundary marks, or `null` when no decisions file was given. */
  decisions: BoundaryDecision[] | null;
}

function mainLiftsOf(rows: readonly SetRecord[], lookup: ExerciseLookup): MainLift[] {
  const byFamily = loadedRowsBy(rows, (row) => lookup.family(row.exercise_name));
  return [...mainLiftRows(rows, lookup)]
    .map(([name, liftRows]) => {
      const family = lookup.family(name) ?? name;
      const familyDates = [
        ...new Set((byFamily.get(family) ?? []).map((row) => row.workout_due_date)),
      ].sort();
      return { series: buildSeries(name, liftRows), family, familyDates };
    })
    .sort(
      (a, b) => a.family.localeCompare(b.family) || a.series.label.localeCompare(b.series.label),
    );
}

/** The row-derived parts of a context; periods and decisions carry over unchanged. */
function fromRows(rows: SetRecord[], lookup: ExerciseLookup, warmupShare: number) {
  return {
    rows,
    days: trainingDays(rows),
    judged: groupBlocks(rows).map((block) => ({ block, verdict: judgeBlock(block, warmupShare) })),
    warmupShare,
    mainLifts: mainLiftsOf(rows, lookup),
  };
}

export function buildContext(
  rows: SetRecord[],
  checkins: CheckinRecord[],
  map: readonly ExerciseMapEntry[],
  programmeSplitArg: string | null,
  decisions: BoundaryDecision[] | null = null,
  warmupShare: number = UNDIVIDED_WARMUP_LOAD_SHARE,
): Context {
  const lookup = buildExerciseLookup(map);
  const split = programmeSplitArg ?? detectProgrammeSplit(rows);
  return {
    ...fromRows(rows, lookup, warmupShare),
    checkins,
    lookup,
    periods: periodsAround(split),
    programmeSplit: { date: split, source: programmeSplitArg === null ? 'detected' : 'argument' },
    decisions,
  };
}

/** The same context over the rows dated inside `weeks`: what a check reads for regular weeks only. */
export function restrictToWeeks(ctx: Context, weeks: ReadonlySet<string>): Context {
  const rows = ctx.rows.filter(
    (row) => row.workout_due_date !== null && weeks.has(isoWeekStart(row.workout_due_date)),
  );
  return { ...ctx, ...fromRows(rows, ctx.lookup, ctx.warmupShare) };
}
