// Pure read-model for the dashboard's active-exercise prescription
// (VW-41/43/46/49).
//
// `buildSessionPlanView` shapes an already-matched planned-exercise row (plus
// its template's full ordered exercise list and a pre-resolved session title)
// into the `PrescriptionView` the live page renders. It performs NO I/O: the
// caller (`server.ts`'s `fetchSessionPlan`) owns the store reads and the
// assignment/template walk, this module owns the output shape — the same
// split `read-models/plan-tree.ts` uses.
//
// Confidentiality: plan metadata and fitness units only — no protocol data (NF-07).

import { resolveTargetTempo } from '../tempo-defaults.js';
import type { StoredPlannedExercise } from '../../store/types.js';

/** Narrow catalog lookup this module needs — name + movement pattern, nothing else. */
export type ExerciseCatalogLookup = {
  getById(id: string): { name?: string; movementPattern?: string } | undefined;
};

/**
 * One entry in the session's ordered planned-exercise list (VW-49). Mirrors the
 * client's `PlannedExerciseView` in `spa/adapter.ts` — the two must stay identical.
 */
export interface PlannedExerciseView {
  /** Display name, or the exercise id when the catalog carries no name. Never invented. */
  name: string;
  /** 0-based position within the workout template. */
  order: number;
  /** Prescribed set count. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  /** True for the exercise the live session is currently on. */
  active: boolean;
}

/** Prescribed targets for the active exercise, from its attached plan template. */
export interface PrescriptionView {
  /** Prescribed set count. Always present — `targetSets` is required on a planned exercise. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  rpe?: number;
  /** Prescribed rest between sets, seconds. Absent when the coach left it unset. */
  restSec?: number;
  /**
   * Target tempo tuple `[eccentric, pauseBottom, concentric, pauseTop]` (seconds),
   * resolved from the coach override (VW-46) or the exercise default. Absent when
   * neither resolves — the live view then hides the tempo readout (VW-41).
   */
  tempo?: [number, number, number, number];
  /**
   * The session's FULL ordered planned-exercise list (VW-49) from the matched
   * template, so the rail can render `upcoming` rows beyond the active exercise.
   * Present whenever the prescription is; only real planned exercises, never invented.
   */
  exercises?: PlannedExerciseView[];
  /**
   * The session-block title (VW-43), composed from the attached template's name and
   * its block's focus/name, e.g. `"Push A · Hypertrophy"`. Absent when the store can't
   * resolve the full template → week → block chain (each hop optional, never invented).
   */
  title?: string;
}

/** Everything `buildSessionPlanView` needs, already resolved out of the store. */
export interface SessionPlanRows {
  /** The live session's active exercise — what `match` was matched against. */
  activeExerciseId: string;
  /** The planned-exercise row prescribing `activeExerciseId`. */
  match: StoredPlannedExercise;
  /** Every planned exercise in the matched template, unsorted. */
  planned: readonly StoredPlannedExercise[];
  /** Composed via `composeSessionTitle` from the resolved template → week → block chain. */
  title: string | null;
}

/**
 * Shape a matched planned-exercise row into the live page's prescription: target
 * sets/reps/load/RPE/rest, the resolved target tempo (coach override, then exercise
 * default, then none), the full ordered planned-exercise rail, and the session title.
 */
export function buildSessionPlanView(
  rows: SessionPlanRows,
  catalog: ExerciseCatalogLookup | undefined,
): PrescriptionView {
  const { match, planned, activeExerciseId, title } = rows;
  const prescription: PrescriptionView = { sets: match.targetSets };
  if (match.targetRepsLow !== undefined) prescription.repsLow = match.targetRepsLow;
  if (match.targetRepsHigh !== undefined) prescription.repsHigh = match.targetRepsHigh;
  if (match.targetWeightLbs !== undefined) prescription.weightLbs = match.targetWeightLbs;
  if (match.targetRpe !== undefined) prescription.rpe = match.targetRpe;
  if (match.restSec !== undefined) prescription.restSec = match.restSec;
  // Coach-set tempo (VW-46), when the planned exercise carries one, wins over the
  // exercise/movement-pattern default. The movement pattern, when the catalog
  // knows it, widens coverage to the per-pattern fallback; unknown exercise/
  // pattern with no coach tempo → null → tempo stays absent.
  const coachTempo = match.targetTempo;
  const tempo = resolveTargetTempo(
    activeExerciseId,
    coachTempo !== undefined
      ? [coachTempo.ecc, coachTempo.pauseBottom, coachTempo.con, coachTempo.pauseTop]
      : undefined,
    catalog?.getById(activeExerciseId)?.movementPattern,
  );
  if (tempo !== null) prescription.tempo = tempo;
  prescription.exercises = buildPlannedExerciseList(planned, activeExerciseId, catalog);
  if (title !== null) prescription.title = title;
  return prescription;
}

/**
 * The template's planned exercises as an ordered `PlannedExerciseView[]` (VW-49):
 * sorted by `orderIndex`, named from the exercise catalog (falling back to the raw
 * exercise id — a real identifier, never an invented label), with the active exercise
 * flagged. Only real planned rows; an empty template yields an empty list.
 */
export function buildPlannedExerciseList(
  planned: readonly StoredPlannedExercise[],
  activeExerciseId: string,
  catalog: ExerciseCatalogLookup | undefined,
): PlannedExerciseView[] {
  return [...planned]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((p) => {
      const entry: PlannedExerciseView = {
        name: catalog?.getById(p.exerciseId)?.name ?? p.exerciseId,
        order: p.orderIndex,
        sets: p.targetSets,
        active: p.exerciseId === activeExerciseId,
      };
      if (p.targetRepsLow !== undefined) entry.repsLow = p.targetRepsLow;
      if (p.targetRepsHigh !== undefined) entry.repsHigh = p.targetRepsHigh;
      if (p.targetWeightLbs !== undefined) entry.weightLbs = p.targetWeightLbs;
      return entry;
    });
}
