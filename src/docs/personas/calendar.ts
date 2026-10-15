// Where a persona's weeks fall, and what each week's load and block slot is.
//
// Every date is a LOCAL wall time in the process time zone, built with
// setDate/setHours so a DST change moves the instant, never the wall time. A
// re-seed under another zone therefore lands the same wall times there.

import { localDate } from '../../analytics/training-days.js';
import type { PersonaLift, PersonaTraining } from './types.js';

/** The local Monday `weeksBack` weeks before the one `now` falls in, at 00:00. */
export function localMonday(now: Date, weeksBack: number): Date {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - weeksBack * 7);
  return monday;
}

/** `dayOffset` days after `monday`, at `hour`:00 local. */
export function localAt(monday: Date, dayOffset: number, hour: number): Date {
  const at = new Date(monday);
  at.setDate(at.getDate() + dayOffset);
  at.setHours(hour, 0, 0, 0);
  return at;
}

/** The local Monday of history week `week` (0 is the oldest). */
export function weekMonday(training: PersonaTraining, now: Date, week: number): Date {
  return localMonday(now, training.weeks - week);
}

/** The local calendar date of `at`, `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  return localDate(at.toISOString());
}

export interface WeekSlot {
  readonly block: number;
  /** 1-based week within the block. */
  readonly weekInBlock: number;
  readonly deload: boolean;
}

/** Which block week history week `week` is, or `undefined` past the last block or off-plan. */
export function weekSlot(training: PersonaTraining, week: number): WeekSlot | undefined {
  let first = 0;
  for (const [block, { weeks, deloadWeek }] of training.blocks.entries()) {
    if (week < first + weeks) {
      const weekInBlock = week - first + 1;
      return { block, weekInBlock, deload: weekInBlock === deloadWeek };
    }
    first += weeks;
  }
  return undefined;
}

const DELOAD_LOAD_SHARE = 0.85;

/** The working load in history week `week`: it climbs every trained week and dips on a deload. */
export function weekLoadLbs(training: PersonaTraining, lift: PersonaLift, week: number): number {
  let climbs = 0;
  for (let earlier = 0; earlier < week; earlier++) {
    if (weekSlot(training, earlier)?.deload !== true) climbs++;
  }
  const load = lift.startLoadLbs * (1 + (lift.weeklyGain ?? training.weeklyGain) * climbs);
  const share = weekSlot(training, week)?.deload === true ? DELOAD_LOAD_SHARE : 1;
  return Math.round(load * share * 2) / 2;
}
