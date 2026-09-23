// Per-session series for one lift: top load at the modal reps, and best e1RM.

import { estimateE1RMFromReps } from '@voltras/workout-analytics';

import {
  modalRepCount,
  topLoadAtReps,
  type RepCountedSet,
} from '../../../src/analytics/goal-history.js';

import { isoWeekStart, noonInstant } from './dates.js';
import type { ExerciseLookup } from './exercise-map.js';
import { isWorkRow } from './log-rules.js';
import type { SetRecord } from './types.js';

/** Epley overestimates past this many reps (workout-analytics' own note), so those sets carry no e1RM. */
export const MAX_E1RM_REPS = 12;

export interface SessionPoint {
  date: string;
  /** Heaviest load carried for at least the series' modal reps; `null` when no set reached them. */
  topLoadAtModal: number | null;
  bestE1RM: number | null;
  topLoad: number;
  exercises: string[];
}

export interface LiftSeries {
  label: string;
  modalReps: number | null;
  points: SessionPoint[];
}

export type LoadedRow = SetRecord & { workout_due_date: string; load: number };

function isLoadedWorkRow(row: SetRecord): row is LoadedRow {
  return isWorkRow(row) && row.load !== null && row.load > 0 && row.reps > 0;
}

/** Loaded work rows grouped by `keyOf`; a `null` key drops the row. */
export function loadedRowsBy(
  rows: readonly SetRecord[],
  keyOf: (row: SetRecord) => string | null,
): Map<string, LoadedRow[]> {
  const groups = new Map<string, LoadedRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || !isLoadedWorkRow(row)) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** One group per main-lift exercise. */
export function mainLiftRows(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): Map<string, LoadedRow[]> {
  return loadedRowsBy(rows, (row) =>
    lookup.isMainLift(row.exercise_name) ? row.exercise_name : null,
  );
}

function asRepCounted(row: LoadedRow): RepCountedSet {
  return {
    sessionId: row.workout_due_date,
    endedAt: noonInstant(row.workout_due_date),
    weightLbs: row.load,
    repCount: row.reps,
  };
}

function bestE1RM(rows: readonly LoadedRow[]): number | null {
  const estimates = rows
    .filter((row) => row.reps <= MAX_E1RM_REPS)
    .map((row) => estimateE1RMFromReps(row.load, row.reps).e1RM);
  return estimates.length === 0 ? null : Math.max(...estimates);
}

function pointOf(date: string, rows: readonly LoadedRow[], modalReps: number | null): SessionPoint {
  const atModal = modalReps === null ? null : topLoadAtReps(rows.map(asRepCounted), modalReps);
  return {
    date,
    topLoadAtModal: atModal?.value ?? null,
    bestE1RM: bestE1RM(rows),
    topLoad: Math.max(...rows.map((row) => row.load)),
    exercises: [...new Set(rows.map((row) => row.exercise_name ?? ''))].sort(),
  };
}

/** One point per training day, oldest first. */
export function buildSeries(label: string, rows: readonly LoadedRow[]): LiftSeries {
  const modalReps = modalRepCount(rows.map(asRepCounted));
  const byDate = new Map<string, LoadedRow[]>();
  for (const row of rows)
    byDate.set(row.workout_due_date, [...(byDate.get(row.workout_due_date) ?? []), row]);
  const points = [...byDate.keys()]
    .sort()
    .map((date) => pointOf(date, byDate.get(date)!, modalReps));
  return { label, modalReps, points };
}

/** The heaviest work load per ISO week: what the meso rule compares week on week. */
export function weeklyTopLoads(series: LiftSeries): Map<string, number> {
  const weeks = new Map<string, number>();
  for (const point of series.points) {
    const week = isoWeekStart(point.date);
    weeks.set(week, Math.max(weeks.get(week) ?? 0, point.topLoad));
  }
  return weeks;
}
