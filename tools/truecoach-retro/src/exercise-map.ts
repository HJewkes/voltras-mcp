// Exercise-name lookups over the hand-built map: attribution rows as titan groups, main-lift family.

import {
  attributionFromPrimaries,
  doseWeights,
  resolveAttribution,
  targetMuscles,
  type AttributionRow,
  type SlugAttribution,
} from '../../../src/exercises/muscle-attribution.js';
import type { TitanMuscleGroup } from '../../../src/exercises/muscle-map.js';

import type { ExerciseMapEntry } from './types.js';

export interface ExerciseLookup {
  /** The landmark read's muscles (B47): target rows only. */
  targets(name: string | null): TitanMuscleGroup[];
  /** The dose read's weights: every row above 0. */
  doseWeights(name: string | null): Map<TitanMuscleGroup, number>;
  /** The entry's resolved rows, for a per-day frequency credit. */
  attribution(name: string | null): SlugAttribution[];
  /** A map entry marked as a warm-up: its rows count toward neither read (R8b). */
  isWarmup(name: string | null): boolean;
  family(name: string | null): string | null;
  isMainLift(name: string | null): boolean;
  /** Whether two muscles share a target/weighted pairing in any mapped exercise (R19). */
  related(a: TitanMuscleGroup, b: TitanMuscleGroup): boolean;
  /** A name with a target muscle; a map row that names no movement is unmapped. */
  isMapped(name: string | null): boolean;
}

function listOf(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((muscle) => muscle !== '');
}

/** The entry's rows: `muscles` when present, else derived from the pre-VW-561 primary/secondary fields. */
export function entryRows(entry: ExerciseMapEntry): AttributionRow[] {
  if (entry.muscles !== undefined) return entry.muscles;
  return attributionFromPrimaries(listOf(entry.primary_muscle), listOf(entry.secondary_muscles));
}

/** The entry's rows on titan slugs; a row that breaks R1 or R2 names the entry in the error. */
export function resolvedRows(entry: ExerciseMapEntry | undefined): SlugAttribution[] {
  if (entry === undefined) return [];
  try {
    return resolveAttribution(entryRows(entry));
  } catch (error) {
    throw new Error(`exercise map entry "${entry.log_name}": ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function relatedPairs(resolved: readonly SlugAttribution[][]): Set<string> {
  const pairs = new Set<string>();
  for (const rows of resolved) {
    const weighted = rows.filter((row) => row.weight > 0).map((row) => row.muscle);
    for (const a of targetMuscles(rows)) {
      for (const b of weighted) pairs.add(`${a}|${b}`).add(`${b}|${a}`);
    }
  }
  return pairs;
}

/** Exact-name lookup; an unmapped name has no muscle and no family. */
export function buildExerciseLookup(entries: readonly ExerciseMapEntry[]): ExerciseLookup {
  const byName = new Map(entries.map((entry) => [entry.log_name, entry]));
  const rowsByName = new Map(entries.map((entry) => [entry.log_name, resolvedRows(entry)]));
  const pairs = relatedPairs([...rowsByName.values()]);
  const entryOf = (name: string | null) => (name === null ? undefined : byName.get(name));
  const rowsOf = (name: string | null) => (name === null ? [] : (rowsByName.get(name) ?? []));
  return {
    targets: (name) => targetMuscles(rowsOf(name)),
    doseWeights: (name) => doseWeights(rowsOf(name)),
    attribution: rowsOf,
    isWarmup: (name) => entryOf(name)?.warmup === true,
    family: (name) => entryOf(name)?.family ?? null,
    isMainLift: (name) => entryOf(name)?.main_lift === true,
    related: (a, b) => a === b || pairs.has(`${a}|${b}`),
    isMapped: (name) => targetMuscles(rowsOf(name)).length > 0,
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
