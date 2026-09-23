// The block calendar (VW-473): one block's live schedule row plus its plan weeks, turned into
// dated calendar weeks. Every reader of a dated block goes through `blockCalendar`, so none of
// them sees a history row or re-derives an end date.
//
// DATES ARE LOCAL CALENDAR DATES ('YYYY-MM-DD'), never instants. A session is placed by
// `localDate` from `training-days.ts`, the one local-date rule. Arithmetic on a date string
// runs in UTC so its weekday never depends on the process timezone: `new Date('2026-09-21')`
// is a UTC instant, and its LOCAL weekday west of UTC is the day before.
//
// Skips are keyed by the Monday of the calendar week they affect and applied in date order:
// - `hold`: the week keeps its plan week, marked held; the block ends on its planned date.
// - `extend`: an off week is inserted; every later plan week moves one calendar week on.
//
// Pure: callers pass `today` (a local date) and the rows, so fixtures can pin both.

import { localDate } from '../analytics/training-days.js';
import type { StoredBlockSchedule, StoredTrainingWeek } from '../store/types.js';

export type BlockState = 'undated' | 'upcoming' | 'current' | 'ended';

/** A plan week's content as the calendar needs it; `planWeek` counts from 1. */
export interface PlanWeek {
  planWeek: number;
  isDeload: boolean;
  name?: string;
}

export interface CalendarWeek {
  calendarWeek: number;
  /** The plan week run in this calendar week; `null` for an extend's off week. */
  planWeek: number | null;
  startsOn: string;
  endsOn: string;
  isDeload: boolean;
  name?: string;
  skipped: 'hold' | 'extend' | null;
}

export interface BlockCalendar {
  startsOn: string | null;
  endsOn: string | null;
  state: BlockState;
  weeks: CalendarWeek[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && utcDate(value).toISOString().slice(0, 10) === value;
}

/** Whether a 'YYYY-MM-DD' date falls on a Monday, independent of the process timezone. */
export function isMonday(date: string): boolean {
  return utcDate(date).getUTCDay() === 1;
}

export function addDays(date: string, days: number): string {
  return new Date(utcDate(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function utcDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Plan weeks from `training_weeks` rows: a row's plan week is its position, `orderIndex + 1`. */
export function planWeeksOf(rows: readonly StoredTrainingWeek[]): PlanWeek[] {
  return rows.map((row) => ({
    planWeek: row.orderIndex + 1,
    isDeload: row.isDeload,
    ...(row.name !== undefined ? { name: row.name } : {}),
  }));
}

/** Calendar weeks the row spans: its plan length plus one off week per extend. */
export function calendarWeekCount(row: StoredBlockSchedule): number {
  return row.weeksCount + row.skips.filter((skip) => skip.mode === 'extend').length;
}

/** The row's first and last local dates, or `null` for a cleared row. */
export function scheduleRange(
  row: StoredBlockSchedule,
): { startsOn: string; endsOn: string } | null {
  if (row.startsOn === undefined) return null;
  return { startsOn: row.startsOn, endsOn: addDays(row.startsOn, 7 * calendarWeekCount(row) - 1) };
}

const UNDATED: BlockCalendar = { startsOn: null, endsOn: null, state: 'undated', weeks: [] };

export function blockCalendar(
  live: StoredBlockSchedule | undefined,
  planWeeks: readonly PlanWeek[],
  today: string,
): BlockCalendar {
  const range = live === undefined ? null : scheduleRange(live);
  if (live === undefined || range === null) return UNDATED;
  return {
    ...range,
    state: stateOf(range, today),
    weeks: calendarWeeksOf(live, range.startsOn, planWeeks),
  };
}

function stateOf(range: { startsOn: string; endsOn: string }, today: string): BlockState {
  if (today < range.startsOn) return 'upcoming';
  return today <= range.endsOn ? 'current' : 'ended';
}

function calendarWeeksOf(
  live: StoredBlockSchedule,
  startsOn: string,
  planWeeks: readonly PlanWeek[],
): CalendarWeek[] {
  const skipOn = new Map(live.skips.map((skip) => [skip.weekOf, skip.mode]));
  const content = new Map(planWeeks.map((week) => [week.planWeek, week]));
  const weeks: CalendarWeek[] = [];
  let planWeek = 0;
  for (let n = 1; n <= calendarWeekCount(live); n++) {
    const weekStart = addDays(startsOn, 7 * (n - 1));
    const skipped = skipOn.get(weekStart) ?? null;
    const plan = skipped === 'extend' ? null : ++planWeek;
    const week = plan === null ? undefined : content.get(plan);
    weeks.push({
      calendarWeek: n,
      planWeek: plan,
      startsOn: weekStart,
      endsOn: addDays(weekStart, 6),
      isDeload: week?.isDeload ?? false,
      ...(week?.name !== undefined ? { name: week.name } : {}),
      skipped,
    });
  }
  return weeks;
}

/**
 * Why a schedule snapshot is malformed, or `null` when it is sound: `startsOn` on a Monday,
 * and every skip on a distinct Monday inside the calendar as it stands at that date, so an
 * extend can only open inside the block, never past its end.
 */
export function scheduleProblem(row: Omit<StoredBlockSchedule, 'id' | 'seq'>): string | null {
  if (!Number.isInteger(row.weeksCount) || row.weeksCount < 1) {
    return `weeksCount must be a whole number of at least 1, got ${row.weeksCount}`;
  }
  if (row.startsOn === undefined) return null;
  if (!isIsoDate(row.startsOn) || !isMonday(row.startsOn)) {
    return `startsOn must be a Monday as YYYY-MM-DD, got ${row.startsOn}`;
  }
  return skipProblem(row.startsOn, row.weeksCount, row.skips);
}

function skipProblem(
  startsOn: string,
  weeksCount: number,
  skips: StoredBlockSchedule['skips'],
): string | null {
  const sorted = [...skips].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  let extendsBefore = 0;
  for (const [index, skip] of sorted.entries()) {
    if (!isIsoDate(skip.weekOf) || !isMonday(skip.weekOf)) {
      return `a skip's weekOf must be a Monday as YYYY-MM-DD, got ${skip.weekOf}`;
    }
    if (index > 0 && sorted[index - 1].weekOf === skip.weekOf) {
      return `two skips name the week of ${skip.weekOf}`;
    }
    const end = addDays(startsOn, 7 * (weeksCount + extendsBefore));
    if (skip.weekOf < startsOn || skip.weekOf >= end) {
      return `the skip for the week of ${skip.weekOf} falls outside the block`;
    }
    if (skip.mode === 'extend') extendsBefore++;
  }
  return null;
}

/** The calendar week a session belongs to, by the local date of its end instant (I10). */
export function weekOfInstant(calendar: BlockCalendar, instantIso: string): CalendarWeek | null {
  const date = localDate(instantIso);
  return calendar.weeks.find((week) => week.startsOn <= date && date <= week.endsOn) ?? null;
}
