// Weekly rollups: work sets per primary muscle against the landmarks, sessions per week, frequency.

import type { TitanMuscleGroup } from '../../../src/exercises/muscle-map.js';
import {
  POPULATION_VOLUME_LANDMARKS,
  classifyWeeklyVolume,
  type VolumeStatus,
} from '../../../src/dashboard/read-models/muscle-week.js';

import { isoWeekStart, weeksSpanning } from './dates.js';
import type { ExerciseLookup } from './exercise-map.js';
import { isWorkRow } from './log-rules.js';
import type { SetRecord } from './types.js';

type WeekMuscleMap<T> = Map<string, Map<TitanMuscleGroup, T>>;

/** Target-only counting (B47): a set counts in full toward each of its primary muscle's groups. */
export function weeklySetsByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  const weeks: WeekMuscleMap<number> = new Map();
  for (const row of rows) {
    if (!isWorkRow(row)) continue;
    const week = isoWeekStart(row.workout_due_date);
    const muscles = weeks.get(week) ?? new Map<TitanMuscleGroup, number>();
    for (const muscle of lookup.primaryMuscles(row.exercise_name)) {
      muscles.set(muscle, (muscles.get(muscle) ?? 0) + row.sets);
    }
    weeks.set(week, muscles);
  }
  return weeks;
}

/** Distinct training days per week that trained each primary muscle. */
export function weeklyFrequencyByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  const days: WeekMuscleMap<Set<string>> = new Map();
  for (const row of rows) {
    if (!isWorkRow(row)) continue;
    const week = isoWeekStart(row.workout_due_date);
    const muscles = days.get(week) ?? new Map<TitanMuscleGroup, Set<string>>();
    for (const muscle of lookup.primaryMuscles(row.exercise_name)) {
      muscles.set(muscle, (muscles.get(muscle) ?? new Set()).add(row.workout_due_date));
    }
    days.set(week, muscles);
  }
  return new Map(
    [...days].map(([week, muscles]) => [week, new Map([...muscles].map(([m, d]) => [m, d.size]))]),
  );
}

export function volumeStatus(muscle: TitanMuscleGroup, sets: number): VolumeStatus {
  return classifyWeeklyVolume(sets, POPULATION_VOLUME_LANDMARKS[muscle]);
}

/** Training days per ISO week from the first to the last day, zero weeks included. */
export function sessionsPerWeek(days: readonly string[]): Map<string, number> {
  if (days.length === 0) return new Map();
  const counts = new Map(weeksSpanning(days[0]!, days.at(-1)!).map((week) => [week, 0]));
  for (const day of days) counts.set(isoWeekStart(day), (counts.get(isoWeekStart(day)) ?? 0) + 1);
  return counts;
}

/** The most common non-zero weekly count; ties go to the higher count, the lifter's fuller week. */
export function modalWeeklyCount(counts: Iterable<number>): number | null {
  const frequency = new Map<number, number>();
  for (const count of counts) if (count > 0) frequency.set(count, (frequency.get(count) ?? 0) + 1);
  let best: number | null = null;
  for (const [count, seen] of frequency) {
    const bestSeen = best === null ? -1 : frequency.get(best)!;
    if (seen > bestSeen || (seen === bestSeen && count > best!)) best = count;
  }
  return best;
}
