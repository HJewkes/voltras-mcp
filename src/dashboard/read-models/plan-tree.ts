// Pure read-model for the dashboard's session-planning view (VW-120).
//
// `buildPlanTreeView` shapes already-fetched planning rows (program → block →
// week → workout-template → planned-exercise) into the nested, ordered,
// catalog-named tree the plan-builder SPA renders. It performs NO I/O: the
// caller (`dashboard/plan-api.ts`) owns the store reads, this module owns the
// output shape — the same split `read-models/snapshot.ts` uses for the live view.
//
// Naming policy matches `server.ts`'s planned-exercise rail: an exercise is
// labelled from the catalog when the catalog knows it, otherwise by its raw
// catalog id. A label is never invented.
//
// Confidentiality: plan metadata and fitness units only — no protocol data (NF-07).

import type {
  StoredPlannedExercise,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

/** One planned exercise row, named and ordered for display. */
export interface PlanExerciseView {
  /** `planned_exercises.id` — the handle the edit/reorder routes take. */
  id: string;
  /** Catalog id the row prescribes. */
  exerciseId: string;
  /** Catalog display name, or the raw exercise id when the catalog has no entry. */
  name: string;
  orderIndex: number;
  targetSets: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
  targetRpe?: number;
  restSec?: number;
  notes?: string;
}

/** A workout template (a single planned session) plus its ordered exercises. */
export interface PlanTemplateView {
  id: string;
  name: string;
  dayLabel?: string;
  notes?: string;
  orderIndex: number;
  exercises: PlanExerciseView[];
  /**
   * True when some session has already been assigned to this template
   * (`program_assignments`) — i.e. the workout has been trained. Mirrors the
   * signal `plan.next_workout` walks the tree for.
   */
  completed: boolean;
}

export interface PlanWeekView {
  id: string;
  name?: string;
  orderIndex: number;
  templates: PlanTemplateView[];
}

export interface PlanBlockView {
  id: string;
  name: string;
  focus?: string;
  notes?: string;
  orderIndex: number;
  weeksCount: number;
  weeks: PlanWeekView[];
}

export interface PlanProgramView {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  archivedAt?: string;
  blocks: PlanBlockView[];
}

/** One row in the program picker — enough to switch programs, nothing more. */
export interface PlanProgramSummary {
  id: string;
  name: string;
  archived: boolean;
}

export interface PlanTreeView {
  /** Every program, newest first, for the picker. */
  programs: PlanProgramSummary[];
  /** The selected program's full tree, or null when no program exists yet. */
  program: PlanProgramView | null;
  /** Workout template the LIVE session is attached to, when any. Drives the "now training" flag. */
  activeTemplateId: string | null;
  /** Exercise the live session is currently on, when any. */
  activeExerciseId: string | null;
}

/** Everything `buildPlanTreeView` needs, already read out of the store. */
export interface PlanTreeRows {
  programs: readonly StoredTrainingProgram[];
  /** The selected program. Absent ⇒ `program: null`. */
  program?: StoredTrainingProgram | undefined;
  blocks: readonly StoredTrainingBlock[];
  weeksByBlock: ReadonlyMap<string, readonly StoredTrainingWeek[]>;
  templatesByWeek: ReadonlyMap<string, readonly StoredWorkoutTemplate[]>;
  exercisesByTemplate: ReadonlyMap<string, readonly StoredPlannedExercise[]>;
  /** Template ids with at least one `program_assignments` row. */
  completedTemplateIds: ReadonlySet<string>;
  activeTemplateId?: string | null;
  activeExerciseId?: string | null;
}

/** Catalog name lookup. Returning `undefined` falls back to the raw exercise id. */
export type ExerciseNameLookup = (exerciseId: string) => string | undefined;

function byOrderIndex<T extends { orderIndex: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.orderIndex - b.orderIndex);
}

function toExerciseView(row: StoredPlannedExercise, nameOf: ExerciseNameLookup): PlanExerciseView {
  const view: PlanExerciseView = {
    id: row.id,
    exerciseId: row.exerciseId,
    name: nameOf(row.exerciseId) ?? row.exerciseId,
    orderIndex: row.orderIndex,
    targetSets: row.targetSets,
  };
  if (row.targetRepsLow !== undefined) view.targetRepsLow = row.targetRepsLow;
  if (row.targetRepsHigh !== undefined) view.targetRepsHigh = row.targetRepsHigh;
  if (row.targetWeightLbs !== undefined) view.targetWeightLbs = row.targetWeightLbs;
  if (row.targetRpe !== undefined) view.targetRpe = row.targetRpe;
  if (row.restSec !== undefined) view.restSec = row.restSec;
  if (row.notes !== undefined) view.notes = row.notes;
  return view;
}

function toTemplateView(
  row: StoredWorkoutTemplate,
  rows: PlanTreeRows,
  nameOf: ExerciseNameLookup,
): PlanTemplateView {
  const view: PlanTemplateView = {
    id: row.id,
    name: row.name,
    orderIndex: row.orderIndex,
    exercises: byOrderIndex(rows.exercisesByTemplate.get(row.id) ?? []).map((e) =>
      toExerciseView(e, nameOf),
    ),
    completed: rows.completedTemplateIds.has(row.id),
  };
  if (row.dayLabel !== undefined) view.dayLabel = row.dayLabel;
  if (row.notes !== undefined) view.notes = row.notes;
  return view;
}

function toWeekView(
  row: StoredTrainingWeek,
  rows: PlanTreeRows,
  nameOf: ExerciseNameLookup,
): PlanWeekView {
  const view: PlanWeekView = {
    id: row.id,
    orderIndex: row.orderIndex,
    templates: byOrderIndex(rows.templatesByWeek.get(row.id) ?? []).map((t) =>
      toTemplateView(t, rows, nameOf),
    ),
  };
  if (row.name !== undefined) view.name = row.name;
  return view;
}

function toBlockView(
  row: StoredTrainingBlock,
  rows: PlanTreeRows,
  nameOf: ExerciseNameLookup,
): PlanBlockView {
  const view: PlanBlockView = {
    id: row.id,
    name: row.name,
    orderIndex: row.orderIndex,
    weeksCount: row.weeksCount,
    weeks: byOrderIndex(rows.weeksByBlock.get(row.id) ?? []).map((w) =>
      toWeekView(w, rows, nameOf),
    ),
  };
  if (row.focus !== undefined) view.focus = row.focus;
  if (row.notes !== undefined) view.notes = row.notes;
  return view;
}

/**
 * Shape fetched planning rows into the nested plan tree. Every level is sorted
 * by `orderIndex` here rather than trusting the store's ordering, so a hand-built
 * fixture and a real sqlite read produce the same view.
 */
export function buildPlanTreeView(rows: PlanTreeRows, nameOf: ExerciseNameLookup): PlanTreeView {
  const programs: PlanProgramSummary[] = rows.programs.map((p) => ({
    id: p.id,
    name: p.name,
    archived: p.archivedAt !== undefined,
  }));

  let program: PlanProgramView | null = null;
  if (rows.program !== undefined) {
    program = {
      id: rows.program.id,
      name: rows.program.name,
      createdAt: rows.program.createdAt,
      blocks: byOrderIndex(rows.blocks).map((b) => toBlockView(b, rows, nameOf)),
    };
    if (rows.program.description !== undefined) program.description = rows.program.description;
    if (rows.program.archivedAt !== undefined) program.archivedAt = rows.program.archivedAt;
  }

  return {
    programs,
    program,
    activeTemplateId: rows.activeTemplateId ?? null,
    activeExerciseId: rows.activeExerciseId ?? null,
  };
}

/**
 * Next free `orderIndex` for a template's exercise list — one past the highest
 * existing index, so an append never collides with (or silently reorders) a row
 * that is already there. An empty template starts at 0.
 */
export function nextOrderIndex(rows: readonly { orderIndex: number }[]): number {
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((r) => r.orderIndex)) + 1;
}
