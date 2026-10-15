// Where a persona's weeks fall, and what each week's load and block slot is.
//
// Every date is a LOCAL wall time in the process time zone, built with
// setDate/setHours so a DST change moves the instant, never the wall time. A
// re-seed under another zone therefore lands the same wall times there.

import { localDate } from '../../analytics/training-days.js';
import type { PersonaLift, PersonaTraining, PersonaWorkout } from './types.js';

/** The local Monday `weeksBack` weeks before the one `now` falls in, at 00:00. */
export function localMonday(now: Date, weeksBack: number): Date {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - weeksBack * 7);
  return monday;
}

/** `dayOffset` days after `monday`, at `hour`:`minute` local. */
export function localAt(monday: Date, dayOffset: number, hour: number, minute = 0): Date {
  const at = new Date(monday);
  at.setDate(at.getDate() + dayOffset);
  at.setHours(hour, minute, 0, 0);
  return at;
}

/** When `workout` starts in history week `week`. */
export function workoutStart(
  training: PersonaTraining,
  workout: PersonaWorkout,
  now: Date,
  week: number,
): Date {
  const hour = workout.startHour ?? training.startHour;
  return localAt(weekMonday(training, now, week), workout.dayOffset, hour, workout.startMinute);
}

/** Whether history week `week` falls inside one of the training's breaks. */
export function isBreakWeek(training: PersonaTraining, week: number): boolean {
  return (training.breaks ?? []).some((b) => week >= b.fromWeek && week < b.fromWeek + b.weeks);
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
/** Each break costs this share of the load the lifter left at. */
const RETURN_LOAD_SHARE = 0.85;
const KG_PER_LB = 0.45359237;

/** Pounds for a whole-kilogram load. */
export function kgInLbs(kg: number): number {
  return kg / KG_PER_LB;
}

/**
 * The working load in history week `week`: it climbs every trained week, dips on a
 * deload, and drops after each break.
 */
export function weekLoadLbs(training: PersonaTraining, lift: PersonaLift, week: number): number {
  let climbs = 0;
  for (let earlier = 0; earlier < week; earlier++) {
    if (!isBreakWeek(training, earlier) && weekSlot(training, earlier)?.deload !== true) climbs++;
  }
  const returns = (training.breaks ?? []).filter((b) => b.fromWeek + b.weeks <= week).length;
  const load =
    lift.startLoadLbs *
    (1 + (lift.weeklyGain ?? training.weeklyGain) * climbs) *
    RETURN_LOAD_SHARE ** returns;
  const share = weekSlot(training, week)?.deload === true ? DELOAD_LOAD_SHARE : 1;
  return roundLoad(training, load * share);
}

/** A load the lifter would dial in: the nearest half pound, or the nearest whole kilogram. */
export function roundLoad(training: PersonaTraining, lbs: number): number {
  if (training.loadUnit === 'kg') return kgInLbs(Math.round(lbs * KG_PER_LB));
  return Math.round(lbs * 2) / 2;
}
