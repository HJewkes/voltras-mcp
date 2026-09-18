// The calendar-week grid a goal target's block is read on (VW-421).
//
// Week 1 is the ISO week (Monday 00:00 UTC) containing the target's
// `startMeasuredAt`; week N is the Nth calendar week from there. Every week
// position the goal read model takes — where a reading is drawn, which week
// `now` is, which band row a reading is judged against, which readings count
// toward the block-end milestone, and when the block ends — comes from this
// one grid, so no two of them can disagree about which week something is in.
//
// Calendar weeks rather than seven-day steps from the start instant because
// `history.trend` stamps each weekly bucket at its ISO Monday: stepping from a
// mid-week start dropped the start's own bucket and drew every later one a
// week early. UTC because that is the timezone those buckets are stamped in.
//
// Deliberately separate from `weeksInPhaseAt` (`diet-phase-tolerance.ts`),
// which counts seven-day steps for diet phases and keeps doing so.
//
// PURE. No store, no clock: every instant is an input.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the ISO week containing `ms`. */
function isoMondayMs(ms: number): number {
  const midnight = Math.floor(ms / DAY_MS) * DAY_MS;
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * DAY_MS;
}

/**
 * The 1-based block week `atIso` falls in, for a block that started at
 * `startIso`. Unclamped: 0 or below is before the block, past the block's
 * length is after it. `NaN` when either instant does not parse.
 */
export function blockWeekAt(startIso: string, atIso: string): number {
  const startMs = Date.parse(startIso);
  const atMs = Date.parse(atIso);
  if (Number.isNaN(startMs) || Number.isNaN(atMs)) return Number.NaN;
  return Math.round((isoMondayMs(atMs) - isoMondayMs(startMs)) / WEEK_MS) + 1;
}

/** The exclusive end of a `weekCount`-week block: Monday 00:00 UTC after its last week. */
export function blockEndsAt(startIso: string, weekCount: number): string {
  return new Date(isoMondayMs(Date.parse(startIso)) + weekCount * WEEK_MS).toISOString();
}
