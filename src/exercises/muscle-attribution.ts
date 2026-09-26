// Per-exercise muscle attribution: one weight table, read two ways (VW-561).
//
// LANDMARK READ: a set counts 1 toward each TARGET muscle and nothing else.
// It is B47 (target-only, VMCP-06.05) and the only read any MEV/MAV/MRV band,
// frequency verdict or missed-session rule may use.
//
// DOSE READ: a set adds each row's weight (1, 0.5 or 0) to its muscle, the
// fractional method of Pelland et al. 2025. It is shown in labelled columns and
// is never compared with a landmark.
//
// Rules R1-R19 are in the voltras-workspace design note
// `2026-09-24-vw-561-attribution-amendment.md`.

import { TITAN_MUSCLE_GROUPS, mapCatalogMuscle, type TitanMuscleGroup } from './muscle-map.js';

export const ATTRIBUTION_WEIGHTS = [1, 0.5, 0] as const;
export type AttributionWeight = (typeof ATTRIBUTION_WEIGHTS)[number];

/** One (exercise, muscle) row. `muscle` is a titan slug or a catalog string that fans out. */
export interface AttributionRow<M extends string = string> {
  muscle: M;
  weight: AttributionWeight;
  target: boolean;
}

/** A row resolved onto one titan slug. */
export type SlugAttribution = AttributionRow<TitanMuscleGroup>;

/** Why a row breaks R1 or R2, or `null` when it is valid. */
export function attributionProblem(row: { weight: number; target: boolean }): string | null {
  if (!(ATTRIBUTION_WEIGHTS as readonly number[]).includes(row.weight)) {
    return `weight ${row.weight} is not 1, 0.5 or 0`;
  }
  if (row.target && row.weight !== 1) return `a target row weighs ${row.weight}, not 1`;
  return null;
}

/** A titan slug passes through; a catalog string goes through the shared catalog map. */
export function slugsOf(muscle: string): TitanMuscleGroup[] {
  if ((TITAN_MUSCLE_GROUPS as readonly string[]).includes(muscle)) {
    return [muscle as TitanMuscleGroup];
  }
  return mapCatalogMuscle(muscle);
}

/**
 * Rows onto titan slugs (R18): two rows on one slug make it a target if either
 * is one, at the higher weight. Throws on a row that breaks R1 or R2.
 */
export function resolveAttribution(rows: readonly AttributionRow[]): SlugAttribution[] {
  const bySlug = new Map<TitanMuscleGroup, SlugAttribution>();
  for (const row of rows) {
    const problem = attributionProblem(row);
    if (problem !== null) throw new Error(`attribution row for ${row.muscle}: ${problem}`);
    for (const muscle of slugsOf(row.muscle)) {
      const prior = bySlug.get(muscle);
      bySlug.set(muscle, {
        muscle,
        target: row.target || prior?.target === true,
        weight: Math.max(row.weight, prior?.weight ?? 0) as AttributionWeight,
      });
    }
  }
  return [...bySlug.values()];
}

/** The rows an entry written as primaries and secondaries implies: primary 1.0 target, secondary 0.5. */
export function attributionFromPrimaries(
  primaries: readonly string[],
  secondaries: readonly string[],
): AttributionRow[] {
  return [
    ...primaries.map((muscle) => ({ muscle, weight: 1 as const, target: true })),
    ...secondaries.map((muscle) => ({ muscle, weight: 0.5 as const, target: false })),
  ];
}

/** The landmark read's muscles: target rows only. */
export function targetMuscles(rows: readonly SlugAttribution[]): TitanMuscleGroup[] {
  return rows.filter((row) => row.target).map((row) => row.muscle);
}

/** The dose read's weights: every row above 0. */
export function doseWeights(rows: readonly SlugAttribution[]): Map<TitanMuscleGroup, number> {
  return new Map(rows.filter((row) => row.weight > 0).map((row) => [row.muscle, row.weight]));
}

/**
 * One day's frequency credit per muscle (R14, R15): 1 when any exercise that
 * day targets it, 0.5 when it was only hit through a row above 0.
 */
export function dayFrequencyCredit(
  exercisesTrained: readonly (readonly SlugAttribution[])[],
): Map<TitanMuscleGroup, 1 | 0.5> {
  const credit = new Map<TitanMuscleGroup, 1 | 0.5>();
  for (const rows of exercisesTrained) {
    for (const row of rows) {
      if (row.target) credit.set(row.muscle, 1);
      else if (row.weight > 0 && !credit.has(row.muscle)) credit.set(row.muscle, 0.5);
    }
  }
  return credit;
}
