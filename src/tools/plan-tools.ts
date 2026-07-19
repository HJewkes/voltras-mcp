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
import { peakConcentricBaseline } from '../state/channel-payloads.js';
import { type ServerState } from '../state/server-state.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSet,
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

  // progression / session-link tools
  install(
    placeholders,
    'plan.next_workout',
    PlanNextWorkoutInput,
    wrapHandler(PlanNextWorkoutInput, (input) => nextWorkout(state, input)),
  );
  install(
    placeholders,
    'plan.complete_workout',
    PlanCompleteWorkoutInput,
    wrapHandler(PlanCompleteWorkoutInput, (input) => completeWorkout(state, input)),
  );
  install(
    placeholders,
    'plan.attach_to_session',
    PlanAttachToSessionInput,
    wrapHandler(PlanAttachToSessionInput, (input) => attachToSession(state, input)),
  );
  install(
    placeholders,
    'plan.suggest_progression',
    PlanSuggestProgressionInput,
    wrapHandler(PlanSuggestProgressionInput, (input) => suggestProgression(state, input)),
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
 * VMCP-02.25: velocity-loss ceiling above which a set that *hit its rep target*
 * is treated as taken to/near functional failure — so the heuristic holds the
 * load instead of adding weight. VBT autoregulation commonly reads ~20% loss as
 * moderate fatigue and ~30%+ as high/near-failure; 25% is the conservative
 * "this set was already hard — don't add load" line. (The 2026-05-18 bench set
 * hit its reps at ~49% loss yet the rep-band-only heuristic recommended +5 lb.)
 */
const PROGRESSION_VELOCITY_LOSS_HOLD_PCT = 25;

/**
 * Peak-to-last concentric velocity loss (%) for one set, using the same
 * peak-baseline definition as the `velocity_loss_exceeded` channel event
 * (baseline = highest peak concentric velocity in the set, which sidesteps the
 * rep-1 setup-pause artifact). Returns 0 when the set is too short or carries no
 * velocity telemetry to judge — i.e. "no fatigue signal", never a false override.
 */
function setVelocityLossPct(set: StoredSet): number {
  if (set.reps.length < 2) return 0;
  const baseline = peakConcentricBaseline(set.reps);
  if (baseline <= 0) return 0;
  const last = set.reps[set.reps.length - 1].concentric.peakVelocity;
  if (last >= baseline) return 0;
  return (100 * (baseline - last)) / baseline;
}

/**
 * Resolve the program a progression-tool call refers to. If `programId` is
 * supplied, fetch + verify it exists. Otherwise, pick the most-recent
 * non-archived program (the store returns rows ordered by `created_at DESC`).
 * Throws `NO_PROGRAM_FOUND` when no eligible program exists.
 */
async function resolveDefaultProgram(
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

async function nextWorkout(
  state: ServerState,
  input: z.infer<typeof PlanNextWorkoutInput>,
): Promise<
  | {
      template: StoredWorkoutTemplate;
      plannedExercises: StoredPlannedExercise[];
      block: StoredTrainingBlock;
      week: StoredTrainingWeek;
    }
  | { ok: true; completed: true }
> {
  const program = await resolveDefaultProgram(state, input.programId);
  const blocks = await state.store.getTrainingBlocksForProgram(program.id);
  for (const block of blocks) {
    const weeks = await state.store.getTrainingWeeksForBlock(block.id);
    for (const week of weeks) {
      const templates = await state.store.getWorkoutTemplatesForWeek(week.id);
      for (const template of templates) {
        const assignments = await state.store.getAssignmentsForTemplate(template.id);
        if (assignments.length === 0) {
          const plannedExercises = await state.store.getPlannedExercisesForTemplate(template.id);
          return { template, plannedExercises, block, week };
        }
      }
    }
  }
  return { ok: true, completed: true };
}

async function completeWorkout(
  state: ServerState,
  input: z.infer<typeof PlanCompleteWorkoutInput>,
): Promise<{ assignment: StoredProgramAssignment }> {
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
  // Idempotency: if an assignment already exists for this (session, template)
  // pair, return the existing row rather than writing a duplicate. The store
  // upsert is keyed on assignment.id (a UUID we'd generate), not on the
  // (session_id, workout_template_id) tuple, so without this check we'd
  // accumulate duplicate rows on retry.
  const existing = await state.store.getAssignmentsForSession(sessionId);
  const prior = existing.find((a) => a.workoutTemplateId === input.workoutTemplateId);
  if (prior !== undefined) {
    return { assignment: prior };
  }
  const assignment: StoredProgramAssignment = {
    id: randomUUID(),
    sessionId,
    workoutTemplateId: input.workoutTemplateId,
    assignedAt: new Date().toISOString(),
  };
  await state.store.putProgramAssignment(assignment);
  return { assignment };
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
  suggestion: { delta: number; reasoning: string; basedOnSessionId: string | null };
}> {
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
        reasoning: 'No prior session for this exercise; no progression suggestion.',
        basedOnSessionId: null,
      },
    };
  }

  const sets = await state.store.getSetsForSession(basisSessionId);
  const suggestion = computeProgressionDelta(planned, sets, basisSessionId);
  return { plannedExercise: planned, suggestion };
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
  const recent = await state.store.listSessions({
    exerciseId: input.exerciseId,
    sort: 'startedAt:desc',
    limit: 1,
  });
  return recent[0]?.id ?? null;
}

/**
 * Non-working and working sets flow through the same `set.start`/`set.end`
 * path. Two signals select the working sets, applied in order:
 *
 *   1. The explicit `StoredSet.role` marker (set at `set.start`). Only
 *      `role === 'working'` (absent ⇒ working) is scored — a `'warmup'` set is
 *      never a working set, even a heavy primer at working weight that the load
 *      heuristic below would wrongly keep, and future non-working roles
 *      (`'backoff'`, `'dropset'`) fall out here for free.
 *   2. Session-relative top load, for the (still common) unmarked warmups: a
 *      warmup is a sub-working-weight ramp-up, so treat the sets at the
 *      session's heaviest load as the working sets — the ones the rep band is
 *      actually prescribed against.
 *
 * Judging progression on the full set list lets light, low-rep warmups inflate
 * the "missed" tally into a bogus deload (VMCP-progression-warmups), and a
 * single high-velocity-loss warmup can suppress a legit +5. Session-relative
 * top load (not `targetWeightLbs`) tracks the load actually lifted, even after
 * the plan's original target has been outgrown.
 */
function selectWorkingSets(sets: StoredSet[]): StoredSet[] {
  const working = sets.filter((set) => (set.role ?? 'working') === 'working');
  if (working.length === 0) return working;
  const topLoad = Math.max(...working.map((set) => set.weightLbs));
  return working.filter((set) => set.weightLbs >= topLoad);
}

/**
 * Aggregate per-set rep counts against the planned rep band, then map to a
 * single-step delta. Bands without `targetRepsLow` (i.e. plain "do X sets"
 * prescriptions) collapse to a hold — there's no objective basis to bump.
 * Only working sets (session top load) are scored; warmups are excluded.
 */
function computeProgressionDelta(
  planned: StoredPlannedExercise,
  sets: StoredSet[],
  basisSessionId: string,
): { delta: number; reasoning: string; basedOnSessionId: string | null } {
  if (planned.targetRepsLow === undefined) {
    return {
      delta: PROGRESSION_HOLD_LBS,
      reasoning: 'Planned exercise has no rep target; cannot suggest a load delta.',
      basedOnSessionId: basisSessionId,
    };
  }
  if (sets.length === 0) {
    return {
      delta: PROGRESSION_DECREMENT_LBS,
      reasoning: `Prior session has 0 completed sets (target ${planned.targetSets}); back off ${Math.abs(PROGRESSION_DECREMENT_LBS)} lb.`,
      basedOnSessionId: basisSessionId,
    };
  }

  const workingSets = selectWorkingSets(sets);
  const setsCompleted = workingSets.length;
  const repsLow = planned.targetRepsLow;
  const repsHigh = planned.targetRepsHigh ?? repsLow;
  let hitHigh = 0;
  let inBand = 0;
  let missed = 0;
  for (const set of workingSets) {
    const count = set.reps.length;
    if (count >= repsHigh) hitHigh += 1;
    else if (count >= repsLow) inBand += 1;
    else missed += 1;
  }

  // "Most" = strict majority of completed sets. Ties (e.g. 1 hit / 1 miss)
  // collapse to hold to avoid oscillating recommendations across sessions.
  const majority = Math.floor(setsCompleted / 2) + 1;
  const bandLabel = repsLow === repsHigh ? `${repsLow} reps` : `${repsLow}-${repsHigh} reps`;
  if (hitHigh >= majority) {
    // VMCP-02.25: layer VBT on top of the rep-band check. Hitting the rep
    // target at high intra-set velocity loss means the load was already at/near
    // functional failure — adding weight would accumulate misload week over
    // week. Hold instead of incrementing when any set crossed the ceiling.
    const maxLossPct = Math.max(0, ...workingSets.map(setVelocityLossPct));
    if (maxLossPct >= PROGRESSION_VELOCITY_LOSS_HOLD_PCT) {
      return {
        delta: PROGRESSION_HOLD_LBS,
        reasoning:
          `${hitHigh}/${setsCompleted} sets hit ${repsHigh}+ reps (target ${bandLabel}), ` +
          `but velocity dropped ${Math.round(maxLossPct)}% within a set ` +
          `(>= ${PROGRESSION_VELOCITY_LOSS_HOLD_PCT}% near-failure) — hold the load, don't add.`,
        basedOnSessionId: basisSessionId,
      };
    }
    return {
      delta: PROGRESSION_INCREMENT_LBS,
      reasoning: `${hitHigh}/${setsCompleted} sets hit ${repsHigh}+ reps (target ${bandLabel}); add ${PROGRESSION_INCREMENT_LBS} lb.`,
      basedOnSessionId: basisSessionId,
    };
  }
  if (missed >= majority) {
    return {
      delta: PROGRESSION_DECREMENT_LBS,
      reasoning: `${missed}/${setsCompleted} sets missed ${repsLow} reps (target ${bandLabel}); back off ${Math.abs(PROGRESSION_DECREMENT_LBS)} lb.`,
      basedOnSessionId: basisSessionId,
    };
  }
  return {
    delta: PROGRESSION_HOLD_LBS,
    reasoning: `${inBand}/${setsCompleted} sets landed in band (target ${bandLabel}); maintain load.`,
    basedOnSessionId: basisSessionId,
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
