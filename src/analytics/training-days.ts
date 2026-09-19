// Training days: the unit a `sessions_28d` commitment counts (VW-460).
//
// The owner's ruling (2026-09-19): "One per training day". A stored session row
// is not a visit to the gym: one visit can hold a row per exercise, so twelve
// rows on one day are one training day.
//
// THE RULE, used by every lifter-facing session count (VW-462): derivation, the
// goals read model, report.weekly, the accountability copy, the tier signal and
// the check-in gate, so no two readers can count differently:
//
// - WINDOW: an ended session is in the window when its START instant is in
//   [now - 28 x 24 h, now]. The lower edge is inclusive.
// - DAY: an in-window session belongs to the local calendar date of its END
//   instant, read in the server process's timezone (`localDate`). That is the
//   date `report.session_results` already files a workout under.
// - COUNT: the number of distinct days. A day counts once however many
//   sessions it holds.
//
// The rule itself is pure. The two readers at the bottom are the only store
// reads behind a training-day count, and both take `now` from the caller.

import type { SessionCountFilter, SessionStore } from '../store/types.js';

/** The rolling window a `sessions_28d` commitment is counted over, in days. */
export const SESSION_WINDOW_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar date the lifter would call this workout, not the UTC one. A
 * 9pm session ends after midnight UTC, and logging it against the next day
 * puts it on the wrong row of the coach's week.
 */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Today's local calendar date: the one clock every dated-block rule reads (VW-474). */
export function todayLocal(): string {
  return localDate(new Date().toISOString());
}

/** The inclusive lower edge of the window that ends at `nowIso`, as an ISO instant. */
export function sessionWindowFrom(nowIso: string): string {
  return new Date(Date.parse(nowIso) - SESSION_WINDOW_DAYS * DAY_MS).toISOString();
}

/** The distinct local days the given session end times fall on, oldest first. */
export function trainingDaysOf(endTimes: readonly string[]): string[] {
  return [...new Set(endTimes.map(localDate))].sort();
}

/** A run of days with no training, and the training day that ended it. */
export interface TrainingGap {
  /** Whole calendar days between the two training days either side of the gap. */
  days: number;
  /** The first training day after the gap. */
  endsOn: string;
}

/**
 * The gaps between consecutive training days, oldest first. Local dates parse as UTC midnight,
 * so the difference is whole days with no daylight-saving drift. The one gap walk behind both
 * the tier signal's longest logged gap and the layoff read.
 */
export function trainingGaps(days: readonly string[]): TrainingGap[] {
  return days.slice(1).map((day, index) => ({
    days: (Date.parse(day) - Date.parse(days[index])) / DAY_MS,
    endsOn: day,
  }));
}

/** The store slice a training-day read needs. */
export type TrainingDayStore = Pick<SessionStore, 'listSessionEndTimes'>;

/** The training days of the ended sessions `filter` matches, oldest first. */
export async function readTrainingDaysMatching(
  store: TrainingDayStore,
  filter: SessionCountFilter,
): Promise<string[]> {
  return trainingDaysOf(await store.listSessionEndTimes(filter));
}

/**
 * The training days in the rolling window that ends at `nowIso`, oldest first.
 * `from` raises the lower edge, which is how the aging-out count asks what stays;
 * `lifter` reads a guest's days instead of the owner's.
 */
export async function readTrainingDays(
  store: TrainingDayStore,
  nowIso: string,
  options: { from?: string; lifter?: string } = {},
): Promise<string[]> {
  return readTrainingDaysMatching(store, {
    from: options.from ?? sessionWindowFrom(nowIso),
    to: nowIso,
    ...(options.lifter !== undefined ? { lifter: options.lifter } : {}),
  });
}
