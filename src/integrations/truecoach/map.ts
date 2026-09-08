// Pure mapping from TrueCoach's compound document into the `plan.*` tree.
//
// No I/O, no store, no clock: `mapPlan` takes the raw pages plus a catalog
// lookup and returns the tree the importer will write. That is what makes the
// on-disk response cache useful — the mapping can be re-run offline against a
// recorded document as many times as it takes to get the parser right.
//
// EXTERNAL IDS are the whole idempotency story. Every workout becomes
// `tc:workout:<id>` and every item `tc:item:<id>`, and the importer upserts on
// those keys. A re-import of the same range updates rows in place; it never
// duplicates, and it never depends on titles or positions being stable.
//
// EXACT MATCH ONLY on exercise names. `ExerciseService.search` is
// relevance-ranked and happily returns a plausible-looking wrong answer for an
// unknown name, and a wrong `exerciseId` silently attributes a lift — and its
// baselines — to a movement the coach never prescribed. An unrecognised name
// is reported as unmapped with candidates for the human to resolve via
// `mapping`, and the template still lands without it.

import { normalizeExerciseName } from '../../exercises/normalize-name.js';
import { parseInstruction, type ParsedTargets } from './instruction.js';
import {
  idString,
  pageArray,
  textOrUndefined,
  type RawWorkout,
  type RawWorkoutItem,
  type RawWorkoutsPage,
} from './types.js';

/** How many `exercise.search` suggestions accompany an unmapped name. */
const MAX_CANDIDATES = 3;

/**
 * `planned_exercises.target_sets` is NOT NULL, so an instruction with no
 * readable set count still needs a number. One is the least-wrong choice: the
 * verbatim instruction is in `notes` and remains the source of truth.
 */
export const UNPARSED_TARGET_SETS = 1;

/** The catalog surface `mapPlan` needs — a subset of `ExerciseService`. */
export interface ExerciseLookup {
  search(query: string): readonly { readonly id: string; readonly name: string }[];
}

export interface UnmappedExercise {
  readonly name: string;
  readonly candidates: string[];
}

export interface MappedExercise {
  readonly externalId: string;
  readonly sourceName: string;
  readonly exerciseId: string;
  readonly orderIndex: number;
  readonly targetSets: number;
  readonly targets: ParsedTargets;
  readonly notes: string | undefined;
}

export interface MappedWorkout {
  readonly externalId: string;
  readonly name: string;
  /** The TrueCoach `due` date, verbatim (`YYYY-MM-DD`). */
  readonly dayLabel: string;
  /** ISO week label (`2026-W37`) — one training week per distinct value. */
  readonly isoWeek: string;
  readonly notes: string | undefined;
  readonly exercises: MappedExercise[];
  readonly unmapped: UnmappedExercise[];
}

export interface MappedPlan {
  /** Distinct ISO week labels in chronological order. */
  readonly weeks: string[];
  readonly workouts: MappedWorkout[];
  readonly unmapped: UnmappedExercise[];
}

export interface MapOptions {
  readonly from: string;
  readonly to: string;
  readonly catalog: ExerciseLookup;
  /** Caller-supplied overrides: TrueCoach exercise name -> catalog exercise id. */
  readonly mapping: Readonly<Record<string, string>>;
}

/** Map every workout whose `due` date falls in `[from, to]` into the plan tree. */
export function mapPlan(pages: readonly RawWorkoutsPage[], options: MapOptions): MappedPlan {
  const itemsByWorkout = groupItems(pages);
  const workouts: MappedWorkout[] = [];
  for (const raw of collectWorkouts(pages, options)) {
    const id = idString(raw.id);
    const due = textOrUndefined(raw.due);
    if (id === undefined || due === undefined) continue;
    workouts.push(mapWorkout(raw, id, due, itemsByWorkout.get(id) ?? [], options));
  }
  workouts.sort((a, b) => a.dayLabel.localeCompare(b.dayLabel));
  return {
    weeks: [...new Set(workouts.map((w) => w.isoWeek))].sort(),
    workouts,
    unmapped: dedupeUnmapped(workouts.flatMap((w) => w.unmapped)),
  };
}

/** Raw workouts across every page whose `due` date is inside the range. */
function collectWorkouts(pages: readonly RawWorkoutsPage[], options: MapOptions): RawWorkout[] {
  const all = pages.flatMap((page) => pageArray<RawWorkout>(page, 'workouts'));
  return all.filter((raw) => {
    const due = textOrUndefined(raw.due)?.slice(0, 10);
    return due !== undefined && due >= options.from && due <= options.to;
  });
}

/**
 * Index every page's `workout_items` by `workout_id` and sort each group by
 * `position`. Position, not array order: a superset (E1/E2) is written as two
 * items whose array order in the compound document does not track the order
 * the coach laid them out.
 */
function groupItems(pages: readonly RawWorkoutsPage[]): Map<string, RawWorkoutItem[]> {
  const grouped = new Map<string, RawWorkoutItem[]>();
  for (const page of pages) {
    for (const item of pageArray<RawWorkoutItem>(page, 'workout_items')) {
      const parent = idString(item.workout_id);
      if (parent === undefined) continue;
      const bucket = grouped.get(parent);
      if (bucket === undefined) grouped.set(parent, [item]);
      else bucket.push(item);
    }
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  return grouped;
}

function mapWorkout(
  raw: RawWorkout,
  id: string,
  due: string,
  items: readonly RawWorkoutItem[],
  options: MapOptions,
): MappedWorkout {
  const exercises: MappedExercise[] = [];
  const unmapped: UnmappedExercise[] = [];
  for (const item of items) {
    const mapped = mapItem(item, exercises.length, options);
    if (mapped === undefined) continue;
    if ('candidates' in mapped) unmapped.push(mapped);
    else exercises.push(mapped);
  }
  const dayLabel = due.slice(0, 10);
  return {
    externalId: `tc:workout:${id}`,
    name: textOrUndefined(raw.title) ?? `TrueCoach workout ${dayLabel}`,
    dayLabel,
    isoWeek: isoWeekLabel(dayLabel),
    notes: workoutNotes(raw),
    exercises,
    unmapped,
  };
}

/**
 * The coach's workout-level text, verbatim. `warmup` and `cooldown` are the
 * only workout-level freeform fields the document carries; they are joined
 * with their own labels rather than merged, so nothing the coach wrote is
 * reworded or dropped.
 */
function workoutNotes(raw: RawWorkout): string | undefined {
  const parts: string[] = [];
  const warmup = textOrUndefined(raw.warmup);
  const cooldown = textOrUndefined(raw.cooldown);
  if (warmup !== undefined) parts.push(`Warmup: ${warmup}`);
  if (cooldown !== undefined) parts.push(`Cooldown: ${cooldown}`);
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function mapItem(
  item: RawWorkoutItem,
  orderIndex: number,
  options: MapOptions,
): MappedExercise | UnmappedExercise | undefined {
  const id = idString(item.id);
  const name = textOrUndefined(item.name);
  if (id === undefined || name === undefined) return undefined;
  const exerciseId = options.mapping[name] ?? resolveExactExercise(options.catalog, name);
  if (exerciseId === undefined) {
    return { name, candidates: candidateNames(options.catalog, name) };
  }
  const info = textOrUndefined(item.info);
  const targets = parseInstruction(info);
  return {
    externalId: `tc:item:${id}`,
    sourceName: name,
    exerciseId,
    orderIndex,
    targetSets: targets.targetSets ?? UNPARSED_TARGET_SETS,
    targets,
    notes: info,
  };
}

/**
 * A catalog id only when exactly one entry's name normalises to the same key.
 * Zero matches, or two entries that collapse to one key, both read as "no
 * match" — the ranked first hit is never accepted.
 */
function resolveExactExercise(catalog: ExerciseLookup, name: string): string | undefined {
  const target = normalizeExerciseName(name);
  const matches = catalog.search(name).filter((e) => normalizeExerciseName(e.name) === target);
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function candidateNames(catalog: ExerciseLookup, name: string): string[] {
  return catalog
    .search(name)
    .slice(0, MAX_CANDIDATES)
    .map((e) => e.name);
}

function dedupeUnmapped(all: readonly UnmappedExercise[]): UnmappedExercise[] {
  const seen = new Map<string, UnmappedExercise>();
  for (const entry of all) {
    if (!seen.has(entry.name)) seen.set(entry.name, entry);
  }
  return [...seen.values()];
}

/**
 * ISO-8601 week label (`2026-W37`) for a `YYYY-MM-DD` date.
 *
 * Computed in UTC from the date parts only. A local-time `Date` would shift
 * the day across a timezone boundary and put a Monday workout in the previous
 * week for anyone west of UTC.
 */
export function isoWeekLabel(date: string): string {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  const utc = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  // Shift to the Thursday of this week: ISO weeks are numbered by the year
  // their Thursday falls in, which is what makes year boundaries work.
  const dayOfWeek = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - dayOfWeek + 3);
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
