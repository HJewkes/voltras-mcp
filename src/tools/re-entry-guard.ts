// The return-window guard (VW-978): no max tests and no eccentric overload in the first weeks back
// after a break of the medium band or wider.
//
// It follows the mount-load gate's shape (VW-274): the handler calls it before any device write or
// lease, so a refusal leaves the device untouched. It reads the same re-entry result as
// `plan.next_workout`, so the coach and the guard never disagree about whether a window is open.
// There is no override flag (owner decision OD7): the window ends on its own date.
//
// The refusal names the window's last day, never a day count: the return path never tells the
// lifter how long they were away.

import { todayLocal, type TrainingDayStore } from '../analytics/training-days.js';
import type { BreakBand } from '../analytics/re-entry.js';
import { UserFacingError } from '../errors.js';
import { readReEntry, type ReEntryResult } from './re-entry-read.js';

export const RE_ENTRY_WINDOW_CODE = 'RE_ENTRY_WINDOW';

/** The bands whose window holds back maximal and overloaded work; `short` only trims the load. */
const GUARDED_BANDS: ReadonlySet<BreakBand> = new Set(['medium', 'long']);

/** The sentence every guarded tool's description carries. */
export const RE_ENTRY_GUARD_DESCRIPTION =
  'RETURN WINDOW (VW-978): refused as RE_ENTRY_WINDOW, before anything reaches the device, while ' +
  'the window after a break of the medium band or longer is open, through the end date ' +
  'plan.next_workout reports in its re-entry read; the refusal names that date. There is no ' +
  'override.';

export type GuardedWork = 'max_test' | 'eccentric_overload';

const WORK_WORDING: Readonly<Record<GuardedWork, string>> = {
  max_test: 'Max-effort tests are',
  eccentric_overload: 'Eccentric overload is',
};

class ReEntryWindowError extends UserFacingError {
  readonly code = RE_ENTRY_WINDOW_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'ReEntryWindowError';
  }
}

/** The last day of an open guarded window, or `null` when none is open today. */
export function guardedWindowEnd(reEntry: ReEntryResult, today: string): string | null {
  if (!('band' in reEntry) || !GUARDED_BANDS.has(reEntry.band)) return null;
  const { windowEndsOn } = reEntry;
  return windowEndsOn !== null && today <= windowEndsOn ? windowEndsOn : null;
}

export function reEntryRefusal(work: GuardedWork, windowEndsOn: string): string {
  return (
    `${WORK_WORDING[work]} held back through ${windowEndsOn}, the end of the return window ` +
    'after a break. Train at the return-window load until then.'
  );
}

/** Throws a `RE_ENTRY_WINDOW` tool error while a guarded window is open. */
export async function assertOutsideReEntryWindow(
  store: TrainingDayStore,
  work: GuardedWork,
): Promise<void> {
  const today = todayLocal();
  const reEntry = await readReEntry(store, today, new Date().toISOString());
  const windowEndsOn = guardedWindowEnd(reEntry, today);
  if (windowEndsOn !== null) throw new ReEntryWindowError(reEntryRefusal(work, windowEndsOn));
}
