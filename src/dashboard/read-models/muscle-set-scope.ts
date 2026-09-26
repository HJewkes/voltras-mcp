// Shared scoping rules for the body-map plan's per-muscle read models (VW-323).
//
// Two questions every `muscle-*.ts` read model has to answer identically, or
// the body-map figure contradicts itself between panels:
//
//   1. Which calendar week is "this week"? (`startOfCalendarWeekIso`)
//   2. Which recorded sets count, and toward which muscle? (`isEligibleWorkingSet`,
//      `titanMusclesFor`)
//
// This module is the single answer, extracted verbatim from `muscle-plan.ts`
// (VW-331), which defined these first and now imports them. `muscle-week.ts`
// (VW-329) is the second caller; B3 and B5 of the body-map plan are the next
// two. The semantics must not diverge, so there is exactly one copy.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  doseWeights,
  targetMuscles,
  type SlugAttribution,
} from '../../exercises/muscle-attribution.js';
import type { TitanMuscleGroup } from '../../exercises/muscle-map.js';
import { attributionOfExercise } from '../../exercises/seed-attribution.js';
import { setPurposeOf } from '../../store/set-purpose.js';
import type { StoredSet } from '../../store/types.js';

/** Narrow catalog lookup the per-muscle read models need: muscle groups and name, nothing else. */
export type MuscleCatalogLookup = (
  exerciseId: string,
) =>
  | { name?: string; muscleGroups: readonly string[]; secondaryMuscleGroups?: readonly string[] }
  | undefined;

/** Monday 00:00:00.000 UTC of the ISO week containing `now`. */
export function startOfCalendarWeekIso(now: Date): string {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDay = midnight.getUTCDay() === 0 ? 7 : midnight.getUTCDay(); // 1=Mon..7=Sun
  midnight.setUTCDate(midnight.getUTCDate() - (isoDay - 1));
  return midnight.toISOString();
}

/** `weekStartIso` plus 7 days — the exclusive upper bound of the calendar week. */
export function endOfCalendarWeekIso(weekStartIso: string): string {
  const end = new Date(weekStartIso);
  end.setUTCDate(end.getUTCDate() + 7);
  return end.toISOString();
}

/**
 * A set counts toward a per-muscle weekly rollup under the same target-only
 * rule `session.volume`'s `setsByTargetMuscle` uses (B47, VMCP-06.05): working
 * sets only, the owner's own sets only (VW-169), never a mock-adapter set, and
 * eligible by the same rule `weeklyVolumeRepCount` uses (`metrics-tools.ts`) —
 * the device's own rep count, falling back to the derived array, must be > 0.
 *
 * `fromIso` / `toIsoExcl` bound `startedAt`; pass the calendar week for a
 * weekly count, or a wider trailing window for a "last trained" scan.
 */
export function isEligibleWorkingSet(set: StoredSet, fromIso: string, toIsoExcl: string): boolean {
  if (set.lifter !== undefined) return false;
  if (set.source === 'mock') return false;
  if (setPurposeOf(set) !== 'working') return false;
  if ((set.firmwareRepCount ?? set.reps.length) <= 0) return false;
  return set.startedAt >= fromIso && set.startedAt < toIsoExcl;
}

/**
 * One exercise's attribution rows on titan slugs (VW-561): the seed table's
 * rows, or the catalog entry's primary and secondaries for an id the table
 * does not hold. Empty when the catalog does not know it.
 */
export function attributionFor(
  exerciseId: string,
  catalog: MuscleCatalogLookup,
): SlugAttribution[] {
  const entry = catalog(exerciseId);
  return entry === undefined ? [] : attributionOfExercise({ ...entry, id: exerciseId });
}

/**
 * The titan slugs a set of this exercise counts toward in the LANDMARK read:
 * target rows only (B47). Secondaries never count here, at any weight; they
 * reach only {@link doseWeightsFor}. Empty when the exercise is unknown.
 */
export function titanMusclesFor(
  exerciseId: string,
  catalog: MuscleCatalogLookup,
): TitanMuscleGroup[] {
  return targetMuscles(attributionFor(exerciseId, catalog));
}

/** The DOSE read's per-muscle weights for one exercise: never compared with a landmark. */
export function doseWeightsFor(
  exerciseId: string,
  catalog: MuscleCatalogLookup,
): Map<TitanMuscleGroup, number> {
  return doseWeights(attributionFor(exerciseId, catalog));
}
