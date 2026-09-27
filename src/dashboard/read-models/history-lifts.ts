// Per lift and chapter: the session series, its slopes and its plateau windows (VW-558, S5a).
//
// The series is WA's `buildLiftSeries` (top load at the modal reps, best Epley
// e1RM on sets of 12 reps or fewer). A chapter never reads across into another
// (D8): a barbell history and a later cable chapter of the same muscle are two
// series, and nothing here converts between them.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  analyzeTrend,
  buildLiftSeries,
  detectPlateau,
  slopeStandardError,
  type LiftSeries,
  type LiftSessionPoint,
  type LiftSetInput,
} from '@voltras/workout-analytics';

import { flatline, plateauReferenceStepLbs } from '../../analytics/flatline.js';
import {
  evidenceOf,
  groupRows,
  noonInstant,
  workRows,
  type HistoryEvidence,
  type HistorySetRow,
} from './history-rows.js';

export const HISTORY_LIFT_CONSTANTS = {
  /** The shortest plateau window in days: `detectPlateau`'s own default. */
  plateauMinDays: 14,
  /** ENGINEERING DEFAULT: two sessions a fortnight apart are a repeat, not a plateau. */
  plateauMinSessions: 3,
  /** Two-sided 95% normal quantile for the slope interval. */
  z95: 1.96,
} as const;

/** One exercise's dated chapter. `last: null` is still open. */
export interface HistoryChapter {
  id: string;
  exerciseId: string;
  first: string;
  last: string | null;
}

/** A named date range each chapter's slopes are also read over, such as a programme period. */
export interface HistoryPeriod {
  name: string;
  first: string;
  last: string;
}

export interface HistoryLiftsInput {
  rows: readonly HistorySetRow[];
  chapters?: readonly HistoryChapter[];
  periods?: readonly HistoryPeriod[];
}

export interface HistoryLiftPoint extends LiftSessionPoint {
  evidence: HistoryEvidence;
}

/** A least-squares slope per week with the half-width of its 95% interval. */
export interface HistoryTrendRead {
  slopePerWeek: number;
  /** `null` under three points or on a perfect fit. */
  ci95PerWeek: number | null;
  rSquared: number;
  n: number;
}

export interface HistoryLiftSlope {
  /** `'chapter'` for the whole chapter, otherwise a period name. */
  period: string;
  e1rm: HistoryTrendRead | null;
  topLoadAtModal: HistoryTrendRead | null;
}

export interface HistoryPlateauWindow {
  start: string;
  end: string;
  sessions: number;
  /** The VW-452 rule also held: WA's window and a slope under a quarter of the reference step. */
  flatline: boolean;
}

export interface HistoryLiftChapterView {
  exerciseId: string;
  /** `null` when the caller named no chapters for this exercise: one chapter spans every row. */
  chapterId: string | null;
  modalReps: number | null;
  points: HistoryLiftPoint[];
  /** The chapter's best e1RM and the day it was set. */
  best: { value: number; day: string } | null;
  slopes: HistoryLiftSlope[];
  plateaus: HistoryPlateauWindow[];
  evidence: HistoryEvidence | null;
}

export interface HistoryLiftsView {
  lifts: HistoryLiftChapterView[];
}

type Series = { ts: string; value: number }[];

export function trendRead(series: Series): HistoryTrendRead | null {
  if (series.length < 2) return null;
  const fit = analyzeTrend(series, { flatThresholdPerDay: 0 });
  const se = slopeStandardError(fit.slope, fit.rSquared, fit.pointCount);
  return {
    slopePerWeek: fit.slope * 7,
    ci95PerWeek: se === null ? null : HISTORY_LIFT_CONSTANTS.z95 * se * 7,
    rSquared: fit.rSquared,
    n: fit.pointCount,
  };
}

function seriesOf(
  points: readonly LiftSessionPoint[],
  pick: (point: LiftSessionPoint) => number | null,
): Series {
  return points.flatMap((point) => {
    const value = pick(point);
    return value === null ? [] : [{ ts: noonInstant(point.day), value }];
  });
}

function slopeOver(period: string, points: readonly LiftSessionPoint[]): HistoryLiftSlope {
  return {
    period,
    e1rm: trendRead(seriesOf(points, (p) => p.bestE1RM)),
    topLoadAtModal: trendRead(seriesOf(points, (p) => p.topLoadAtModal)),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Trailing windows ending at each session, merged where they overlap. */
function rawWindows(series: Series, step: number): { start: number; end: number; flat: boolean }[] {
  const { plateauMinDays } = HISTORY_LIFT_CONSTANTS;
  const windows: { start: number; end: number; flat: boolean }[] = [];
  for (let end = 1; end < series.length; end++) {
    const prefix = series.slice(0, end + 1);
    const found = detectPlateau(prefix, undefined, plateauMinDays);
    if (!found.isPlateau) continue;
    const from = Date.parse(prefix[end]!.ts) - found.plateauDays * 86_400_000;
    const start = prefix.findIndex((point) => Date.parse(point.ts) >= from);
    const flat =
      flatline(prefix, { expectedStepLbsPerWeek: step, minDays: plateauMinDays }) !== null;
    const last = windows.at(-1);
    if (last !== undefined && start <= last.end)
      Object.assign(last, { end, flat: last.flat || flat });
    else windows.push({ start, end, flat });
  }
  return windows;
}

/** Every plateau window along the chapter's e1RM series, oldest first. */
export function plateauWindows(points: readonly LiftSessionPoint[]): HistoryPlateauWindow[] {
  const valued = points.filter((point) => point.bestE1RM !== null);
  if (valued.length === 0) return [];
  const step = plateauReferenceStepLbs(median(valued.map((point) => point.topLoad)));
  const series = seriesOf(valued, (p) => p.bestE1RM);
  return rawWindows(series, step)
    .filter(({ start, end }) => end - start + 1 >= HISTORY_LIFT_CONSTANTS.plateauMinSessions)
    .map(({ start, end, flat }) => ({
      start: valued[start]!.day,
      end: valued[end]!.day,
      sessions: end - start + 1,
      flatline: flat,
    }));
}

function setInputs(rows: readonly HistorySetRow[]): LiftSetInput[] {
  return rows.flatMap((row) =>
    row.load === null || row.reps === null
      ? []
      : [{ day: row.day, load: row.load, reps: row.reps, sets: row.sets }],
  );
}

function bestOf(points: readonly LiftSessionPoint[]): { value: number; day: string } | null {
  let best: { value: number; day: string } | null = null;
  for (const point of points) {
    if (point.bestE1RM !== null && (best === null || point.bestE1RM > best.value)) {
      best = { value: point.bestE1RM, day: point.day };
    }
  }
  return best;
}

function chapterView(
  exerciseId: string,
  chapterId: string | null,
  rows: readonly HistorySetRow[],
  periods: readonly HistoryPeriod[],
): HistoryLiftChapterView {
  const series: LiftSeries = buildLiftSeries(setInputs(rows));
  const byDay = groupRows(rows, (row) => row.day);
  const points = series.points.map((point: LiftSessionPoint) => ({
    ...point,
    evidence: evidenceOf(byDay.get(point.day) ?? [])!,
  }));
  const inPeriod = (p: HistoryPeriod) =>
    series.points.filter((point: LiftSessionPoint) => point.day >= p.first && point.day <= p.last);
  return {
    exerciseId,
    chapterId,
    modalReps: series.modalReps,
    points,
    best: bestOf(series.points),
    slopes: [
      slopeOver('chapter', series.points),
      ...periods.map((p) => slopeOver(p.name, inPeriod(p))),
    ],
    plateaus: plateauWindows(series.points),
    evidence: evidenceOf(rows),
  };
}

const inChapter = (row: HistorySetRow, chapter: HistoryChapter) =>
  row.day >= chapter.first && (chapter.last === null || row.day <= chapter.last);

/** One view per chapter the caller named for this exercise, or one spanning every row. */
function viewsForExercise(
  exerciseId: string,
  rows: readonly HistorySetRow[],
  input: HistoryLiftsInput,
): HistoryLiftChapterView[] {
  const periods = input.periods ?? [];
  const chapters = (input.chapters ?? []).filter((c) => c.exerciseId === exerciseId);
  if (chapters.length === 0) return [chapterView(exerciseId, null, rows, periods)];
  return chapters.map((chapter) =>
    chapterView(
      exerciseId,
      chapter.id,
      rows.filter((row) => inChapter(row, chapter)),
      periods,
    ),
  );
}

export function buildHistoryLiftsView(input: HistoryLiftsInput): HistoryLiftsView {
  const mapped = workRows(input.rows).filter((row) => row.exerciseId !== null);
  const byExercise = groupRows(mapped, (row) => row.exerciseId!);
  return {
    lifts: [...byExercise].flatMap(([exerciseId, rows]) =>
      viewsForExercise(exerciseId, rows, input),
    ),
  };
}
