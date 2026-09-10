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
  PlanAttachToSessionInput,
  PlanBlockCreateInput,
  PlanBlockListForProgramInput,
  PlanCompleteWorkoutInput,
  PlanExerciseCreateInput,
  PlanExerciseListForTemplateInput,
  PlanNextWorkoutInput,
  PlanProgramArchiveInput,
  PlanProgramCreateInput,
  PlanProgramGetInput,
  PlanProgramListInput,
  PlanSuggestProgressionInput,
  PlanTemplateCreateInput,
  PlanTemplateGetInput,
  PlanTemplateListForWeekInput,
  PlanWeekCreateInput,
  PlanWeekListForBlockInput,
} from '../schemas/plan.js';
import {
  lintMesoLengthGrewMidBlock,
  lintPlan,
  lintPriorityMuscleChangedMidBlock,
  lintSameMuscleHighVolumeConsecutiveDays,
  lintWeeklyVolume,
  type LintPlanExercise,
  type PlanWarning,
} from '../plan/lint-plan.js';
import { peakConcentricBaseline } from '../state/channel-payloads.js';
import { type ServerState } from '../state/server-state.js';
import { scopeSessionSetsToExerciseId, scopeSetsToLifter } from '../store/set-scope.js';
import { selectWorkingSets } from '../store/working-sets.js';
import { movementClassForExerciseId, velocityLossIsValidFor } from '../exercises/movement-class.js';
import { DEVICE_LOAD_STEP_LBS } from './warmup-ramp-tools.js';
import {
  LOCAL_USER_ID,
  type StoredPlannedExercise,
  type StoredProgramAssignment,
  type StoredSet,
  type StoredTrainingBlock,
  type StoredTrainingProgram,
  type StoredTrainingWeek,
  type StoredWorkoutTemplate,
  type TrainingFocus,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { getTierSignal, type Tier, type TierConfidence, type TierSource } from './tier-signal.js';

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
// Plan hierarchy, top to bottom: program -> block -> week -> template ->
// planned exercise. Each level's `create` takes its parent's id; each
// `list_for_*` lists the children of one parent. `plan.next_workout` /
// `plan.complete_workout` / `plan.attach_to_session` / `plan.suggest_progression`
// are the runtime bridge between a static plan and an actual training session.
const PLAN_PROGRAM_CREATE_DESCRIPTION =
  'Create a new training program — the top-level container for a plan (holds one or more ' +
  'blocks/mesocycles). Start here when scaffolding a new plan from scratch.';
const PLAN_PROGRAM_LIST_DESCRIPTION = 'List existing programs.';
const PLAN_PROGRAM_GET_DESCRIPTION = 'Fetch one program by id.';
const PLAN_PROGRAM_ARCHIVE_DESCRIPTION =
  'Archive a program (soft-retire it from active use without deleting its history).';

const PLAN_BLOCK_CREATE_DESCRIPTION =
  'Create a training block (mesocycle) under a program — takes the parent programId. A block ' +
  'holds one or more weeks. Passing the `id` of an EXISTING block updates it in place; if that ' +
  'raises `weeksCount` after weeks were already built under it, `warnings[]` carries a ' +
  '`meso_length_grew_mid_block` advisory (VMCP-06.03 / B32). Never blocks the write.';
const PLAN_BLOCK_LIST_DESCRIPTION = 'List the blocks belonging to one program (takes programId).';

const PLAN_WEEK_CREATE_DESCRIPTION =
  'Create a week under a block — takes the parent blockId. A week holds one or more workout ' +
  'templates.';
const PLAN_WEEK_LIST_DESCRIPTION = 'List the weeks belonging to one block (takes blockId).';

const PLAN_TEMPLATE_CREATE_DESCRIPTION =
  'Create a workout template under a week — takes the parent weekId. A template holds one or ' +
  'more planned exercises and is what `plan.next_workout`/`plan.complete_workout` operate on. ' +
  'Returns `warnings: []` — a template holds no volume until exercises are added, so the ' +
  'tier-aware volume lints run on `plan.exercise.create`, not here.';
const PLAN_TEMPLATE_GET_DESCRIPTION = 'Fetch one workout template by id.';
const PLAN_TEMPLATE_LIST_DESCRIPTION =
  'List the workout templates belonging to one week (takes weekId).';

const PLAN_EXERCISE_CREATE_DESCRIPTION =
  'Add a planned exercise to a workout template — takes the parent workoutTemplateId. This is ' +
  'the leaf of the plan hierarchy: the actual prescribed exercise/sets/reps/load for one slot ' +
  'in one template. Also returns `warnings[]`: tier-aware RP volume ceilings re-checked over ' +
  'the WHOLE template after the insert (sets per exercise, and hard sets per muscle per ' +
  "session, counted on each exercise's PRIMARY muscle group only), PLUS three cross-template " +
  'checks over the rest of the week (hard sets per muscle per week, the same muscle over the ' +
  'per-session ceiling on two consecutive-orderIndex templates, and the priority muscle ' +
  'drifting between week 1 and a later week of the same block — VMCP-06.03 / B32). Each ' +
  'warning is a SUGGESTION; accept or decline it, and never re-apply it after a decline. The ' +
  'write ALWAYS succeeds — a warning never blocks, never rolls back, and never edits the row ' +
  'you just created. Read a warning out to the lifter and offer the fix it names; if they ' +
  'decline, drop it and move on. `targetTempo` (VW-46) is an optional coach-set tempo override ' +
  '— `{ ecc, pauseBottom, con, pauseTop }` seconds, each >= 0 — that wins over the exercise/' +
  'movement-pattern default when the live prescription resolves a tempo; omit it to leave the ' +
  'default in effect.';
const PLAN_EXERCISE_LIST_DESCRIPTION =
  'List the planned exercises belonging to one workout template (takes workoutTemplateId).';

const PLAN_NEXT_WORKOUT_DESCRIPTION =
  'Get the next un-completed workout template for a program (or the active/default program if ' +
  'programId is omitted). Use this to answer "what should the user do today per their plan?" ' +
  'Returns `blockBoundary: null` unless the returned template is the first of a new block (VMCP-06.06 ' +
  '/ B48), in which case it carries the finished block, the new block, the current goal on file, and ' +
  'an advisory prompt to keep or restate that goal — never auto-applied, and the goal itself is never ' +
  'written by this tool.';
const PLAN_COMPLETE_WORKOUT_DESCRIPTION =
  'Mark a workout template as completed, optionally linking the real session that completed it ' +
  '(sessionId). Advances what `plan.next_workout` returns next. Returns `blockBoundary: null` unless ' +
  'the completed template is the last template of the last week in its block (VMCP-06.06 / B48), in ' +
  'which case it carries the finished block, the next block (or null if none), the current goal on ' +
  'file, and an advisory goal-realignment prompt — never auto-applied, and the goal itself is never ' +
  'written by this tool.';
const PLAN_ATTACH_TO_SESSION_DESCRIPTION =
  'Link a live/real session to a plan entity — either a specific plannedExerciseId or a whole ' +
  'workoutTemplateId (exactly one of the two). Use this to connect what the user is actually ' +
  'doing right now to what the plan prescribed, without requiring the session to have been ' +
  'started from the plan in the first place.';
const PLAN_SUGGEST_PROGRESSION_DESCRIPTION =
  'Get a suggested load/weight-delta for the next occurrence of an exercise, based on the most ' +
  'recently completed session for it (completedSessionId, optional — inferred if omitted) ' +
  'within a program. Returns `delta` (lb) plus `repDelta` — above a ~15-rep prescription the ' +
  'rep is the finer dial than the load, so the suggestion adds a rep instead of weight. ' +
  '`gates` reports the ordered progression gates (technique, effort, setsUnlocked: whether ' +
  'adding a set is warranted) and `tier` the training-experience signal the gates were read ' +
  'against. Suggestion only: the coach or lifter accepts or declines it, it is never ' +
  'auto-applied, and a declined suggestion is not re-applied.';

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
    PLAN_PROGRAM_CREATE_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.program.list',
    PlanProgramListInput,
    wrapHandler(PlanProgramListInput, (input) => listPrograms(state, input)),
    PLAN_PROGRAM_LIST_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.program.get',
    PlanProgramGetInput,
    wrapHandler(PlanProgramGetInput, (input) => getProgram(state, input)),
    PLAN_PROGRAM_GET_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.program.archive',
    PlanProgramArchiveInput,
    wrapHandler(PlanProgramArchiveInput, (input) => archiveProgram(state, input)),
    PLAN_PROGRAM_ARCHIVE_DESCRIPTION,
  );

  // blocks
  install(
    placeholders,
    'plan.block.create',
    PlanBlockCreateInput,
    wrapHandler(PlanBlockCreateInput, (input) => createBlock(state, input)),
    PLAN_BLOCK_CREATE_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.block.list_for_program',
    PlanBlockListForProgramInput,
    wrapHandler(PlanBlockListForProgramInput, (input) => listBlocksForProgram(state, input)),
    PLAN_BLOCK_LIST_DESCRIPTION,
  );

  // weeks
  install(
    placeholders,
    'plan.week.create',
    PlanWeekCreateInput,
    wrapHandler(PlanWeekCreateInput, (input) => createWeek(state, input)),
    PLAN_WEEK_CREATE_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.week.list_for_block',
    PlanWeekListForBlockInput,
    wrapHandler(PlanWeekListForBlockInput, (input) => listWeeksForBlock(state, input)),
    PLAN_WEEK_LIST_DESCRIPTION,
  );

  // workout templates
  install(
    placeholders,
    'plan.template.create',
    PlanTemplateCreateInput,
    wrapHandler(PlanTemplateCreateInput, (input) => createTemplate(state, input)),
    PLAN_TEMPLATE_CREATE_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.template.get',
    PlanTemplateGetInput,
    wrapHandler(PlanTemplateGetInput, (input) => getTemplate(state, input)),
    PLAN_TEMPLATE_GET_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.template.list_for_week',
    PlanTemplateListForWeekInput,
    wrapHandler(PlanTemplateListForWeekInput, (input) => listTemplatesForWeek(state, input)),
    PLAN_TEMPLATE_LIST_DESCRIPTION,
  );

  // planned exercises
  install(
    placeholders,
    'plan.exercise.create',
    PlanExerciseCreateInput,
    wrapHandler(PlanExerciseCreateInput, (input) => createPlannedExercise(state, input)),
    PLAN_EXERCISE_CREATE_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.exercise.list_for_template',
    PlanExerciseListForTemplateInput,
    wrapHandler(PlanExerciseListForTemplateInput, (input) =>
      listPlannedExercisesForTemplate(state, input),
    ),
    PLAN_EXERCISE_LIST_DESCRIPTION,
  );

  // progression / session-link tools
  install(
    placeholders,
    'plan.next_workout',
    PlanNextWorkoutInput,
    wrapHandler(PlanNextWorkoutInput, (input) => nextWorkout(state, input)),
    PLAN_NEXT_WORKOUT_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.complete_workout',
    PlanCompleteWorkoutInput,
    wrapHandler(PlanCompleteWorkoutInput, (input) => completeWorkout(state, input)),
    PLAN_COMPLETE_WORKOUT_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.attach_to_session',
    PlanAttachToSessionInput,
    wrapHandler(PlanAttachToSessionInput, (input) => attachToSession(state, input)),
    PLAN_ATTACH_TO_SESSION_DESCRIPTION,
  );
  install(
    placeholders,
    'plan.suggest_progression',
    PlanSuggestProgressionInput,
    wrapHandler(PlanSuggestProgressionInput, (input) => suggestProgression(state, input)),
    PLAN_SUGGEST_PROGRESSION_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
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
): Promise<{ block: StoredTrainingBlock; warnings: PlanWarning[] }> {
  const id = input.id ?? randomUUID();
  // `putTrainingBlock` upserts by id, so a caller passing a known id is
  // editing that block in place — this is the only seam that can tell
  // whether `weeksCount` just changed on an existing block.
  const previous = input.id !== undefined ? await state.store.getTrainingBlock(id) : undefined;
  const block: StoredTrainingBlock = {
    id,
    programId: input.programId,
    orderIndex: input.orderIndex,
    name: input.name,
    weeksCount: input.weeksCount,
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await state.store.putTrainingBlock(block);
  const warnings = await lintMesoLength(state, previous, block);
  return { block, warnings };
}

/**
 * Swallows anything that goes wrong on purpose, same as `lintTemplateVolume`
 * below — B32 is advisory and must never cost the caller its write.
 */
async function lintMesoLength(
  state: ServerState,
  previous: StoredTrainingBlock | undefined,
  block: StoredTrainingBlock,
): Promise<PlanWarning[]> {
  if (previous === undefined) return [];
  try {
    const weeks = await state.store.getTrainingWeeksForBlock(block.id);
    return lintMesoLengthGrewMidBlock({
      previousWeeksCount: previous.weeksCount,
      newWeeksCount: block.weeksCount,
      weeksAlreadyCreated: weeks.length,
    });
  } catch {
    return [];
  }
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

/**
 * `warnings` is always empty here and that is not an oversight: a template is
 * created before it holds any exercise, so there is no volume to measure yet.
 * The key ships anyway so a caller can read `warnings` off both create tools
 * without branching on which one it called.
 */
async function createTemplate(
  state: ServerState,
  input: z.infer<typeof PlanTemplateCreateInput>,
): Promise<{ template: StoredWorkoutTemplate; warnings: PlanWarning[] }> {
  const template: StoredWorkoutTemplate = {
    id: input.id ?? randomUUID(),
    weekId: input.weekId,
    name: input.name,
    orderIndex: input.orderIndex,
    ...(input.dayLabel !== undefined ? { dayLabel: input.dayLabel } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await state.store.putWorkoutTemplate(template);
  return { template, warnings: [] };
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
): Promise<{ plannedExercise: StoredPlannedExercise; warnings: PlanWarning[] }> {
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
    ...(input.targetTempo !== undefined ? { targetTempo: input.targetTempo } : {}),
  };
  await state.store.putPlannedExercise(plannedExercise);
  const warnings = await lintTemplateVolume(state, input.workoutTemplateId);
  return { plannedExercise, warnings };
}

/**
 * Re-lint the WHOLE template after an insert — the per-muscle ceiling is a
 * property of the session, so the exercise just added is only judgeable
 * alongside its siblings. Also runs the three B32 cross-template checks over
 * the rest of the week (VMCP-06.03).
 *
 * Swallows anything that goes wrong on purpose. The row is already committed by
 * the time this runs, and B31/B32 are advisory: a catalog miss or a store hiccup
 * must cost the caller its warnings, never its write.
 */
async function lintTemplateVolume(
  state: ServerState,
  workoutTemplateId: string,
): Promise<PlanWarning[]> {
  try {
    const siblings = await state.store.getPlannedExercisesForTemplate(workoutTemplateId);
    const { tier, confidence } = await getTierSignal(state);
    const sessionWarnings = lintPlan({
      exercises: siblings.map((e) => toLintExercise(state, e)),
      tier,
      confidence,
    });
    const crossTemplateWarnings = await lintAcrossWeek(
      state,
      workoutTemplateId,
      siblings,
      tier,
      confidence,
    );
    return [...sessionWarnings, ...crossTemplateWarnings];
  } catch {
    return [];
  }
}

interface TemplateExerciseBucket {
  template: StoredWorkoutTemplate;
  exercises: LintPlanExercise[];
}

/** Runs the weekly ceiling, consecutive-days, and priority-muscle B32 lints. */
async function lintAcrossWeek(
  state: ServerState,
  workoutTemplateId: string,
  ownExercises: StoredPlannedExercise[],
  tier: Tier,
  confidence: TierConfidence,
): Promise<PlanWarning[]> {
  const current = await state.store.getWorkoutTemplate(workoutTemplateId);
  if (current === undefined) return [];
  const weekTemplates = await state.store.getWorkoutTemplatesForWeek(current.weekId);
  const buckets = await templateExerciseBuckets(state, weekTemplates, {
    templateId: workoutTemplateId,
    exercises: ownExercises,
  });
  const weekExercises = buckets.flatMap((b) => b.exercises);
  const weekly = lintWeeklyVolume({ exercises: weekExercises, tier, confidence });
  const consecutive = lintSameMuscleHighVolumeConsecutiveDays({
    templates: buckets.map((b) => ({
      ...(b.template.dayLabel !== undefined ? { dayLabel: b.template.dayLabel } : {}),
      exercises: b.exercises,
    })),
    tier,
    confidence,
  });
  const priority = await lintPriorityMuscle(state, current, weekExercises);
  return [...weekly, ...consecutive, ...priority];
}

/** Fetches each template's planned exercises, reusing an already-known one to avoid a refetch. */
async function templateExerciseBuckets(
  state: ServerState,
  templates: StoredWorkoutTemplate[],
  known?: { templateId: string; exercises: StoredPlannedExercise[] },
): Promise<TemplateExerciseBucket[]> {
  return Promise.all(
    templates.map(async (template) => {
      const rows =
        template.id === known?.templateId
          ? known.exercises
          : await state.store.getPlannedExercisesForTemplate(template.id);
      return { template, exercises: rows.map((e) => toLintExercise(state, e)) };
    }),
  );
}

/**
 * Compares the current week's priority muscle against week 1 of the same
 * block. Silent (no extra fetch) when the current week already IS week 1.
 */
async function lintPriorityMuscle(
  state: ServerState,
  currentTemplate: StoredWorkoutTemplate,
  currentWeekExercises: LintPlanExercise[],
): Promise<PlanWarning[]> {
  const week = await state.store.getTrainingWeek(currentTemplate.weekId);
  if (week === undefined) return [];
  const blockWeeks = await state.store.getTrainingWeeksForBlock(week.blockId);
  const week1 = [...blockWeeks].sort((a, b) => a.orderIndex - b.orderIndex)[0];
  if (week1 === undefined || week1.id === week.id) return [];
  const week1Templates = await state.store.getWorkoutTemplatesForWeek(week1.id);
  const week1Buckets = await templateExerciseBuckets(state, week1Templates);
  return lintPriorityMuscleChangedMidBlock({
    week1Exercises: week1Buckets.flatMap((b) => b.exercises),
    laterWeekExercises: currentWeekExercises,
    laterWeekOrderIndex: week.orderIndex,
  });
}

/** Per-muscle lint is target-only (B47): `muscleGroups[0]`, never the secondaries. */
function toLintExercise(state: ServerState, e: StoredPlannedExercise): LintPlanExercise {
  const muscleGroup = state.exercises.getById(e.exerciseId)?.muscleGroups[0];
  return {
    exerciseId: e.exerciseId,
    targetSets: e.targetSets,
    ...(muscleGroup !== undefined ? { muscleGroup } : {}),
  };
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

// --- progression / session-link tools ---

/**
 * Per-set progression deltas in lbs. Fixed at +5 / 0 / -5 for v1 — the simple
 * heuristic is "did the set hit the prescribed rep band?" Future revs may swap
 * this for an RPE-aware load curve, but the contract is intentionally rigid
 * so the suggestion is reproducible from a stored session alone.
 */
const PROGRESSION_INCREMENT_LBS = 5;
const PROGRESSION_DECREMENT_LBS = -5;
const PROGRESSION_HOLD_LBS = 0;

/**
 * B23 (VMCP-06.09): percent-of-load load increment, meant to replace the fixed
 * +5 lb step above with a jump scaled to the lifter's own working load.
 * `sources/mined/rp-university-idea-backlog.md` "### 14. B23" is the only note
 * that proposes this rule, and it states no percent — it explicitly discards
 * RP's own (sex-keyed) default rather than quoting it, so there is nothing to
 * cite. Null until a cited note states a number; the fixed step stays the only
 * load-increment path.
 */
const PROGRESSION_INCREMENT_PERCENT: number | null = null;

/**
 * Ceiling on the percent-derived increment, same citation gap as
 * `PROGRESSION_INCREMENT_PERCENT`: no cap value is stated either, so null
 * means uncapped (beyond the device-step rounding below).
 */
const PROGRESSION_INCREMENT_CAP_LBS: number | null = null;

/**
 * B23's arithmetic, kept pure and exported so it's testable independent of
 * the (currently null) production percent: `topLoadLbs * percent`, rounded
 * down to the device's load step, floored at the fixed increment, and capped
 * when a cap is cited.
 */
export function computePercentIncrement(
  topLoadLbs: number,
  percent: number,
  floorLbs: number = PROGRESSION_INCREMENT_LBS,
  capLbs: number | null = PROGRESSION_INCREMENT_CAP_LBS,
): number {
  const raw = topLoadLbs * (percent / 100);
  const stepped = Math.floor(raw / DEVICE_LOAD_STEP_LBS) * DEVICE_LOAD_STEP_LBS;
  const floored = Math.max(floorLbs, stepped);
  return capLbs === null ? floored : Math.min(floored, capLbs);
}

/**
 * VMCP-02.25: velocity-loss ceiling above which a set that *hit its rep target*
 * is treated as taken to/near functional failure — so the heuristic holds the
 * load instead of adding weight. VBT autoregulation commonly reads ~20% loss as
 * moderate fatigue and ~30%+ as high/near-failure; 25% is the conservative
 * "this set was already hard — don't add load" line. (The 2026-05-18 bench set
 * hit its reps at ~49% loss yet the rep-band-only heuristic recommended +5 lb.)
 */
const PROGRESSION_VELOCITY_LOSS_HOLD_PCT = 25;

/**
 * B24 (VMCP-06.01): below ~15 prescribed reps load is the finer dial, above it
 * the rep is — one rep moves effective RIR by ~3 in a 5-10 rep set.
 */
const REP_RANGE_LOAD_CEILING = 15;

/**
 * B07 (VMCP-06.07) effort gate: at or below this intra-set velocity loss the
 * set is read as far from failure, i.e. 'easy'. The threshold is the only one
 * the outcome table in the internal VBT/RIR research review §1.3 (held
 * outside this repo) treats as a distinct regime, verbatim:
 *
 *   "Power / jump / sprint / velocity vs. submaximal loads | Lower VL (≤15 %)
 *    is clearly better; high VL is actively counterproductive."
 *
 * Hypertrophy in the same table is flat from 20-30 %, so 15 % is the
 * far-from-failure line and 15-25 % stays 'unknown' rather than guessing.
 */
const PROGRESSION_EASY_LOSS_PCT = 15;

export type TechniqueGate = 'stable' | 'unstable' | 'unknown';
export type EffortGate = 'hard' | 'easy' | 'unknown';

/** B07's ordered gate: technique before load/reps, load/reps before sets. */
export interface ProgressionGates {
  technique: TechniqueGate;
  effort: EffortGate;
  setsUnlocked: boolean;
}

export interface ProgressionSuggestion {
  delta: number;
  repDelta: number;
  reasoning: string;
  basedOnSessionId: string | null;
  gates: ProgressionGates;
  /** Which load-increment rule produced `delta`; 'percent' only when B23's cited percent is set. */
  basis: 'percent' | 'fixed';
}

/**
 * What the caller knows that the stored sets don't. `tier` is read once by
 * `suggestProgression` and passed in — this function never touches the store.
 * `technique` is the VW-93 (B09 ROM-integrity) input; nothing supplies it yet,
 * so it stays 'unknown', and 'unknown' never blocks.
 */
export interface ProgressionContext {
  tier: Tier;
  technique?: TechniqueGate;
  /**
   * B23 (VMCP-06.09) override for the percent-of-load increment. Omitted
   * (not just `undefined`-valued) falls back to the production
   * `PROGRESSION_INCREMENT_PERCENT` constant, which is `null` until a source
   * cites a real number — see that constant's doc comment. Not on any tool
   * input schema; test-only injection point.
   */
  incrementPercent?: number | null;
}

export const DEFAULT_PROGRESSION_CONTEXT: ProgressionContext = {
  tier: 'intermediate',
  incrementPercent: PROGRESSION_INCREMENT_PERCENT,
};

/** The slice of `getTierSignal` the suggestion carries back to the caller. */
export interface SuggestionTier {
  tier: Tier;
  confidence: TierConfidence;
  source: TierSource;
}

/**
 * Peak-to-last concentric velocity loss (%) for one set, using the same
 * peak-baseline definition as the `velocity_loss_exceeded` channel event
 * (baseline = highest peak concentric velocity in the set, which sidesteps the
 * rep-1 setup-pause artifact). Returns 0 when the set is too short or carries no
 * velocity telemetry to judge — i.e. "no fatigue signal", never a false override.
 *
 * Deliberately NOT routed through `normaliseVelocityToMps` (VW-160): both terms
 * come from the same set, so the ratio is scale-invariant and a device-native
 * row already yields the right percentage.
 */
function setVelocityLossPct(set: StoredSet): number {
  if (!setCarriesVelocity(set)) return 0;
  const baseline = peakConcentricBaseline(set.reps);
  const last = set.reps[set.reps.length - 1].concentric.peakVelocity;
  if (last >= baseline) return 0;
  return (100 * (baseline - last)) / baseline;
}

/**
 * Whether a set can be judged for fatigue at all. `setVelocityLossPct` reports
 * 0 both for "no loss" and "nothing to measure"; the B07 effort gate has to
 * tell those apart, since only the first means the set was easy.
 *
 * VMCP-02.63: a ballistic pull answers no. Its telemetry is present and its
 * loss figure computes fine — it just isn't a fatigue signal, so treating a
 * row's 2% loss as "easy, add load" is the same mistake as treating it as
 * "hard, hold". The 25% hold therefore never triggers on a pull, and the
 * effort gate reports `unknown` rather than a verdict it cannot support.
 */
function setCarriesVelocity(set: StoredSet): boolean {
  if (!velocityLossIsValidFor(movementClassForExerciseId(set.exerciseId))) return false;
  return set.reps.length >= 2 && peakConcentricBaseline(set.reps) > 0;
}

/**
 * Resolve the program a progression-tool call refers to. If `programId` is
 * supplied, fetch + verify it exists. Otherwise, pick the most-recent
 * non-archived program (the store returns rows ordered by `created_at DESC`).
 * Throws `NO_PROGRAM_FOUND` when no eligible program exists.
 */
export async function resolveDefaultProgram(
  state: ServerState,
  programId: string | undefined,
): Promise<StoredTrainingProgram> {
  if (programId !== undefined) {
    const program = await state.store.getTrainingProgram(programId);
    if (program === undefined) {
      throw new ToolError('NOT_FOUND', `No training program with id "${programId}" exists.`);
    }
    return program;
  }
  const programs = await state.store.listTrainingPrograms({ includeArchived: false });
  const latest = programs[0];
  if (latest === undefined) {
    throw new ToolError(
      'NO_PROGRAM_FOUND',
      'No training programs exist. Create one with plan.program.create.',
    );
  }
  return latest;
}

/** The block-tree reference `blockBoundary.finishedBlock`/`nextBlock` carry (VMCP-06.06 / B48). */
export interface BlockBoundaryRef {
  id: string;
  name: string;
  focus?: TrainingFocus;
}

/**
 * Reported on `plan.next_workout`/`plan.complete_workout` only when the call
 * actually lands on a block edge — never when mid-block. A pure advisory: it
 * never writes the goal (Addendum 4.2 — accept/decline wording, never
 * re-applied after a decline).
 */
export interface BlockBoundary {
  crossed: true;
  finishedBlock: BlockBoundaryRef;
  nextBlock: BlockBoundaryRef | null;
  currentGoal: string | null;
  prompt: string;
}

function toBlockBoundaryRef(block: StoredTrainingBlock): BlockBoundaryRef {
  return {
    id: block.id,
    name: block.name,
    ...(block.focus !== undefined ? { focus: block.focus } : {}),
  };
}

function buildGoalRealignmentPrompt(
  finishedBlock: BlockBoundaryRef,
  nextBlock: BlockBoundaryRef | null,
  currentGoal: string | null,
): string {
  const beforeNext =
    nextBlock !== null ? `before ${nextBlock.name} starts` : 'before your next block';
  if (currentGoal === null) {
    return `Block ${finishedBlock.name} is done. You don't have a goal on file. State one ${beforeNext}.`;
  }
  return (
    `Block ${finishedBlock.name} is done. Your goal on file is '${currentGoal}'. ` +
    `Keep it, or restate it ${beforeNext}.`
  );
}

/**
 * `finishedBlockIndex` picks the pivot: the block AT that index is
 * `finishedBlock`, the one right after it is `nextBlock`. Callers choose
 * which index that is — `completeWorkout` passes the completed template's own
 * block, `nextWorkout` passes the block BEFORE the one it is returning — so
 * this one function computes the reported pair for both directions without
 * ever comparing block/template names.
 */
function buildBlockBoundary(
  orderedBlocks: StoredTrainingBlock[],
  finishedBlockIndex: number,
  currentGoal: string | null,
): BlockBoundary {
  const finishedBlock = toBlockBoundaryRef(orderedBlocks[finishedBlockIndex]);
  const nextBlockRow = orderedBlocks[finishedBlockIndex + 1];
  const nextBlock = nextBlockRow !== undefined ? toBlockBoundaryRef(nextBlockRow) : null;
  return {
    crossed: true,
    finishedBlock,
    nextBlock,
    currentGoal,
    prompt: buildGoalRealignmentPrompt(finishedBlock, nextBlock, currentGoal),
  };
}

async function readCurrentGoal(state: ServerState): Promise<string | null> {
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  return profile?.goal ?? null;
}

/**
 * `next_workout` reports a boundary only when the template it is about to
 * hand back is the first of its block AND a prior block actually exists —
 * the very first workout of a brand-new program hasn't crossed anything.
 */
async function resolveNextWorkoutBlockBoundary(
  state: ServerState,
  orderedBlocks: StoredTrainingBlock[],
  blockIndex: number,
  isFirstOfBlock: boolean,
): Promise<BlockBoundary | null> {
  if (!isFirstOfBlock || blockIndex === 0) return null;
  return buildBlockBoundary(orderedBlocks, blockIndex - 1, await readCurrentGoal(state));
}

/**
 * `complete_workout` reports a boundary only when the just-completed
 * template is the last template of the last week in its block.
 */
async function resolveCompleteWorkoutBlockBoundary(
  state: ServerState,
  template: StoredWorkoutTemplate,
): Promise<BlockBoundary | null> {
  const week = await state.store.getTrainingWeek(template.weekId);
  if (week === undefined) return null;
  const block = await state.store.getTrainingBlock(week.blockId);
  if (block === undefined) return null;
  const weeksInBlock = await state.store.getTrainingWeeksForBlock(block.id);
  const templatesInWeek = await state.store.getWorkoutTemplatesForWeek(week.id);
  const isLastWeek = weeksInBlock[weeksInBlock.length - 1]?.id === week.id;
  const isLastTemplate = templatesInWeek[templatesInWeek.length - 1]?.id === template.id;
  if (!isLastWeek || !isLastTemplate) return null;
  const orderedBlocks = await state.store.getTrainingBlocksForProgram(block.programId);
  const blockIndex = orderedBlocks.findIndex((b) => b.id === block.id);
  if (blockIndex === -1) return null;
  return buildBlockBoundary(orderedBlocks, blockIndex, await readCurrentGoal(state));
}

async function nextWorkout(
  state: ServerState,
  input: z.infer<typeof PlanNextWorkoutInput>,
): Promise<
  | {
      template: StoredWorkoutTemplate;
      plannedExercises: StoredPlannedExercise[];
      block: StoredTrainingBlock;
      week: StoredTrainingWeek;
      blockBoundary: BlockBoundary | null;
    }
  | { ok: true; completed: true }
> {
  const program = await resolveDefaultProgram(state, input.programId);
  const blocks = await state.store.getTrainingBlocksForProgram(program.id);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const weeks = await state.store.getTrainingWeeksForBlock(block.id);
    for (let weekIndex = 0; weekIndex < weeks.length; weekIndex++) {
      const week = weeks[weekIndex];
      const templates = await state.store.getWorkoutTemplatesForWeek(week.id);
      for (let templateIndex = 0; templateIndex < templates.length; templateIndex++) {
        const template = templates[templateIndex];
        const assignments = await state.store.getAssignmentsForTemplate(template.id);
        if (assignments.length === 0) {
          const plannedExercises = await state.store.getPlannedExercisesForTemplate(template.id);
          const blockBoundary = await resolveNextWorkoutBlockBoundary(
            state,
            blocks,
            blockIndex,
            weekIndex === 0 && templateIndex === 0,
          );
          return { template, plannedExercises, block, week, blockBoundary };
        }
      }
    }
  }
  return { ok: true, completed: true };
}

async function completeWorkout(
  state: ServerState,
  input: z.infer<typeof PlanCompleteWorkoutInput>,
): Promise<{ assignment: StoredProgramAssignment; blockBoundary: BlockBoundary | null }> {
  const sessionId = input.sessionId ?? resolveActiveSessionId(state);
  if (sessionId === null) {
    throw new ToolError(
      'NO_ACTIVE_SESSION',
      'No session is active. Pass sessionId or call session.start first.',
    );
  }
  const template = await state.store.getWorkoutTemplate(input.workoutTemplateId);
  if (template === undefined) {
    throw new ToolError(
      'NOT_FOUND',
      `No workout template with id "${input.workoutTemplateId}" exists.`,
    );
  }
  const session = await state.store.getSession(sessionId);
  if (session === undefined) {
    throw new ToolError('NOT_FOUND', `No session with id "${sessionId}" exists.`);
  }
  const blockBoundary = await resolveCompleteWorkoutBlockBoundary(state, template);
  // Idempotency: if an assignment already exists for this (session, template)
  // pair, return the existing row rather than writing a duplicate. The store
  // upsert is keyed on assignment.id (a UUID we'd generate), not on the
  // (session_id, workout_template_id) tuple, so without this check we'd
  // accumulate duplicate rows on retry.
  const existing = await state.store.getAssignmentsForSession(sessionId);
  const prior = existing.find((a) => a.workoutTemplateId === input.workoutTemplateId);
  if (prior !== undefined) {
    return { assignment: prior, blockBoundary };
  }
  const assignment: StoredProgramAssignment = {
    id: randomUUID(),
    sessionId,
    workoutTemplateId: input.workoutTemplateId,
    assignedAt: new Date().toISOString(),
  };
  await state.store.putProgramAssignment(assignment);
  return { assignment, blockBoundary };
}

async function attachToSession(
  state: ServerState,
  input: z.infer<typeof PlanAttachToSessionInput>,
): Promise<{ assignment: StoredProgramAssignment }> {
  // The Zod refine guarantees exactly-one-of, so this branch is structural.
  const session = await state.store.getSession(input.sessionId);
  if (session === undefined) {
    throw new ToolError('NOT_FOUND', `No session with id "${input.sessionId}" exists.`);
  }
  // Idempotency: check for an existing assignment before writing. The store
  // upsert is keyed on assignment.id (a UUID we'd generate), not on the
  // (session_id, planned_exercise_id / workout_template_id) tuple, so without
  // this guard a retry would accumulate a duplicate row. Mirrors the same
  // guard in completeWorkout.
  const existing = await state.store.getAssignmentsForSession(input.sessionId);
  if (input.plannedExerciseId !== undefined) {
    const prior = existing.find((a) => a.plannedExerciseId === input.plannedExerciseId);
    if (prior !== undefined) {
      return { assignment: prior };
    }
    const planned = await findPlannedExerciseById(state, input.plannedExerciseId);
    if (planned === undefined) {
      throw new ToolError(
        'NOT_FOUND',
        `No planned exercise with id "${input.plannedExerciseId}" exists.`,
      );
    }
    const assignment: StoredProgramAssignment = {
      id: randomUUID(),
      sessionId: input.sessionId,
      plannedExerciseId: input.plannedExerciseId,
      assignedAt: new Date().toISOString(),
    };
    await state.store.putProgramAssignment(assignment);
    return { assignment };
  }
  // workoutTemplateId branch — Zod's XOR refine guarantees this is defined
  // when plannedExerciseId is not, but TS can't see through the refine.
  const workoutTemplateId = input.workoutTemplateId as string;
  const priorTemplate = existing.find((a) => a.workoutTemplateId === workoutTemplateId);
  if (priorTemplate !== undefined) {
    return { assignment: priorTemplate };
  }
  const template = await state.store.getWorkoutTemplate(workoutTemplateId);
  if (template === undefined) {
    throw new ToolError('NOT_FOUND', `No workout template with id "${workoutTemplateId}" exists.`);
  }
  const assignment: StoredProgramAssignment = {
    id: randomUUID(),
    sessionId: input.sessionId,
    workoutTemplateId,
    assignedAt: new Date().toISOString(),
  };
  await state.store.putProgramAssignment(assignment);
  return { assignment };
}

async function suggestProgression(
  state: ServerState,
  input: z.infer<typeof PlanSuggestProgressionInput>,
): Promise<{
  plannedExercise: StoredPlannedExercise;
  suggestion: ProgressionSuggestion & { tier: SuggestionTier };
}> {
  // VW-92 consumer 1 of 3: the tier is read HERE, once, and passed into the
  // store-free heuristic — `computeProgressionDelta` never reads it itself.
  const tierSignal = await getTierSignal(state);
  const tier: SuggestionTier = {
    tier: tierSignal.tier,
    confidence: tierSignal.confidence,
    source: tierSignal.source,
  };
  const program = await resolveDefaultProgram(state, input.programId);
  const planned = await findPlannedExerciseInProgram(state, program.id, input.exerciseId);
  if (planned === undefined) {
    throw new ToolError(
      'NOT_FOUND',
      `No planned exercise with exerciseId "${input.exerciseId}" exists in program "${program.id}".`,
    );
  }

  // Pick the basis session: caller-supplied wins; otherwise the most-recent
  // session for the exercise (any program — progression tracking is
  // exercise-scoped, not program-scoped).
  const basisSessionId = await resolveBasisSession(state, input);

  if (basisSessionId === null) {
    return {
      plannedExercise: planned,
      suggestion: {
        delta: PROGRESSION_HOLD_LBS,
        repDelta: 0,
        reasoning: 'No prior session for this exercise; no progression suggestion.',
        basedOnSessionId: null,
        gates: { technique: 'unknown', effort: 'unknown', setsUnlocked: false },
        basis: 'fixed',
        tier,
      },
    };
  }

  // Scoped to the exercise being progressed, by each SET's own id. Unscoped,
  // `selectWorkingSets` would rank this exercise's loads against every other
  // movement in the basis session and keep only the session's heaviest — a
  // 135 lb bench alongside a 315 lb squat would be discarded as warm-ups and
  // the delta computed from the squat.
  // VW-169: drop the sets a guest did in this session before scoping to the
  // exercise — one session can hold both, and a guest's heavier top set would
  // otherwise set the owner's next load.
  const sessionSets = scopeSetsToLifter(
    await state.store.getSetsForSession(basisSessionId),
    input.lifter,
  );
  const sets = scopeSessionSetsToExerciseId(sessionSets, input.exerciseId);
  const suggestion = computeProgressionDelta(planned, sets, basisSessionId, {
    tier: tierSignal.tier,
  });
  return { plannedExercise: planned, suggestion: { ...suggestion, tier } };
}

/**
 * Pick the session id whose stored sets the progression heuristic reads from.
 * Caller-supplied `completedSessionId` wins (and must exist); otherwise the
 * most-recent session that recorded the same `exerciseId`. Returns null when
 * no candidate exists so the caller can short-circuit to a hold suggestion.
 */
async function resolveBasisSession(
  state: ServerState,
  input: z.infer<typeof PlanSuggestProgressionInput>,
): Promise<string | null> {
  if (input.completedSessionId !== undefined) {
    const session = await state.store.getSession(input.completedSessionId);
    if (session === undefined) {
      throw new ToolError('NOT_FOUND', `No session with id "${input.completedSessionId}" exists.`);
    }
    return input.completedSessionId;
  }
  // VMCP-01.72b (H1): pick the basis session by each SET's own exerciseId,
  // not `listSessions({ exerciseId })`'s session-row column — that column is
  // last-write-wins once a session can hold several exercises, so it would
  // silently miss a session that trained this exercise earlier and something
  // else more recently.
  //
  // VMCP-01.72b (S5): `getSetsForExercise` hydrates every rep of every
  // matching set — pulling a user's ENTIRE history for the exercise just to
  // read the last element's `sessionId` was the wrong shape (and unbounded).
  // `getMostRecentSessionIdForExercise` answers the actual question — "what
  // session was this exercise last trained in?" — with a single indexed
  // `ORDER BY started_at DESC LIMIT 1`, no reps loaded.
  //
  // VW-169: owner-only unless a lifter is named (the store applies the
  // default), so a guest's set — by definition the most recent one on a
  // shared rig — cannot become the owner's progression basis.
  return state.store.getMostRecentSessionIdForExercise({
    userId: LOCAL_USER_ID,
    exerciseId: input.exerciseId,
    ...(input.lifter !== undefined ? { lifter: input.lifter } : {}),
  });
}

/**
 * Aggregate per-set rep counts against the planned rep band, then map to a
 * single-step delta. Bands without `targetRepsLow` (i.e. plain "do X sets"
 * prescriptions) collapse to a hold — there's no objective basis to bump.
 * Only working sets (session top load) are scored; warmups are excluded.
 *
 * Exported (VW-120) so the dashboard's session-completion screen computes its
 * per-exercise recommendation from THIS function rather than a second copy of
 * the heuristic. The signature is deliberately store-free — planned row + that
 * exercise's sets + the basis session id — so any caller can supply them.
 */
export function computeProgressionDelta(
  planned: StoredPlannedExercise,
  sets: StoredSet[],
  basisSessionId: string,
  context: ProgressionContext = DEFAULT_PROGRESSION_CONTEXT,
): ProgressionSuggestion {
  if (planned.targetRepsLow === undefined) {
    return ungatedSuggestion(
      PROGRESSION_HOLD_LBS,
      'Planned exercise has no rep target; cannot suggest a load delta.',
      basisSessionId,
      context,
    );
  }
  if (sets.length === 0) {
    return ungatedSuggestion(
      PROGRESSION_DECREMENT_LBS,
      `Prior session has 0 completed sets (target ${planned.targetSets}); back off ${Math.abs(PROGRESSION_DECREMENT_LBS)} lb.`,
      basisSessionId,
      context,
    );
  }

  const workingSets = selectWorkingSets(sets);
  const tally = tallyRepBand(workingSets, planned.targetRepsLow, planned.targetRepsHigh);
  const gates = computeGates(workingSets, tally, context);
  const routed = routeSuggestion(tally, gates, context);
  return { ...enforceTechniqueGate(routed, gates), basedOnSessionId: basisSessionId, gates };
}

/** A verdict reached before any set could be scored: no gate has an input. */
function ungatedSuggestion(
  delta: number,
  reasoning: string,
  basisSessionId: string,
  context: ProgressionContext,
): ProgressionSuggestion {
  return {
    delta,
    repDelta: 0,
    reasoning,
    basedOnSessionId: basisSessionId,
    gates: { technique: context.technique ?? 'unknown', effort: 'unknown', setsUnlocked: false },
    basis: 'fixed',
  };
}

interface RepBandTally {
  setsCompleted: number;
  hitHigh: number;
  inBand: number;
  missed: number;
  /** Strict majority of completed sets; ties collapse to a hold. */
  majority: number;
  repsLow: number;
  repsHigh: number;
  bandLabel: string;
  maxLossPct: number;
  /** The load `workingSets` were taken at; undefined for an unweighted exercise. */
  topLoadLbs: number | undefined;
}

function tallyRepBand(
  workingSets: StoredSet[],
  targetRepsLow: number,
  targetRepsHigh: number | undefined,
): RepBandTally {
  const repsHigh = targetRepsHigh ?? targetRepsLow;
  let hitHigh = 0;
  let inBand = 0;
  let missed = 0;
  for (const set of workingSets) {
    const count = set.reps.length;
    if (count >= repsHigh) hitHigh += 1;
    else if (count >= targetRepsLow) inBand += 1;
    else missed += 1;
  }
  return {
    setsCompleted: workingSets.length,
    hitHigh,
    inBand,
    missed,
    majority: Math.floor(workingSets.length / 2) + 1,
    repsLow: targetRepsLow,
    repsHigh,
    bandLabel:
      targetRepsLow === repsHigh ? `${targetRepsLow} reps` : `${targetRepsLow}-${repsHigh} reps`,
    maxLossPct: Math.max(0, ...workingSets.map(setVelocityLossPct)),
    topLoadLbs: topLoadOf(workingSets),
  };
}

/**
 * `selectWorkingSets` already narrowed `workingSets` to the session's top
 * load (or left every weight undefined when none was recorded) — this just
 * reads that load back out for the B23 percent calculation.
 */
function topLoadOf(workingSets: StoredSet[]): number | undefined {
  const loads = workingSets.map((set) => set.weightLbs).filter((w): w is number => w !== undefined);
  return loads.length > 0 ? Math.max(...loads) : undefined;
}

/**
 * B07's three gates. Sets are the last thing to move: they unlock only once
 * load/reps are already producing genuinely hard sets, and never for a
 * beginner, who progresses load and technique instead.
 */
function computeGates(
  workingSets: StoredSet[],
  tally: RepBandTally,
  context: ProgressionContext,
): ProgressionGates {
  const effort = effortGate(workingSets, tally.maxLossPct);
  return {
    technique: context.technique ?? 'unknown',
    effort,
    setsUnlocked:
      context.tier !== 'beginner' && effort === 'hard' && tally.hitHigh >= tally.majority,
  };
}

function effortGate(workingSets: StoredSet[], maxLossPct: number): EffortGate {
  if (!workingSets.some(setCarriesVelocity)) return 'unknown';
  if (maxLossPct >= PROGRESSION_VELOCITY_LOSS_HOLD_PCT) return 'hard';
  if (maxLossPct <= PROGRESSION_EASY_LOSS_PCT) return 'easy';
  return 'unknown';
}

type RoutedSuggestion = Pick<ProgressionSuggestion, 'delta' | 'repDelta' | 'reasoning' | 'basis'>;

function routeSuggestion(
  tally: RepBandTally,
  gates: ProgressionGates,
  context: ProgressionContext,
): RoutedSuggestion {
  const { hitHigh, missed, setsCompleted, majority, repsLow, bandLabel } = tally;
  if (hitHigh >= majority) return routeHitHigh(tally, gates, context);
  if (missed >= majority) {
    return {
      delta: PROGRESSION_DECREMENT_LBS,
      repDelta: 0,
      reasoning: `${missed}/${setsCompleted} sets missed ${repsLow} reps (target ${bandLabel}); back off ${Math.abs(PROGRESSION_DECREMENT_LBS)} lb.`,
      basis: 'fixed',
    };
  }
  return {
    delta: PROGRESSION_HOLD_LBS,
    repDelta: 0,
    reasoning: `${tally.inBand}/${setsCompleted} sets landed in band (target ${bandLabel}); maintain load.`,
    basis: 'fixed',
  };
}

/**
 * The band was topped out. VMCP-02.25 holds first when the sets were already
 * near failure; otherwise B24 routes by range — load below the ceiling, reps
 * at or above it.
 */
function routeHitHigh(
  tally: RepBandTally,
  gates: ProgressionGates,
  context: ProgressionContext,
): RoutedSuggestion {
  const { hitHigh, setsCompleted, repsHigh, bandLabel, maxLossPct } = tally;
  const hit = `${hitHigh}/${setsCompleted} sets hit ${repsHigh}+ reps (target ${bandLabel})`;
  if (maxLossPct >= PROGRESSION_VELOCITY_LOSS_HOLD_PCT) {
    const unlock = gates.setsUnlocked ? ', sets unlocked: consider +1 set next session' : '';
    return {
      delta: PROGRESSION_HOLD_LBS,
      repDelta: 0,
      reasoning:
        `${hit}, but velocity dropped ${Math.round(maxLossPct)}% within a set ` +
        `(>= ${PROGRESSION_VELOCITY_LOSS_HOLD_PCT}% near-failure) — hold the load, don't add${unlock}.`,
      basis: 'fixed',
    };
  }
  if (repsHigh < REP_RANGE_LOAD_CEILING) {
    return loadIncrement(hit, tally.topLoadLbs, context);
  }
  return {
    delta: PROGRESSION_HOLD_LBS,
    repDelta: 1,
    reasoning: `${hit}; at ${REP_RANGE_LOAD_CEILING}+ reps the rep is the finer dial — hold the load and add 1 rep.`,
    basis: 'fixed',
  };
}

/**
 * B23: percent-of-load when a percent is cited, else the fixed step. Reads
 * the percent from `context.incrementPercent`, falling back to the
 * production constant when the caller's context didn't set the field at all
 * (same `?? `-on-omission pattern as `context.technique` below). Falls back
 * to fixed when the exercise carries no recorded load (a Damper/Band/
 * Isokinetic set) — there is no `topLoadLbs` to take a percent of.
 */
function loadIncrement(
  hit: string,
  topLoadLbs: number | undefined,
  context: ProgressionContext,
): RoutedSuggestion {
  const percent = context.incrementPercent ?? PROGRESSION_INCREMENT_PERCENT;
  if (percent === null || topLoadLbs === undefined) {
    return {
      delta: PROGRESSION_INCREMENT_LBS,
      repDelta: 0,
      reasoning: `${hit}; add ${PROGRESSION_INCREMENT_LBS} lb.`,
      basis: 'fixed',
    };
  }
  const delta = computePercentIncrement(topLoadLbs, percent);
  return {
    delta,
    repDelta: 0,
    reasoning: `${hit}; add ${percent}% of ${topLoadLbs} lb = ${delta} lb.`,
    basis: 'percent',
  };
}

/** B07 gate 1: nothing moves while technique is unstable. */
function enforceTechniqueGate(routed: RoutedSuggestion, gates: ProgressionGates): RoutedSuggestion {
  if (gates.technique !== 'unstable') return routed;
  if (routed.delta <= 0 && routed.repDelta <= 0) return routed;
  return {
    delta: Math.min(routed.delta, PROGRESSION_HOLD_LBS),
    repDelta: 0,
    reasoning: `${routed.reasoning} Technique is unstable — hold load and reps until it stabilises.`,
    basis: 'fixed',
  };
}

/**
 * Resolve the active session id by scanning ALL bound slots — not just
 * `primary`. A single-device setup has one slot (`primary`); a bilateral setup
 * binds `left` + `right` with no `primary`, so the old primary-only lookup
 * (VMCP-02.36, Bug #14) threw on the missing `primary` slot and surfaced a
 * false `NO_ACTIVE_SESSION`.
 *
 * Returns null when no slot has an active session (callers surface a clean
 * `NO_ACTIVE_SESSION`). A bilateral pair sharing one session id collapses to a
 * single value and resolves cleanly. When slots carry DISTINCT active sessions
 * (independent bilateral sessions) the choice is genuinely ambiguous, so we
 * throw `AMBIGUOUS_SESSION` directing the caller to pass an explicit
 * `sessionId` — the existing disambiguator on `plan.complete_workout`.
 */
function resolveActiveSessionId(state: ServerState): string | null {
  const sessionIds = new Set<string>();
  for (const slot of state.slots.values()) {
    const id = slot.live.session?.sessionId;
    if (id !== undefined) sessionIds.add(id);
  }
  if (sessionIds.size === 0) return null;
  if (sessionIds.size === 1) {
    const [only] = sessionIds;
    return only;
  }
  throw new ToolError(
    'AMBIGUOUS_SESSION',
    `Multiple active sessions across slots (${sessionIds.size}). ` +
      'Pass an explicit sessionId to plan.complete_workout to disambiguate.',
  );
}

/**
 * Walk a program's blocks/weeks/templates to find a planned exercise by the
 * caller-supplied exerciseId. Returns the first match — block-periodization
 * plans typically prescribe the same exercise across multiple weeks, but for
 * progression purposes we only need ONE planned row to read targets from.
 */
async function findPlannedExerciseInProgram(
  state: ServerState,
  programId: string,
  exerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  const blocks = await state.store.getTrainingBlocksForProgram(programId);
  for (const block of blocks) {
    const weeks = await state.store.getTrainingWeeksForBlock(block.id);
    for (const week of weeks) {
      const templates = await state.store.getWorkoutTemplatesForWeek(week.id);
      for (const template of templates) {
        const planned = await state.store.getPlannedExercisesForTemplate(template.id);
        const match = planned.find((p) => p.exerciseId === exerciseId);
        if (match !== undefined) return match;
      }
    }
  }
  return undefined;
}

/**
 * Locate a planned exercise by id without scanning every program. The store
 * has no direct `getPlannedExercise(id)` method (kept narrow in W3 — only
 * list-by-template was needed), so we walk every non-archived program. v1
 * acceptable cost; if call volume rises a direct getter is the right fix.
 */
async function findPlannedExerciseById(
  state: ServerState,
  plannedExerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  const programs = await state.store.listTrainingPrograms({ includeArchived: true });
  for (const program of programs) {
    const blocks = await state.store.getTrainingBlocksForProgram(program.id);
    for (const block of blocks) {
      const weeks = await state.store.getTrainingWeeksForBlock(block.id);
      for (const week of weeks) {
        const templates = await state.store.getWorkoutTemplatesForWeek(week.id);
        for (const template of templates) {
          const planned = await state.store.getPlannedExercisesForTemplate(template.id);
          const match = planned.find((p) => p.id === plannedExerciseId);
          if (match !== undefined) return match;
        }
      }
    }
  }
  return undefined;
}
