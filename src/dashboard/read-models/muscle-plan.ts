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
// The week boundary, set eligibility and primary-group attribution live in
// `muscle-set-scope.ts` (VW-329), shared with every other per-muscle read model
// so the body-map figure cannot contradict itself between panels.
//
// Confidentiality: plan metadata and fitness units only — no protocol data (NF-07).

import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import type { StoredPlannedExercise, StoredSet, StoredTrainingWeek } from '../../store/types.js';
import {
  endOfCalendarWeekIso,
  isEligibleWorkingSet,
  startOfCalendarWeekIso,
  titanMusclesFor,
  type MuscleCatalogLookup,
} from './muscle-set-scope.js';

export { startOfCalendarWeekIso, type MuscleCatalogLookup };

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
    if (set.exerciseId === undefined || !isEligibleWorkingSet(set, weekStart, weekEnd)) continue;
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
  const weekEnd = endOfCalendarWeekIso(weekStart);
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
