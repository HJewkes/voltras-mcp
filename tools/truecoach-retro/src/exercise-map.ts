// Exercise-name lookups over the hand-built map: primary muscle as titan groups, main-lift family.

import {
  TITAN_MUSCLE_GROUPS,
  mapCatalogMuscle,
  type TitanMuscleGroup,
} from '../../../src/exercises/muscle-map.js';

import type { ExerciseMapEntry } from './types.js';

export interface ExerciseLookup {
  primaryMuscles(name: string | null): TitanMuscleGroup[];
  family(name: string | null): string | null;
  isMainLift(name: string | null): boolean;
  /** Whether two muscles share a primary/secondary pairing in any mapped exercise. */
  related(a: TitanMuscleGroup, b: TitanMuscleGroup): boolean;
  /** A name with a primary muscle; a map row that names no movement is unmapped. */
  isMapped(name: string | null): boolean;
}

/** A titan slug passes through; a workout-analytics group goes through the shared catalog map. */
export function toTitanMuscles(muscle: string | null): TitanMuscleGroup[] {
  if (muscle === null || muscle === '') return [];
  if ((TITAN_MUSCLE_GROUPS as readonly string[]).includes(muscle))
    return [muscle as TitanMuscleGroup];
  return mapCatalogMuscle(muscle);
}

/** The entry's primary muscles as titan groups, whether the map names one or several. */
export function primaryTitanMuscles(entry: ExerciseMapEntry | undefined): TitanMuscleGroup[] {
  const primary = entry?.primary_muscle ?? null;
  const named = Array.isArray(primary) ? primary : [primary];
  return [...new Set(named.flatMap(toTitanMuscles))];
}

function relatedPairs(entries: readonly ExerciseMapEntry[]): Set<string> {
  const pairs = new Set<string>();
  for (const entry of entries) {
    const primaries = primaryTitanMuscles(entry);
    const secondaries = (entry.secondary_muscles ?? []).flatMap(toTitanMuscles);
    const all = [...primaries, ...secondaries];
    for (const a of primaries) for (const b of all) pairs.add(`${a}|${b}`).add(`${b}|${a}`);
  }
  return pairs;
}

/** Exact-name lookup; an unmapped name has no muscle and no family. */
export function buildExerciseLookup(entries: readonly ExerciseMapEntry[]): ExerciseLookup {
  const byName = new Map(entries.map((entry) => [entry.log_name, entry]));
  const pairs = relatedPairs(entries);
  const entryOf = (name: string | null) => (name === null ? undefined : byName.get(name));
  return {
    primaryMuscles: (name) => primaryTitanMuscles(entryOf(name)),
    family: (name) => entryOf(name)?.family ?? null,
    isMainLift: (name) => entryOf(name)?.main_lift === true,
    related: (a, b) => a === b || pairs.has(`${a}|${b}`),
    isMapped: (name) => primaryTitanMuscles(entryOf(name)).length > 0,
  };
}

/** The map file is an array of entries or an object holding one under `entries`/`exercises`. */
export function parseExerciseMap(json: unknown): ExerciseMapEntry[] {
  if (Array.isArray(json)) return json as ExerciseMapEntry[];
  if (json !== null && typeof json === 'object') {
    const holder = json as { entries?: unknown; exercises?: unknown };
    const inner = holder.entries ?? holder.exercises;
    if (Array.isArray(inner)) return inner as ExerciseMapEntry[];
  }
  throw new Error('exercise map: expected an array of entries or { entries: [...] }');
}
