// Everything the six checks share, computed once from the three inputs.

import { buildExerciseLookup, type ExerciseLookup } from './exercise-map.js';
import { groupBlocks, trainingDays } from './log-rules.js';
import { judgeBlock, type BlockVerdict } from './missed-targets.js';
import { detectProgrammeSplit, periodsAround, type Period } from './periods.js';
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
  periods: Period[];
  programmeSplit: { date: string | null; source: 'detected' | 'argument' };
  mainLifts: MainLift[];
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

export function buildContext(
  rows: SetRecord[],
  checkins: CheckinRecord[],
  map: readonly ExerciseMapEntry[],
  programmeSplitArg: string | null,
): Context {
  const lookup = buildExerciseLookup(map);
  const split = programmeSplitArg ?? detectProgrammeSplit(rows);
  return {
    rows,
    checkins,
    lookup,
    days: trainingDays(rows),
    judged: groupBlocks(rows).map((block) => ({ block, verdict: judgeBlock(block) })),
    periods: periodsAround(split),
    programmeSplit: { date: split, source: programmeSplitArg === null ? 'detected' : 'argument' },
    mainLifts: mainLiftsOf(rows, lookup),
  };
}
