// Pure read-model for the body-map plan's "weekly load per muscle vs plan"
// affordance (VW-331, B4 of the body-map plan). `buildMusclePlanView` shapes the
// active training week's plan plus this calendar week's completed sets into one
// row per titan muscle group: planned sets this week, done sets this week, and
// the still-untrained planned exercises. It performs NO I/O: the caller
// (`dashboard/server.ts`'s `fetchMusclePlan`) owns the store reads and the
// active-week walk, this module owns the output shape and the muscle-group
// aggregation — the same split `read-models/plan-tree.ts` and
// `read-models/session-plan.ts` use.
//
// TARGET-ONLY (B47, VMCP-06.05): a planned or completed set counts toward its
// exercise's PRIMARY catalog muscle group ONLY, mapped to titan slug(s) through
// `mapCatalogMuscle` (VW-328) — secondary muscle groups never contribute, at any
// weight. A coarse catalog group (e.g. `shoulders`) maps to more than one titan
// slug, and a set against it counts in full toward each — there is no way to
// split it further from the data recorded.
//
// Confidentiality: plan metadata and fitness units only — no protocol data (NF-07).

import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  mapCatalogMuscle,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import { setPurposeOf } from '../../store/set-purpose.js';
import type { StoredPlannedExercise, StoredSet, StoredTrainingWeek } from '../../store/types.js';

/** Narrow catalog lookup this module needs — primary muscle group + name, nothing else. */
export type MuscleCatalogLookup = (
  exerciseId: string,
) => { name?: string; muscleGroups: readonly string[] } | undefined;

/** One workout template in the active week, flagged with whether it's already been trained. */
export interface MusclePlanTemplateRow {
  id: string;
  name: string;
  completed: boolean;
}

/** One planned-but-not-yet-trained exercise, for a muscle's `plannedRemaining` list. */
export interface MusclePlanRemainingExercise {
  workoutName: string;
  exerciseId: string;
  exerciseName: string;
  sets: number;
}

/** One titan muscle group's weekly plan-vs-done state. */
export interface MusclePlanMuscleView {
  muscle: TitanMuscleGroup;
  plannedSetsThisWeek: number;
  doneSetsThisWeek: number;
  plannedRemaining: MusclePlanRemainingExercise[];
}

export interface MusclePlanView {
  /** Monday 00:00:00 UTC of the calendar week `now` falls in — the boundary `doneSetsThisWeek` is scoped to. */
  weekStart: string;
  /** Mesocycle week index of the active training week, when the coach set one (VW-326). */
  weekIndex?: number;
  isDeload: boolean;
  muscleMapVersion: string;
  /** Every titan slug (VW-328), zeros included, so the figure can paint every muscle. */
  muscles: MusclePlanMuscleView[];
}

/** Everything `buildMusclePlanView` needs, already read out of the store. */
export interface MusclePlanRows {
  /** The active training week — the first week (in block/week order) still carrying an untrained template. */
  week: StoredTrainingWeek;
  /** Every workout template in that week, ordered, each flagged with training status. */
  templates: readonly MusclePlanTemplateRow[];
  /** Every planned exercise across those templates. */
  plannedExercises: readonly StoredPlannedExercise[];
  /**
   * Candidate completed sets to scope `doneSetsThisWeek` from. The caller may
   * over-fetch (e.g. every set from a session query spanning the calendar
   * week); this function applies the actual date/purpose/ownership/source
   * filter, so the caller never has to duplicate that rule.
   */
  completedSets: readonly StoredSet[];
  catalog: MuscleCatalogLookup;
  now: Date;
}

/** Monday 00:00:00.000 UTC of the ISO week containing `now`. */
export function startOfCalendarWeekIso(now: Date): string {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDay = midnight.getUTCDay() === 0 ? 7 : midnight.getUTCDay(); // 1=Mon..7=Sun
  midnight.setUTCDate(midnight.getUTCDate() - (isoDay - 1));
  return midnight.toISOString();
}

/** `weekStartIso` plus 7 days — the exclusive upper bound of the calendar week. */
function weekEndIso(weekStartIso: string): string {
  const end = new Date(weekStartIso);
  end.setUTCDate(end.getUTCDate() + 7);
  return end.toISOString();
}

/**
 * A set counts toward `doneSetsThisWeek` under the same target-only rule
 * `session.volume`'s `setsByTargetMuscle` uses (B47, VMCP-06.05): working sets
 * only, the owner's own sets only (VW-169), never a mock-adapter set, and
 * eligible by the same rule `weeklyVolumeRepCount` uses (`metrics-tools.ts`) —
 * the device's own rep count, falling back to the derived array, must be > 0.
 */
function isEligibleDoneSet(set: StoredSet, weekStartIso: string, weekEndIsoExcl: string): boolean {
  if (set.lifter !== undefined) return false;
  if (set.source === 'mock') return false;
  if (setPurposeOf(set) !== 'working') return false;
  if ((set.firmwareRepCount ?? set.reps.length) <= 0) return false;
  return set.startedAt >= weekStartIso && set.startedAt < weekEndIsoExcl;
}

/** The titan slugs one exercise's PRIMARY catalog muscle group maps to. Empty when the exercise or its group is unknown. */
function titanMusclesFor(exerciseId: string, catalog: MuscleCatalogLookup): TitanMuscleGroup[] {
  const primary = catalog(exerciseId)?.muscleGroups[0];
  if (primary === undefined) return [];
  return mapCatalogMuscle(primary);
}

/** Planned sets this week per muscle, and the still-untrained planned exercises per muscle. */
function accumulatePlanned(
  plannedExercises: readonly StoredPlannedExercise[],
  templateById: ReadonlyMap<string, MusclePlanTemplateRow>,
  catalog: MuscleCatalogLookup,
): {
  plannedSets: Map<TitanMuscleGroup, number>;
  plannedRemaining: Map<TitanMuscleGroup, MusclePlanRemainingExercise[]>;
} {
  const plannedSets = new Map<TitanMuscleGroup, number>();
  const plannedRemaining = new Map<TitanMuscleGroup, MusclePlanRemainingExercise[]>();
  for (const exercise of plannedExercises) {
    const template = templateById.get(exercise.workoutTemplateId);
    if (template === undefined) continue;
    for (const muscle of titanMusclesFor(exercise.exerciseId, catalog)) {
      plannedSets.set(muscle, (plannedSets.get(muscle) ?? 0) + exercise.targetSets);
      if (template.completed) continue;
      const entry: MusclePlanRemainingExercise = {
        workoutName: template.name,
        exerciseId: exercise.exerciseId,
        exerciseName: catalog(exercise.exerciseId)?.name ?? exercise.exerciseId,
        sets: exercise.targetSets,
      };
      const list = plannedRemaining.get(muscle);
      if (list) list.push(entry);
      else plannedRemaining.set(muscle, [entry]);
    }
  }
  return { plannedSets, plannedRemaining };
}

/** Done sets this week per muscle, from the eligible subset of `completedSets`. */
function accumulateDone(
  completedSets: readonly StoredSet[],
  weekStart: string,
  weekEnd: string,
  catalog: MuscleCatalogLookup,
): Map<TitanMuscleGroup, number> {
  const doneSets = new Map<TitanMuscleGroup, number>();
  for (const set of completedSets) {
    if (set.exerciseId === undefined || !isEligibleDoneSet(set, weekStart, weekEnd)) continue;
    for (const muscle of titanMusclesFor(set.exerciseId, catalog)) {
      doneSets.set(muscle, (doneSets.get(muscle) ?? 0) + 1);
    }
  }
  return doneSets;
}

/**
 * Shape the active training week's plan plus this calendar week's completed
 * sets into one row per titan muscle group (VW-331, B4): planned sets this
 * week, done sets this week, and the still-untrained planned exercises.
 */
export function buildMusclePlanView(rows: MusclePlanRows): MusclePlanView {
  const weekStart = startOfCalendarWeekIso(rows.now);
  const weekEnd = weekEndIso(weekStart);
  const templateById = new Map(rows.templates.map((t) => [t.id, t]));

  const { plannedSets, plannedRemaining } = accumulatePlanned(
    rows.plannedExercises,
    templateById,
    rows.catalog,
  );
  const doneSets = accumulateDone(rows.completedSets, weekStart, weekEnd, rows.catalog);

  const muscles: MusclePlanMuscleView[] = TITAN_MUSCLE_GROUPS.map((muscle) => ({
    muscle,
    plannedSetsThisWeek: plannedSets.get(muscle) ?? 0,
    doneSetsThisWeek: doneSets.get(muscle) ?? 0,
    plannedRemaining: plannedRemaining.get(muscle) ?? [],
  }));

  return {
    weekStart,
    ...(rows.week.weekIndex !== undefined ? { weekIndex: rows.week.weekIndex } : {}),
    isDeload: rows.week.isDeload,
    muscleMapVersion: MUSCLE_MAP_VERSION,
    muscles,
  };
}
