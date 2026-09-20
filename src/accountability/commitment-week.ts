// The week key a commitment is filed under (VW-505). One helper, shared by the write default
// and the Sunday anchor's read, so the row written at the Sunday sitting is the row the anchor
// reads back the following Sunday.
//
// Weeks run Monday to Sunday and are LOCAL: the instant is reduced to the lifter's local
// calendar date through `localDate` (the repo's one local-date rule) and every step from there
// is string arithmetic through `block-calendar`, which is timezone-independent.

import { localDate } from '../analytics/training-days.js';
import { addDays, isMonday } from '../plan/block-calendar.js';

/**
 * The Monday of the week a commitment declared at `instant` is for. A SUNDAY files against the
 * next day's Monday: the week containing a Sunday is already over, and the Sunday sitting
 * commits to the week that opens tomorrow, which is what the anchor's own "Slots for the coming
 * week" line promises. Every other day files against the week it is in.
 */
export function commitmentWeekOf(instant: Date | string): string {
  const date = localDate(typeof instant === 'string' ? instant : instant.toISOString());
  const tomorrow = addDays(date, 1);
  if (isMonday(tomorrow)) return tomorrow;
  let cursor = date;
  while (!isMonday(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}
