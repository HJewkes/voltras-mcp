// Plan-builder HTTP layer for the dashboard sidecar (VW-120).
//
// ── Why this exists rather than calling the `plan.*` MCP tools ─────────────
//
// `tools/plan-tools.ts` handlers are bound to the MCP transport: each one is a
// Zod-validated callback hot-swapped into a `RegisteredTool` placeholder, and
// the underlying create/list functions are module-private. Calling them from a
// plain `node:http` handler would mean either exporting the whole handler set
// (and dragging MCP result framing — `textResult` envelopes — into the
// dashboard) or standing up a fake tool registry per request.
//
// Both handlers are already thin: they generate a UUID, build a `Stored*` row,
// and call one `SessionStore` put. So this module is a SECOND thin adapter over
// the SAME store methods, not a reimplementation of any domain logic — the
// planning domain lives entirely in the store schema. The one piece of real
// logic (the progression heuristic) is NOT duplicated: `session-summary.ts`
// imports `computeProgressionDelta` from `plan-tools.ts` directly.
//
// ── Delete + validation (VW-121) ──────────────────────────────────────────
//
// VW-120 shipped without either, which cost exactly what you'd expect: a
// double-click on "Add" appended duplicate rows that no UI could remove, and
// `-999` saved as a real target weight. Both are closed here — `SessionStore`
// gained `deletePlannedExercise`, and every numeric target now goes through the
// shared bounds in `plan-targets.ts` (the SAME module the SPA validates with, so
// the two checks cannot drift). Editing and reordering still go through the
// existing `putPlannedExercise` upsert.
//
// Confidentiality: plan metadata and fitness units only — no protocol data (NF-07).

import { randomUUID } from 'node:crypto';

import {
  buildPlanTreeView,
  nextOrderIndex,
  type ExerciseNameLookup,
  type PlanTreeRows,
  type PlanTreeView,
} from './read-models/index.js';
import { validateTargets, type TargetField, type TargetValues } from './plan-targets.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../store/types.js';

/**
 * The `SessionStore` slice the plan routes need. Declared locally (rather than
 * `Pick<SessionStore, …>`) for the same reason `DashboardServerState` is: test
 * fakes shouldn't have to fabricate a whole store.
 */
export interface DashboardPlanStore {
  putTrainingProgram(p: StoredTrainingProgram): Promise<void>;
  getTrainingProgram(id: string): Promise<StoredTrainingProgram | undefined>;
  listTrainingPrograms(opts?: { includeArchived?: boolean }): Promise<StoredTrainingProgram[]>;
  putTrainingBlock(b: StoredTrainingBlock): Promise<void>;
  getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]>;
  putTrainingWeek(w: StoredTrainingWeek): Promise<void>;
  getTrainingWeeksForBlock(blockId: string): Promise<StoredTrainingWeek[]>;
  putWorkoutTemplate(t: StoredWorkoutTemplate): Promise<void>;
  getWorkoutTemplate(id: string): Promise<StoredWorkoutTemplate | undefined>;
  getWorkoutTemplatesForWeek(weekId: string): Promise<StoredWorkoutTemplate[]>;
  putPlannedExercise(e: StoredPlannedExercise): Promise<void>;
  getPlannedExercise(id: string): Promise<StoredPlannedExercise | undefined>;
  getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]>;
  deletePlannedExercise(id: string): Promise<boolean>;
  getAssignmentsForTemplate(templateId: string): Promise<StoredProgramAssignment[]>;
  getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]>;
}

/** Thrown by the mutation helpers; `server.ts` maps `code` onto an HTTP status. */
export class PlanApiError extends Error {
  readonly code: 'invalid_input' | 'not_found';
  constructor(code: 'invalid_input' | 'not_found', message: string) {
    super(message);
    this.code = code;
    this.name = 'PlanApiError';
  }
}

/** The live session's contribution to the plan tree: what is being trained right now. */
export interface ActivePlanContext {
  sessionId?: string | undefined;
  exerciseId?: string | undefined;
}

/**
 * Read the whole tree for one program. `programId` absent ⇒ the most recent
 * non-archived program, matching `plan-tools.ts`'s `resolveDefaultProgram` so
 * the dashboard and the MCP tools agree on "the current program".
 */
export async function fetchPlanTree(
  store: DashboardPlanStore,
  nameOf: ExerciseNameLookup,
  opts: { programId?: string | undefined; active?: ActivePlanContext } = {},
): Promise<PlanTreeView> {
  const programs = await store.listTrainingPrograms({ includeArchived: true });
  const program =
    opts.programId !== undefined
      ? programs.find((p) => p.id === opts.programId)
      : programs.find((p) => p.archivedAt === undefined);

  const rows: PlanTreeRows = {
    programs,
    program,
    blocks: [],
    weeksByBlock: new Map(),
    templatesByWeek: new Map(),
    exercisesByTemplate: new Map(),
    completedTemplateIds: new Set(),
    activeExerciseId: opts.active?.exerciseId ?? null,
    activeTemplateId: await resolveActiveTemplateId(store, opts.active?.sessionId),
  };
  if (program === undefined) return buildPlanTreeView(rows, nameOf);

  const blocks = await store.getTrainingBlocksForProgram(program.id);
  const weeksByBlock = new Map<string, StoredTrainingWeek[]>();
  const templatesByWeek = new Map<string, StoredWorkoutTemplate[]>();
  const exercisesByTemplate = new Map<string, StoredPlannedExercise[]>();
  const completedTemplateIds = new Set<string>();

  for (const block of blocks) {
    const weeks = await store.getTrainingWeeksForBlock(block.id);
    weeksByBlock.set(block.id, weeks);
    for (const week of weeks) {
      const templates = await store.getWorkoutTemplatesForWeek(week.id);
      templatesByWeek.set(week.id, templates);
      for (const template of templates) {
        exercisesByTemplate.set(
          template.id,
          await store.getPlannedExercisesForTemplate(template.id),
        );
        if ((await store.getAssignmentsForTemplate(template.id)).length > 0) {
          completedTemplateIds.add(template.id);
        }
      }
    }
  }

  return buildPlanTreeView(
    { ...rows, blocks, weeksByBlock, templatesByWeek, exercisesByTemplate, completedTemplateIds },
    nameOf,
  );
}

/** The workout template the live session was attached to, when it was attached to one. */
async function resolveActiveTemplateId(
  store: DashboardPlanStore,
  sessionId: string | undefined,
): Promise<string | null> {
  if (sessionId === undefined) return null;
  const assignments = await store.getAssignmentsForSession(sessionId);
  return assignments.find((a) => a.workoutTemplateId !== undefined)?.workoutTemplateId ?? null;
}

export interface CreateProgramBody {
  name?: unknown;
  description?: unknown;
  /** First block's name. Defaults to `'Block 1'`. */
  blockName?: unknown;
  /** First workout template's name. Defaults to `'Workout A'`. */
  workoutName?: unknown;
}

/**
 * Create a program AND scaffold the block / week / template beneath it.
 *
 * A bare program has nowhere to put an exercise — the schema requires a
 * template, which requires a week, which requires a block — so a "new program"
 * button that created only the program row would leave the builder with nothing
 * to fill in and force the user through three more forms before the first lift.
 * The scaffold is the minimum structure that makes the next action possible;
 * extra blocks/weeks are still created through the `plan.*` MCP tools.
 */
export async function createProgramWithScaffold(
  store: DashboardPlanStore,
  body: CreateProgramBody,
): Promise<{
  program: StoredTrainingProgram;
  block: StoredTrainingBlock;
  week: StoredTrainingWeek;
  template: StoredWorkoutTemplate;
}> {
  const name = requireString(body.name, 'name');
  const program: StoredTrainingProgram = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    ...(optionalString(body.description, 'description') !== undefined
      ? { description: optionalString(body.description, 'description') as string }
      : {}),
  };
  const block: StoredTrainingBlock = {
    id: randomUUID(),
    programId: program.id,
    orderIndex: 0,
    name: optionalString(body.blockName, 'blockName') ?? 'Block 1',
    weeksCount: 1,
  };
  const week: StoredTrainingWeek = {
    id: randomUUID(),
    blockId: block.id,
    orderIndex: 0,
    name: 'Week 1',
  };
  const template: StoredWorkoutTemplate = {
    id: randomUUID(),
    weekId: week.id,
    name: optionalString(body.workoutName, 'workoutName') ?? 'Workout A',
    orderIndex: 0,
  };
  await store.putTrainingProgram(program);
  await store.putTrainingBlock(block);
  await store.putTrainingWeek(week);
  await store.putWorkoutTemplate(template);
  return { program, block, week, template };
}

export interface CreateWorkoutBody {
  name?: unknown;
  dayLabel?: unknown;
  /** Target week. Defaults to the program's first week. */
  weekId?: unknown;
}

/** Append a workout template to a program's week (its first week by default). */
export async function createWorkout(
  store: DashboardPlanStore,
  programId: string,
  body: CreateWorkoutBody,
): Promise<{ template: StoredWorkoutTemplate }> {
  const name = requireString(body.name, 'name');
  const weekId = optionalString(body.weekId, 'weekId') ?? (await firstWeekId(store, programId));
  if (weekId === undefined) {
    throw new PlanApiError('not_found', `Program "${programId}" has no week to add a workout to.`);
  }
  const siblings = await store.getWorkoutTemplatesForWeek(weekId);
  const template: StoredWorkoutTemplate = {
    id: randomUUID(),
    weekId,
    name,
    orderIndex: nextOrderIndex(siblings),
    ...(optionalString(body.dayLabel, 'dayLabel') !== undefined
      ? { dayLabel: optionalString(body.dayLabel, 'dayLabel') as string }
      : {}),
  };
  await store.putWorkoutTemplate(template);
  return { template };
}

async function firstWeekId(
  store: DashboardPlanStore,
  programId: string,
): Promise<string | undefined> {
  const program = await store.getTrainingProgram(programId);
  if (program === undefined) {
    throw new PlanApiError('not_found', `No training program with id "${programId}" exists.`);
  }
  for (const block of await store.getTrainingBlocksForProgram(programId)) {
    const [week] = await store.getTrainingWeeksForBlock(block.id);
    if (week !== undefined) return week.id;
  }
  return undefined;
}

/** Target fields shared by the create-exercise and edit-exercise bodies. */
interface TargetFieldsBody {
  targetSets?: unknown;
  targetRepsLow?: unknown;
  targetRepsHigh?: unknown;
  targetWeightLbs?: unknown;
  targetRpe?: unknown;
  restSec?: unknown;
  notes?: unknown;
}

export interface CreatePlannedExerciseBody extends TargetFieldsBody {
  exerciseId?: unknown;
}

/** Append a planned exercise to a template, at the end of its current order. */
export async function createPlannedExercise(
  store: DashboardPlanStore,
  templateId: string,
  body: CreatePlannedExerciseBody,
): Promise<{ plannedExercise: StoredPlannedExercise }> {
  if ((await store.getWorkoutTemplate(templateId)) === undefined) {
    throw new PlanApiError('not_found', `No workout template with id "${templateId}" exists.`);
  }
  const exerciseId = requireString(body.exerciseId, 'exerciseId');
  const siblings = await store.getPlannedExercisesForTemplate(templateId);
  const patch = targetPatch(body);
  const targetSets = optionalNumber(body.targetSets, 'targetSets') ?? 3;
  assertTargetsInRange({ ...patch, targetSets });
  const plannedExercise: StoredPlannedExercise = {
    id: randomUUID(),
    workoutTemplateId: templateId,
    exerciseId,
    orderIndex: nextOrderIndex(siblings),
    targetSets,
    ...patch,
  };
  await store.putPlannedExercise(plannedExercise);
  return { plannedExercise };
}

export interface UpdatePlannedExerciseBody extends TargetFieldsBody {
  orderIndex?: unknown;
}

/**
 * Edit one planned exercise's targets (and/or its position). Absent keys are
 * left untouched — the caller PATCHes only what changed; `null` clears a field.
 */
export async function updatePlannedExercise(
  store: DashboardPlanStore,
  plannedExerciseId: string,
  body: UpdatePlannedExerciseBody,
): Promise<{ plannedExercise: StoredPlannedExercise }> {
  const existing = await store.getPlannedExercise(plannedExerciseId);
  if (existing === undefined) {
    throw new PlanApiError(
      'not_found',
      `No planned exercise with id "${plannedExerciseId}" exists.`,
    );
  }
  const updated: StoredPlannedExercise = {
    ...existing,
    ...targetPatch(body),
  };
  const targetSets = optionalNumber(body.targetSets, 'targetSets');
  if (targetSets !== undefined) updated.targetSets = targetSets;
  const orderIndex = optionalNumber(body.orderIndex, 'orderIndex');
  if (orderIndex !== undefined) updated.orderIndex = orderIndex;
  // Validated against the MERGED row, not the patch: a PATCH that raises only
  // `targetRepsLow` above the row's existing `targetRepsHigh` is exactly the
  // inverted band a per-field check waves through.
  assertTargetsInRange(targetValuesOf(updated));
  await store.putPlannedExercise(updated);
  return { plannedExercise: updated };
}

/**
 * Remove one planned exercise and close the gap it leaves in the template's
 * order, so the builder's `1. 2. 3.` numbering never skips. The renumber is the
 * same operation `reorderPlannedExercises` performs, over the survivors.
 */
export async function deletePlannedExercise(
  store: DashboardPlanStore,
  plannedExerciseId: string,
): Promise<{ deleted: true; templateId: string }> {
  const existing = await store.getPlannedExercise(plannedExerciseId);
  if (existing === undefined) {
    throw new PlanApiError(
      'not_found',
      `No planned exercise with id "${plannedExerciseId}" exists.`,
    );
  }
  const templateId = existing.workoutTemplateId;
  if (!(await store.deletePlannedExercise(plannedExerciseId))) {
    throw new PlanApiError(
      'not_found',
      `No planned exercise with id "${plannedExerciseId}" exists.`,
    );
  }
  const survivors = [...(await store.getPlannedExercisesForTemplate(templateId))].sort(
    (a, b) => a.orderIndex - b.orderIndex,
  );
  for (const [index, row] of survivors.entries()) {
    if (row.orderIndex !== index) await store.putPlannedExercise({ ...row, orderIndex: index });
  }
  return { deleted: true, templateId };
}

/**
 * Rewrite a template's exercise order from an explicit id list. Ids are
 * renumbered 0..n-1 in the order given; any row omitted from the list keeps its
 * relative position AFTER the listed ones, so a partial list can never silently
 * drop an exercise from the workout.
 */
export async function reorderPlannedExercises(
  store: DashboardPlanStore,
  templateId: string,
  body: { plannedExerciseIds?: unknown },
): Promise<{ plannedExercises: StoredPlannedExercise[] }> {
  const ids = body.plannedExerciseIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new PlanApiError('invalid_input', '`plannedExerciseIds` must be an array of strings.');
  }
  const rows = await store.getPlannedExercisesForTemplate(templateId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unknown = (ids as string[]).find((id) => !byId.has(id));
  if (unknown !== undefined) {
    throw new PlanApiError(
      'invalid_input',
      `Planned exercise "${unknown}" is not in template "${templateId}".`,
    );
  }
  const ordered = [
    ...(ids as string[]).map((id) => byId.get(id) as StoredPlannedExercise),
    ...[...rows]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .filter((r) => !(ids as string[]).includes(r.id)),
  ];
  const plannedExercises = ordered.map((row, index) => ({ ...row, orderIndex: index }));
  for (const row of plannedExercises) {
    await store.putPlannedExercise(row);
  }
  return { plannedExercises };
}

/** Optional target fields, present only when the body actually carried them. */
function targetPatch(body: TargetFieldsBody): Partial<StoredPlannedExercise> {
  const patch: Partial<StoredPlannedExercise> = {};
  const repsLow = optionalNumber(body.targetRepsLow, 'targetRepsLow');
  if (repsLow !== undefined) patch.targetRepsLow = repsLow;
  const repsHigh = optionalNumber(body.targetRepsHigh, 'targetRepsHigh');
  if (repsHigh !== undefined) patch.targetRepsHigh = repsHigh;
  const weight = optionalNumber(body.targetWeightLbs, 'targetWeightLbs');
  if (weight !== undefined) patch.targetWeightLbs = weight;
  const rpe = optionalNumber(body.targetRpe, 'targetRpe');
  if (rpe !== undefined) patch.targetRpe = rpe;
  const rest = optionalNumber(body.restSec, 'restSec');
  if (rest !== undefined) patch.restSec = rest;
  const notes = optionalString(body.notes, 'notes');
  if (notes !== undefined) patch.notes = notes;
  return patch;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanApiError(
      'invalid_input',
      `\`${field}\` is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new PlanApiError('invalid_input', `\`${field}\` must be a string.`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PlanApiError('invalid_input', `\`${field}\` must be a finite number.`);
  }
  return parsed;
}

/** The numeric target fields of a row, as `validateTargets` wants them. */
function targetValuesOf(row: StoredPlannedExercise): TargetValues {
  const fields: TargetField[] = [
    'targetSets',
    'targetRepsLow',
    'targetRepsHigh',
    'targetWeightLbs',
    'targetRpe',
    'restSec',
  ];
  const values: TargetValues = {};
  for (const field of fields) {
    const value = row[field];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

/**
 * The server-side half of the target gate. The SPA runs the same
 * `validateTargets` for immediate feedback; this one runs because a client
 * cannot be trusted — `curl` reaches this route too.
 */
function assertTargetsInRange(values: TargetValues): void {
  const message = validateTargets(values);
  if (message !== null) throw new PlanApiError('invalid_input', message);
}
