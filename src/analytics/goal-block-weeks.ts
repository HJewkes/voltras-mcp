// The calendar-week grid a goal target's block is read on (VW-421, VW-477).
//
// Week 1 is the LOCAL calendar week (Monday to Sunday) containing the frame's start: a
// block-bound target's block start, else the target's `startMeasuredAt`. Week N is the Nth
// calendar week from there. Every week position the goal read model takes — where a reading
// is drawn, which week `now` is, which band row a reading is judged against, which readings
// count toward the block-end milestone, and when the block ends — comes from this one grid,
// so no two of them can disagree about which week something is in.
//
// Calendar weeks rather than seven-day steps from the start instant because `history.trend`
// stamps each weekly bucket at its Monday: stepping from a mid-week start dropped the start's
// own bucket and drew every later one a week early. LOCAL because a session belongs to the
// local date it ended on (`training-days.ts`), and `history.trend` buckets by local week too,
// so a Sunday-evening session west of UTC lands in that Sunday's week, not the next one.
//
// Deliberately separate from `weeksInPhaseAt` (`diet-phase-tolerance.ts`),
// which counts seven-day steps for diet phases and keeps doing so.
//
// PURE apart from the process timezone, which `localDate` reads: every instant is an input.

import { addDays } from '../plan/block-calendar.js';
import { localDate, localMidnightIso } from './training-days.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday of the calendar week containing a 'YYYY-MM-DD' date. */
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}

/**
 * The 1-based block week `atIso` falls in, for a block that started at
 * `startIso`, both read as local dates. Unclamped: 0 or below is before the
 * block, past the block's length is after it. `NaN` when either instant does not parse.
 */
export function blockWeekAt(startIso: string, atIso: string): number {
  if (Number.isNaN(Date.parse(startIso)) || Number.isNaN(Date.parse(atIso))) return Number.NaN;
  const start = mondayOf(localDate(startIso));
  return daysBetween(start, mondayOf(localDate(atIso))) / 7 + 1;
}

/** The exclusive end of a `weekCount`-week block: local midnight of the Monday after its last week. */
export function blockEndsAt(startIso: string, weekCount: number): string {
  return localMidnightIso(addDays(mondayOf(localDate(startIso)), 7 * weekCount));
}

/**
 * A `history.trend` bucket stamp ('YYYY-MM-DDT00:00:00.000Z', its local Monday's date) as the
 * instant that Monday starts locally, so it sits in its own week on the local grid. Unchanged
 * under UTC.
 */
export function bucketStartIso(stamp: string): string {
  return localMidnightIso(stamp.slice(0, 10));
}
