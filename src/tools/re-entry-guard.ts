// The return-window guard (VW-978): no max tests and no eccentric overload in the first weeks back
// after a break of the medium band or wider.
//
// It follows the mount-load gate's shape (VW-274): the handler calls it before any device write or
// lease, so a refusal leaves the device untouched. It applies the same re-entry rule as
// `plan.next_workout`, so the coach and the guard never disagree about whether a window is open.
// The rule reads the working lifter's own training days (VW-985): the owner's, or a guest's.
// There is no override flag (owner decision OD7): the window ends on its own date.
//
// The refusal names the window's last day, never a day count: the return path never tells the
// lifter how long they were away.

import { selectReEntry, type BreakBand } from '../analytics/re-entry.js';
import {
  readTrainingDaysMatching,
  todayLocal,
  type TrainingDayStore,
} from '../analytics/training-days.js';
import { UserFacingError } from '../errors.js';
import type { LiveState } from '../state/live-state.js';
import { briefReEntry, type ReEntryResult } from './re-entry-read.js';

export const RE_ENTRY_WINDOW_CODE = 'RE_ENTRY_WINDOW';

/** The bands whose window holds back maximal and overloaded work; `short` only trims the load. */
const GUARDED_BANDS: ReadonlySet<BreakBand> = new Set(['medium', 'long']);

/** The sentence every guarded tool's description carries. */
export const RE_ENTRY_GUARD_DESCRIPTION =
  'RETURN WINDOW (VW-978): refused as RE_ENTRY_WINDOW, naming the end date, while the window ' +
  'after a medium or longer break is open. No override.';

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

/**
 * Who a device write lands on: an open set keeps the label it started with, otherwise the
 * session's. `undefined` is the owner.
 */
export function cableLifter(live: Pick<LiveState, 'session' | 'set'>): string | undefined {
  return live.set !== undefined ? live.set.lifter : live.session?.lifter;
}

/**
 * Throws a `RE_ENTRY_WINDOW` tool error while a guarded window is open for `lifter`; `undefined`
 * is the owner.
 */
export async function assertOutsideReEntryWindow(
  store: TrainingDayStore,
  work: GuardedWork,
  lifter: string | undefined,
): Promise<void> {
  const today = todayLocal();
  const trainingDays = await readTrainingDaysMatching(store, {
    to: new Date().toISOString(),
    ...(lifter !== undefined ? { lifter } : {}),
  });
  const reEntry = briefReEntry(selectReEntry({ trainingDays, today }));
  const windowEndsOn = guardedWindowEnd(reEntry, today);
  if (windowEndsOn !== null) throw new ReEntryWindowError(reEntryRefusal(work, windowEndsOn));
}
