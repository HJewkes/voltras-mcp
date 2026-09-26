// Per muscle and week of a history: landmark sets, status and dose (VW-558, S5a).
//
// Every number comes from `buildMuscleWeekView`, the live body page's read
// model, so the history tab and the live page cannot disagree about a muscle:
// the landmark read counts target rows only (B47), the dose read sums weights
// and is never banded, and glutes, lats and upper back withhold their verdict.
//
// Rows with no exercise count toward the week's sets and never toward a
// muscle. Where sets the assigned-count rule kept as surplus work are over a
// tenth of a muscle's sets in a week, the row also carries the figure without
// them (design 2.3, step 5).
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import type { StoredSet } from '../../store/types.js';
import {
  buildMuscleWeekView,
  type MuscleWeekMuscleView,
  type VolumeStatus,
} from './muscle-week.js';
import { attributionFor, type MuscleCatalogLookup } from './muscle-set-scope.js';
import {
  evidenceOf,
  groupRows,
  isoWeekStart,
  noonInstant,
  workRows,
  type HistoryEvidence,
  type HistorySetRow,
} from './history-rows.js';
import { MUSCLE_MAP_VERSION, type TitanMuscleGroup } from '../../exercises/muscle-map.js';

export const HISTORY_MUSCLE_WEEK_CONSTANTS = {
  /** Design 2.3 step 5: the with-and-without pair shows once flagged surplus is over this share. */
  surplusPairShare: 0.1,
} as const;

export interface HistoryMuscleWeekRow extends Omit<MuscleWeekMuscleView, 'lastTrainedAt'> {
  /** The landmark read without surplus-kept sets; `null` unless they are over the pair share. */
  withoutSurplus: { sets: number; status: VolumeStatus | null } | null;
  /** Rows that reached this muscle in either read; `null` when none did. */
  evidence: HistoryEvidence | null;
}

export interface HistoryMuscleWeek {
  week: string;
  /** Every work set in the week, unmapped exercises included. */
  sets: number;
  /** Work sets whose exercise the catalog map does not hold: counted here, in no muscle. */
  unattributedSets: number;
  muscles: HistoryMuscleWeekRow[];
}

export interface HistoryMuscleWeeksView {
  muscleMapVersion: string;
  landmarkBasis: 'population-default';
  surplusPairBasis: string;
  weeks: HistoryMuscleWeek[];
}

export interface HistoryMuscleWeeksInput {
  rows: readonly HistorySetRow[];
  catalog: MuscleCatalogLookup;
}

const SURPLUS_PAIR_BASIS =
  'Sets the assigned-count rule kept as work although they exceeded the assigned count. ' +
  `Where they are over ${HISTORY_MUSCLE_WEEK_CONSTANTS.surplusPairShare * 100} percent of a ` +
  "muscle's landmark sets in a week, the row shows the figure with and without them.";

/** One stored set per set on the line, so the live eligibility rule reads it unchanged. */
function asStoredSets(row: HistorySetRow, index: number): StoredSet[] {
  const startedAt = noonInstant(row.day);
  return Array.from({ length: row.sets }, (_, k) => ({
    id: `history-${index}-${k}`,
    sessionId: row.day,
    startedAt,
    endedAt: startedAt,
    partial: false,
    source: 'imported' as const,
    setPurpose: 'working' as const,
    exerciseId: row.exerciseId!,
    ...(row.load === null ? {} : { weightLbs: row.load }),
    // A reported line with no rep count still holds a set.
    firmwareRepCount: row.reps ?? 1,
    reps: [],
  }));
}

function weekView(rows: readonly HistorySetRow[], week: string, catalog: MuscleCatalogLookup) {
  return buildMuscleWeekView({
    sets: rows.flatMap(asStoredSets),
    catalog,
    now: new Date(noonInstant(week)),
  });
}

function reaches(row: HistorySetRow, muscle: TitanMuscleGroup, catalog: MuscleCatalogLookup) {
  return attributionFor(row.exerciseId!, catalog).some((a) => a.muscle === muscle && a.weight > 0);
}

function muscleRow(
  all: MuscleWeekMuscleView,
  lean: MuscleWeekMuscleView,
  rows: readonly HistorySetRow[],
  catalog: MuscleCatalogLookup,
): HistoryMuscleWeekRow {
  const { lastTrainedAt: _omit, ...rest } = all;
  const surplus = all.sets - lean.sets;
  const paired =
    all.sets > 0 && surplus / all.sets > HISTORY_MUSCLE_WEEK_CONSTANTS.surplusPairShare;
  return {
    ...rest,
    withoutSurplus: paired ? { sets: lean.sets, status: lean.status } : null,
    evidence: evidenceOf(rows.filter((row) => reaches(row, all.muscle, catalog))),
  };
}

function historyWeek(
  week: string,
  rows: readonly HistorySetRow[],
  catalog: MuscleCatalogLookup,
): HistoryMuscleWeek {
  const mapped = rows.filter((row) => row.exerciseId !== null);
  const all = weekView(mapped, week, catalog);
  const lean = weekView(
    mapped.filter((row) => !row.surplusKeptAsWork),
    week,
    catalog,
  );
  const sumSets = (list: readonly HistorySetRow[]) => list.reduce((n, row) => n + row.sets, 0);
  return {
    week,
    sets: sumSets(rows),
    unattributedSets: sumSets(rows) - sumSets(mapped),
    muscles: all.muscles.map((muscle, i) => muscleRow(muscle, lean.muscles[i]!, mapped, catalog)),
  };
}

export function buildHistoryMuscleWeeksView(
  input: HistoryMuscleWeeksInput,
): HistoryMuscleWeeksView {
  const byWeek = groupRows(workRows(input.rows), (row) => isoWeekStart(row.day));
  const weeks = [...byWeek.keys()]
    .sort()
    .map((week) => historyWeek(week, byWeek.get(week)!, input.catalog));
  return {
    muscleMapVersion: MUSCLE_MAP_VERSION,
    landmarkBasis: 'population-default',
    surplusPairBasis: SURPLUS_PAIR_BASIS,
    weeks,
  };
}
