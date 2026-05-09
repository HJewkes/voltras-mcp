// `plan.*` tool handlers — CRUD for the v3 block-periodization schema.
//
// Wraps the `SessionStore` planning methods (program → block → week →
// workout-template → planned-exercise) added by the W3 schema commit.
// Handlers are intentionally thin: validate the strict schema, generate a
// UUID when no `id` is supplied, persist via the store, return the row that
// was written. Read-side tools forward straight to the store's list/get
// methods.
//
// Registration follows the placeholder-replace pattern used by the other
// tool modules: each tool name is pre-registered with a `STARTING` callback
// in `registerStartingPlaceholders`; we hot-swap the real handler via
// `RegisteredTool.update({ callback })`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
  PlanBlockCreateInput,
  PlanBlockListForProgramInput,
  PlanExerciseCreateInput,
  PlanExerciseListForTemplateInput,
  PlanProgramArchiveInput,
  PlanProgramCreateInput,
  PlanProgramGetInput,
  PlanProgramListInput,
  PlanTemplateCreateInput,
  PlanTemplateGetInput,
  PlanTemplateListForWeekInput,
  PlanWeekCreateInput,
  PlanWeekListForBlockInput,
} from '../schemas/plan.js';
import type { ServerState } from '../state/server-state.js';
import type {
  StoredPlannedExercise,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap real handlers for every `plan.*` tool. Throws if any placeholder
 * is missing — the placeholder map is constructed from `CORE_TOOL_NAMES` in
 * `server.ts`, so a missing entry means the tool name was forgotten there.
 */
export function registerPlanTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  // programs
  install(
    placeholders,
    'plan.program.create',
    PlanProgramCreateInput,
    wrapHandler(PlanProgramCreateInput, (input) => createProgram(state, input)),
  );
  install(
    placeholders,
    'plan.program.list',
    PlanProgramListInput,
    wrapHandler(PlanProgramListInput, (input) => listPrograms(state, input)),
  );
  install(
    placeholders,
    'plan.program.get',
    PlanProgramGetInput,
    wrapHandler(PlanProgramGetInput, (input) => getProgram(state, input)),
  );
  install(
    placeholders,
    'plan.program.archive',
    PlanProgramArchiveInput,
    wrapHandler(PlanProgramArchiveInput, (input) => archiveProgram(state, input)),
  );

  // blocks
  install(
    placeholders,
    'plan.block.create',
    PlanBlockCreateInput,
    wrapHandler(PlanBlockCreateInput, (input) => createBlock(state, input)),
  );
  install(
    placeholders,
    'plan.block.list_for_program',
    PlanBlockListForProgramInput,
    wrapHandler(PlanBlockListForProgramInput, (input) => listBlocksForProgram(state, input)),
  );

  // weeks
  install(
    placeholders,
    'plan.week.create',
    PlanWeekCreateInput,
    wrapHandler(PlanWeekCreateInput, (input) => createWeek(state, input)),
  );
  install(
    placeholders,
    'plan.week.list_for_block',
    PlanWeekListForBlockInput,
    wrapHandler(PlanWeekListForBlockInput, (input) => listWeeksForBlock(state, input)),
  );

  // workout templates
  install(
    placeholders,
    'plan.template.create',
    PlanTemplateCreateInput,
    wrapHandler(PlanTemplateCreateInput, (input) => createTemplate(state, input)),
  );
  install(
    placeholders,
    'plan.template.get',
    PlanTemplateGetInput,
    wrapHandler(PlanTemplateGetInput, (input) => getTemplate(state, input)),
  );
  install(
    placeholders,
    'plan.template.list_for_week',
    PlanTemplateListForWeekInput,
    wrapHandler(PlanTemplateListForWeekInput, (input) => listTemplatesForWeek(state, input)),
  );

  // planned exercises
  install(
    placeholders,
    'plan.exercise.create',
    PlanExerciseCreateInput,
    wrapHandler(PlanExerciseCreateInput, (input) => createPlannedExercise(state, input)),
  );
  install(
    placeholders,
    'plan.exercise.list_for_template',
    PlanExerciseListForTemplateInput,
    wrapHandler(PlanExerciseListForTemplateInput, (input) =>
      listPlannedExercisesForTemplate(state, input),
    ),
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
}

// --- programs ---

async function createProgram(
  state: ServerState,
  input: z.infer<typeof PlanProgramCreateInput>,
): Promise<{ program: StoredTrainingProgram }> {
  const program: StoredTrainingProgram = {
    id: input.id ?? randomUUID(),
    name: input.name,
    createdAt: new Date().toISOString(),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  await state.store.putTrainingProgram(program);
  return { program };
}

async function listPrograms(
  state: ServerState,
  input: z.infer<typeof PlanProgramListInput>,
): Promise<{ programs: StoredTrainingProgram[] }> {
  const opts =
    input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {};
  const programs = await state.store.listTrainingPrograms(opts);
  return { programs };
}

async function getProgram(
  state: ServerState,
  input: z.infer<typeof PlanProgramGetInput>,
): Promise<{ program: StoredTrainingProgram | null }> {
  const program = await state.store.getTrainingProgram(input.id);
  return { program: program ?? null };
}

async function archiveProgram(
  state: ServerState,
  input: z.infer<typeof PlanProgramArchiveInput>,
): Promise<{ ok: true; archivedAt: string }> {
  const existing = await state.store.getTrainingProgram(input.id);
  if (existing === undefined) {
    throw new ToolError('NOT_FOUND', `No training program with id "${input.id}" exists.`);
  }
  const archivedAt = new Date().toISOString();
  await state.store.putTrainingProgram({ ...existing, archivedAt });
  return { ok: true, archivedAt };
}

// --- blocks ---

async function createBlock(
  state: ServerState,
  input: z.infer<typeof PlanBlockCreateInput>,
): Promise<{ block: StoredTrainingBlock }> {
  const block: StoredTrainingBlock = {
    id: input.id ?? randomUUID(),
    programId: input.programId,
    orderIndex: input.orderIndex,
    name: input.name,
    weeksCount: input.weeksCount,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await state.store.putTrainingBlock(block);
  return { block };
}

async function listBlocksForProgram(
  state: ServerState,
  input: z.infer<typeof PlanBlockListForProgramInput>,
): Promise<{ blocks: StoredTrainingBlock[] }> {
  const blocks = await state.store.getTrainingBlocksForProgram(input.programId);
  return { blocks };
}

// --- weeks ---

async function createWeek(
  state: ServerState,
  input: z.infer<typeof PlanWeekCreateInput>,
): Promise<{ week: StoredTrainingWeek }> {
  const week: StoredTrainingWeek = {
    id: input.id ?? randomUUID(),
    blockId: input.blockId,
    orderIndex: input.orderIndex,
    ...(input.name !== undefined ? { name: input.name } : {}),
  };
  await state.store.putTrainingWeek(week);
  return { week };
}

async function listWeeksForBlock(
  state: ServerState,
  input: z.infer<typeof PlanWeekListForBlockInput>,
): Promise<{ weeks: StoredTrainingWeek[] }> {
  const weeks = await state.store.getTrainingWeeksForBlock(input.blockId);
  return { weeks };
}

// --- workout templates ---

async function createTemplate(
  state: ServerState,
  input: z.infer<typeof PlanTemplateCreateInput>,
): Promise<{ template: StoredWorkoutTemplate }> {
  const template: StoredWorkoutTemplate = {
    id: input.id ?? randomUUID(),
    weekId: input.weekId,
    name: input.name,
    orderIndex: input.orderIndex,
    ...(input.dayLabel !== undefined ? { dayLabel: input.dayLabel } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await state.store.putWorkoutTemplate(template);
  return { template };
}

async function getTemplate(
  state: ServerState,
  input: z.infer<typeof PlanTemplateGetInput>,
): Promise<{ template: StoredWorkoutTemplate | null }> {
  const template = await state.store.getWorkoutTemplate(input.id);
  return { template: template ?? null };
}

async function listTemplatesForWeek(
  state: ServerState,
  input: z.infer<typeof PlanTemplateListForWeekInput>,
): Promise<{ templates: StoredWorkoutTemplate[] }> {
  const templates = await state.store.getWorkoutTemplatesForWeek(input.weekId);
  return { templates };
}

// --- planned exercises ---

async function createPlannedExercise(
  state: ServerState,
  input: z.infer<typeof PlanExerciseCreateInput>,
): Promise<{ plannedExercise: StoredPlannedExercise }> {
  const plannedExercise: StoredPlannedExercise = {
    id: input.id ?? randomUUID(),
    workoutTemplateId: input.workoutTemplateId,
    exerciseId: input.exerciseId,
    orderIndex: input.orderIndex,
    targetSets: input.targetSets,
    ...(input.targetRepsLow !== undefined ? { targetRepsLow: input.targetRepsLow } : {}),
    ...(input.targetRepsHigh !== undefined ? { targetRepsHigh: input.targetRepsHigh } : {}),
    ...(input.targetWeightLbs !== undefined ? { targetWeightLbs: input.targetWeightLbs } : {}),
    ...(input.targetRpe !== undefined ? { targetRpe: input.targetRpe } : {}),
    ...(input.restSec !== undefined ? { restSec: input.restSec } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await state.store.putPlannedExercise(plannedExercise);
  return { plannedExercise };
}

async function listPlannedExercisesForTemplate(
  state: ServerState,
  input: z.infer<typeof PlanExerciseListForTemplateInput>,
): Promise<{ plannedExercises: StoredPlannedExercise[] }> {
  const plannedExercises = await state.store.getPlannedExercisesForTemplate(
    input.workoutTemplateId,
  );
  return { plannedExercises };
}
