// The review list (VW-489): past local days, each reduced to what it takes to
// say "real training" or "bench test" without opening the day.
//
// Sessions are stored one row per exercise (and per side, and per restart), so
// a day is several rows. The local day is the unit the owner marks in, because
// it is the unit he remembers, and it is also the unit the training-day count
// is expressed in. `session.mark_kind { day }` takes the same date this
// produces, which is what makes a day one call.
//
// THE DAY OF A SESSION IS `reviewDayOf`, and it is the SAME rule the
// training-day count uses (`training-days.ts`): the local date of the session's
// end, or of its last working set's end when it was never ended. Bucketing the
// review list by the START instant instead would put an evening session that
// ran past local midnight on one row in the list and a different row in the
// report — the owner would mark day D and watch it land on D+1.
//
// Pure. The store read is `listSessionReviewRows`; nothing here touches SQL.

import type { SessionReviewRow, SessionStore } from '../store/types.js';
import type { SessionKind } from '../store/session-kind.js';
import { localDate } from './training-days.js';

/**
 * The local day a session belongs to. One rule, shared with the training-day
 * count: the end instant, the last working set's end when the session was never
 * ended, and only then the start — a session with neither is a row that recorded
 * no work, and its start is the only instant it has.
 */
export function reviewDayOf(row: SessionReviewRow): string {
  return localDate(row.endedAt ?? row.lastWorkingSetEndedAt ?? row.startedAt);
}

/** One exercise within a reviewed day. */
export interface ReviewDayExercise {
  name: string;
  exerciseId?: string;
  sets: number;
  workingSets: number;
  topLoadLbs?: number;
}

/** What a day says about itself when its sessions disagree. */
export type ReviewDayKind = SessionKind | 'mixed' | 'unreviewed';

/** One local day of recorded work, newest first in the list. */
export interface ReviewDay {
  day: string;
  kind: ReviewDayKind;
  sessionIds: string[];
  exercises: ReviewDayExercise[];
  sets: number;
  workingSets: number;
  /** Wall-clock span from the first session start to the last recorded activity, in minutes. */
  spanMinutes: number;
  /** False when any session of the day was never ended. */
  allEnded: boolean;
  /** True when any session of the day carried a planned exercise or template. */
  planned: boolean;
}

const UNLABELLED = 'unlabelled';

/**
 * How many past local days hold a session nobody has classified.
 *
 * Reported beside every excluded count (VW-489) so an empty number is never
 * read as "no training". A zero here means the history really is empty; a
 * non-zero one means it is being withheld pending review.
 */
export function unreviewedDayCount(rows: readonly SessionReviewRow[]): number {
  return unreviewedDaysOf(rows).length;
}

/** The unreviewed local days themselves, newest first. */
export function unreviewedDaysOf(rows: readonly SessionReviewRow[]): string[] {
  return reviewDays(rows)
    .filter((day) => day.kind === 'unreviewed' || day.kind === 'mixed')
    .map((day) => day.day);
}

/** The store slice the unreviewed read needs. */
export type UnreviewedStore = Pick<SessionStore, 'listSessionReviewRows'>;

/**
 * What every surface that shows a training-derived number needs beside it
 * (VW-489). ONE read, so no two surfaces can report a different number of days
 * waiting, and `days` so a caller can name them rather than just count them.
 */
export async function readUnreviewed(
  store: UnreviewedStore,
): Promise<{ unreviewedDays: number; unreviewedDayList: string[] }> {
  const days = unreviewedDaysOf(await store.listSessionReviewRows({ kind: 'unreviewed' }));
  return { unreviewedDays: days.length, unreviewedDayList: days };
}

/**
 * Group review rows into local days, newest first.
 *
 * Rows arrive newest-first from the store; the grouping does not rely on that,
 * and sorts the days itself so a caller passing any order gets the same answer.
 */
export function reviewDays(rows: readonly SessionReviewRow[]): ReviewDay[] {
  const byDay = new Map<string, SessionReviewRow[]>();
  for (const row of rows) {
    const day = reviewDayOf(row);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  return [...byDay.entries()]
    .map(([day, dayRows]) => toReviewDay(day, dayRows))
    .sort((a, b) => b.day.localeCompare(a.day));
}

function toReviewDay(day: string, rows: readonly SessionReviewRow[]): ReviewDay {
  return {
    day,
    kind: dayKind(rows),
    sessionIds: rows.map((row) => row.sessionId),
    exercises: dayExercises(rows),
    sets: sum(rows, (row) => row.setCount),
    workingSets: sum(rows, (row) => row.workingSetCount),
    spanMinutes: spanMinutes(rows),
    allEnded: rows.every((row) => row.endedAt !== undefined),
    planned: rows.some((row) => row.planned),
  };
}

/**
 * The day's kind. `'mixed'` is a real answer, not a failure: a day can hold one
 * real workout and one bench test, and collapsing that to either would lie.
 */
function dayKind(rows: readonly SessionReviewRow[]): ReviewDayKind {
  const kinds = new Set(rows.map((row) => row.kind ?? 'unreviewed'));
  if (kinds.size > 1) return 'mixed';
  return [...kinds][0] ?? 'unreviewed';
}

/**
 * One entry per exercise, heaviest first. Rows with no exercise at all collapse
 * into a single `unlabelled` entry — a day of them is the strongest signal in
 * the list that nobody was training.
 */
function dayExercises(rows: readonly SessionReviewRow[]): ReviewDayExercise[] {
  const byName = new Map<string, ReviewDayExercise>();
  for (const row of rows) {
    const name = row.exerciseName ?? row.exerciseId ?? UNLABELLED;
    const prior = byName.get(name);
    const merged: ReviewDayExercise = {
      name,
      ...(row.exerciseId !== undefined ? { exerciseId: row.exerciseId } : {}),
      sets: (prior?.sets ?? 0) + row.setCount,
      workingSets: (prior?.workingSets ?? 0) + row.workingSetCount,
    };
    const topLoad = maxDefined(prior?.topLoadLbs, row.topLoadLbs);
    if (topLoad !== undefined) merged.topLoadLbs = topLoad;
    byName.set(name, merged);
  }
  return [...byName.values()].sort((a, b) => (b.topLoadLbs ?? 0) - (a.topLoadLbs ?? 0));
}

/**
 * First start to last recorded activity. An unended session contributes the end
 * of its last set, which is the same instant the training-day rule reads.
 */
function spanMinutes(rows: readonly SessionReviewRow[]): number {
  const starts = rows.map((row) => Date.parse(row.startedAt));
  const ends = rows.flatMap((row) => {
    const last = row.endedAt ?? row.lastSetEndedAt;
    return last === undefined ? [] : [Date.parse(last)];
  });
  if (ends.length === 0) return 0;
  return Math.round((Math.max(...ends) - Math.min(...starts)) / 60_000);
}

function sum<T>(rows: readonly T[], of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
