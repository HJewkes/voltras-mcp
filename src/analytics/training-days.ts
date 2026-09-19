// Training days: the unit a `sessions_28d` commitment counts (VW-460).
//
// The owner's ruling (2026-09-19): "One per training day". A stored session row
// is not a visit to the gym: one visit can hold a row per exercise, so twelve
// rows on one day are one training day.
//
// THE RULE, used by derivation, the goals read model and anything that lists
// the days themselves, so no two readers can count differently:
//
// - WINDOW: an ended session is in the window when its START instant is in
//   [now - 28 x 24 h, now]. The lower edge is inclusive.
// - DAY: an in-window session belongs to the local calendar date of its END
//   instant, read in the server process's timezone (`localDate`). That is the
//   date `report.session_results` already files a workout under.
// - COUNT: the number of distinct days. A day counts once however many
//   sessions it holds.
//
// Pure: callers fetch the end times and pass `now`, so fixtures can pin both.

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

/** The inclusive lower edge of the window that ends at `nowIso`, as an ISO instant. */
export function sessionWindowFrom(nowIso: string): string {
  return new Date(Date.parse(nowIso) - SESSION_WINDOW_DAYS * DAY_MS).toISOString();
}

/** The distinct local days the given session end times fall on, oldest first. */
export function trainingDaysOf(endTimes: readonly string[]): string[] {
  return [...new Set(endTimes.map(localDate))].sort();
}
