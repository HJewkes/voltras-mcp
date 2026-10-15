// Weekly rollups: the landmark and dose reads per muscle, sessions per week, frequency.

import type { TitanMuscleGroup } from '../../../src/exercises/muscle-map.js';
import {
  LANDMARK_VERDICT_WITHHELD,
  POPULATION_VOLUME_LANDMARKS,
  classifyWeeklyVolume,
  type VolumeStatus,
} from '../../../src/dashboard/read-models/muscle-week.js';
import { dayFrequencyCredit } from '../../../src/exercises/muscle-attribution.js';

import { isoWeekStart, weeksSpanning } from './dates.js';
import type { ExerciseLookup } from './exercise-map.js';
import { isWorkRow } from './log-rules.js';
import type { SetRecord } from './types.js';

type WeekMuscleMap<T> = Map<string, Map<TitanMuscleGroup, T>>;
type WorkRow = SetRecord & { workout_due_date: string };

/** A work row of an entry that counts toward either read: warm-up entries never do (R8b). */
function countedRows(rows: readonly SetRecord[], lookup: ExerciseLookup): WorkRow[] {
  return rows.filter(
    (row): row is WorkRow => isWorkRow(row) && !lookup.isWarmup(row.exercise_name),
  );
}

/** Every week with a work row, so a week of warm-up entries only is still a week with training. */
function emptyWeeks<T>(rows: readonly SetRecord[]): WeekMuscleMap<T> {
  const weeks: WeekMuscleMap<T> = new Map();
  for (const row of rows.filter(isWorkRow))
    weeks.set(isoWeekStart(row.workout_due_date), new Map());
  return weeks;
}

function weeklySums(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
  weightsOf: (name: string | null) => Map<TitanMuscleGroup, number>,
): WeekMuscleMap<number> {
  const weeks = emptyWeeks<number>(rows);
  for (const row of countedRows(rows, lookup)) {
    const muscles = weeks.get(isoWeekStart(row.workout_due_date))!;
    for (const [muscle, weight] of weightsOf(row.exercise_name)) {
      muscles.set(muscle, (muscles.get(muscle) ?? 0) + weight * row.sets);
    }
  }
  return weeks;
}

/** Landmark read (B47): a set counts in full toward each target muscle and nothing else. */
export function weeklySetsByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  const targetsOf = (name: string | null) => new Map(lookup.targets(name).map((m) => [m, 1]));
  return weeklySums(rows, lookup, targetsOf);
}

/** Dose read (Pelland fractional): a set adds each row's weight. Never compared with a landmark. */
export function weeklyDoseByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  return weeklySums(rows, lookup, (name) => lookup.doseWeights(name));
}

/** Each day's credit per muscle: 1 for a target, 0.5 for a muscle only hit through a weighted row. */
function weeklyDayCredits(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<Map<string, 1 | 0.5>> {
  const weeks = emptyWeeks<Map<string, 1 | 0.5>>(rows);
  const byDay = new Map<string, Set<string | null>>();
  for (const row of countedRows(rows, lookup)) {
    if (row.sets <= 0) continue;
    const names = byDay.get(row.workout_due_date) ?? new Set();
    byDay.set(row.workout_due_date, names.add(row.exercise_name));
  }
  for (const [day, names] of byDay) {
    const week = isoWeekStart(day);
    const muscles = weeks.get(week)!;
    const credit = dayFrequencyCredit([...names].map((name) => lookup.attribution(name)));
    for (const [muscle, value] of credit) {
      muscles.set(muscle, (muscles.get(muscle) ?? new Map()).set(day, value));
    }
  }
  return weeks;
}

function sumCredits(
  weeks: WeekMuscleMap<Map<string, 1 | 0.5>>,
  keep: (value: 1 | 0.5) => boolean,
): WeekMuscleMap<number> {
  return new Map(
    [...weeks].map(([week, muscles]) => [
      week,
      new Map(
        [...muscles]
          .map(([m, days]): [TitanMuscleGroup, number] => [
            m,
            [...days.values()].filter(keep).reduce<number>((a, b) => a + b, 0),
          ])
          .filter(([, n]) => n > 0),
      ),
    ]),
  );
}

/** Landmark frequency (R14): days holding a working set of an exercise that targets the muscle. */
export function weeklyFrequencyByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  return sumCredits(weeklyDayCredits(rows, lookup), (value) => value === 1);
}

/** Dose frequency (R15): a target day counts 1, a day that only hit the muscle through a weighted row 0.5. */
export function weeklyDoseFrequencyByMuscle(
  rows: readonly SetRecord[],
  lookup: ExerciseLookup,
): WeekMuscleMap<number> {
  return sumCredits(weeklyDayCredits(rows, lookup), () => true);
}

/** A muscle's landmark band, or `null` where the landmark is unverified (R8c). */
export function volumeStatus(muscle: TitanMuscleGroup, sets: number): VolumeStatus | null {
  if (LANDMARK_VERDICT_WITHHELD.has(muscle)) return null;
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
