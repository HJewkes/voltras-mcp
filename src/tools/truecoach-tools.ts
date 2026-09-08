// `truecoach.import_week` — a read-only pull of the coach's assigned
// programming into the local `plan.*` tree.
//
// SCOPE, and nothing beyond it: this reads TrueCoach and writes SQLite. It
// never writes to TrueCoach, it never runs on its own (no timer, no startup
// hook, no channel subscription — the only entry point is this tool call), and
// it never summarises or reformats what the coach wrote. Coach text lands in
// `notes` verbatim; the target parser is a convenience layered on top of it,
// not a replacement for it.
//
// The plan tree it writes into: the caller's program (or the most recent
// non-archived one) gets a single block named "TrueCoach import", and that
// block gets one week per ISO week the imported workouts fall in. Both are
// created only when missing, so repeated imports accumulate weeks in one place
// instead of forking the tree.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
  isTrueCoachConfigured,
  TrueCoachClient,
  TRUECOACH_ENV_NAMES,
  type FetchedPages,
} from '../integrations/truecoach/client.js';
import { mapPlan, type MappedPlan, type MappedWorkout } from '../integrations/truecoach/map.js';
import { TrueCoachImportWeekInput } from '../schemas/truecoach.js';
import type { ServerState } from '../state/server-state.js';
import type {
  PlanImportExercise,
  PlanImportTemplate,
  StoredTrainingBlock,
  StoredTrainingWeek,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { resolveDefaultProgram } from './plan-tools.js';

/** The single block every TrueCoach import lands in, per program. */
const IMPORT_BLOCK_NAME = 'TrueCoach import';
const MS_PER_DAY = 86_400_000;

export const TRUECOACH_IMPORT_WEEK_DESCRIPTION =
  'Pull the coach-assigned workouts for a date range out of TrueCoach and upsert them into the ' +
  'local plan.* tree (program -> "TrueCoach import" block -> one week per ISO week -> workout ' +
  'template -> planned exercises). READ-ONLY against TrueCoach: this tool never writes, ' +
  'comments, or logs results there, and it runs only when you call it — there is no background ' +
  'sync. Credentials come from VMCP_TRUECOACH_USERNAME plus VMCP_TRUECOACH_PASSWORD or ' +
  'VMCP_TRUECOACH_PASSWORD_CMD; with none set it returns NOT_CONFIGURED and makes no network ' +
  'call. Idempotent — re-importing the same range updates rows in place via TrueCoach external ' +
  'ids and never duplicates. Exercise names must match the catalog exactly; anything else is ' +
  'reported in `unmapped` with candidates and skipped (the template still lands), and you can ' +
  'resolve it by passing `mapping: { "<TrueCoach name>": "<catalog exercise id>" }`. Use ' +
  'dryRun: true to see the mapped tree before writing. ToS note: TrueCoach publishes no API and ' +
  'its terms prohibit third-party applications that interact with the service without written ' +
  "consent. This is a client-role read of the user's OWN data on their own account, run by " +
  'hand; the coach has not been asked for consent yet. Do not present it as a sanctioned ' +
  'integration.';

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

/** Test seams: a stub fetcher and a fixed clock, so no test can reach the network. */
export interface TrueCoachToolDeps {
  readonly fetchPages?: (refresh: boolean) => Promise<FetchedPages>;
  readonly now?: () => Date;
}

export function registerTrueCoachTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('truecoach.import_week');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: truecoach.import_week');
  }
  tool.update({
    paramsSchema: TrueCoachImportWeekInput.shape,
    callback: wrapHandler(TrueCoachImportWeekInput, (input) => importWeek(state, input)) as never,
    description: TRUECOACH_IMPORT_WEEK_DESCRIPTION,
  } as never);
}

/** Exported for tests; the tool callback is the only production caller. */
export async function importWeek(
  state: ServerState,
  input: z.infer<typeof TrueCoachImportWeekInput>,
  deps: TrueCoachToolDeps = {},
): Promise<unknown> {
  const range = resolveRange(input, (deps.now ?? (() => new Date()))());
  const fetched = await fetchPages(state, input.refresh === true, deps);
  const plan = mapPlan(fetched.pages, {
    from: range.from,
    to: range.to,
    catalog: state.exercises,
    mapping: input.mapping ?? {},
  });
  if (input.dryRun === true) {
    return { dryRun: true, range, cacheHit: fetched.cacheHit, ...describe(plan) };
  }
  const week = await resolveWeeks(state, input.programId, plan);
  const result = await state.store.importPlanTree(toImportBatch(plan, week));
  return { ...result, unmapped: plan.unmapped, cacheHit: fetched.cacheHit, range };
}

async function fetchPages(
  state: ServerState,
  refresh: boolean,
  deps: TrueCoachToolDeps,
): Promise<FetchedPages> {
  if (deps.fetchPages !== undefined) return await deps.fetchPages(refresh);
  const config = state.config.trueCoach;
  if (!isTrueCoachConfigured(config)) {
    throw new ToolError(
      'NOT_CONFIGURED',
      `TrueCoach credentials are not set. Export ${TRUECOACH_ENV_NAMES[0]} and either ` +
        `${TRUECOACH_ENV_NAMES[1]} or ${TRUECOACH_ENV_NAMES[2]} (a shell command whose stdout ` +
        'is the password), then call this tool again.',
    );
  }
  return await new TrueCoachClient(config).fetchWorkoutPages({ refresh });
}

/** The dry-run view: the tree that would be written, with nothing written. */
function describe(plan: MappedPlan): Record<string, unknown> {
  return {
    weeks: plan.weeks,
    unmapped: plan.unmapped,
    workouts: plan.workouts.map((w) => ({
      externalId: w.externalId,
      name: w.name,
      dayLabel: w.dayLabel,
      isoWeek: w.isoWeek,
      notes: w.notes,
      exercises: w.exercises.map((e) => ({
        externalId: e.externalId,
        sourceName: e.sourceName,
        exerciseId: e.exerciseId,
        orderIndex: e.orderIndex,
        ...e.targets,
        targetSets: e.targetSets,
      })),
    })),
  };
}

/** ISO week label -> the training week row it maps to, creating rows only when missing. */
async function resolveWeeks(
  state: ServerState,
  programId: string | undefined,
  plan: MappedPlan,
): Promise<Map<string, string>> {
  const program = await resolveDefaultProgram(state, programId);
  const block = await ensureImportBlock(state, program.id, plan.weeks.length);
  const existing = await state.store.getTrainingWeeksForBlock(block.id);
  const byName = new Map(existing.map((w) => [w.name ?? '', w.id]));
  let nextIndex = existing.length;
  for (const label of plan.weeks) {
    if (byName.has(label)) continue;
    const week: StoredTrainingWeek = {
      id: randomUUID(),
      blockId: block.id,
      orderIndex: nextIndex,
      name: label,
    };
    await state.store.putTrainingWeek(week);
    byName.set(label, week.id);
    nextIndex += 1;
  }
  return byName;
}

/**
 * The program's one import block, found by name. Its `weeksCount` grows to
 * cover the weeks actually present — the column is NOT NULL and the block is
 * open-ended, so it tracks reality rather than declaring a fixed mesocycle.
 */
async function ensureImportBlock(
  state: ServerState,
  programId: string,
  weekCount: number,
): Promise<StoredTrainingBlock> {
  const blocks = await state.store.getTrainingBlocksForProgram(programId);
  const found = blocks.find((b) => b.name === IMPORT_BLOCK_NAME);
  const weeks = await (found === undefined
    ? Promise.resolve([])
    : state.store.getTrainingWeeksForBlock(found.id));
  const block: StoredTrainingBlock = {
    id: found?.id ?? randomUUID(),
    programId,
    orderIndex: found?.orderIndex ?? blocks.length,
    name: IMPORT_BLOCK_NAME,
    weeksCount: Math.max(1, weeks.length, weekCount),
    notes: "Imported from TrueCoach. Coach text is kept verbatim in each row's notes.",
  };
  await state.store.putTrainingBlock(block);
  return block;
}

function toImportBatch(plan: MappedPlan, weekIds: Map<string, string>): PlanImportTemplate[] {
  const batch: PlanImportTemplate[] = [];
  for (const [index, workout] of plan.workouts.entries()) {
    const weekId = weekIds.get(workout.isoWeek);
    if (weekId === undefined) continue;
    batch.push(toImportTemplate(workout, weekId, index));
  }
  return batch;
}

function toImportTemplate(
  workout: MappedWorkout,
  weekId: string,
  orderIndex: number,
): PlanImportTemplate {
  const template: PlanImportTemplate = {
    externalId: workout.externalId,
    weekId,
    dayLabel: workout.dayLabel,
    name: workout.name,
    orderIndex,
    exercises: workout.exercises.map(toImportExercise),
  };
  if (workout.notes !== undefined) template.notes = workout.notes;
  return template;
}

function toImportExercise(exercise: MappedWorkout['exercises'][number]): PlanImportExercise {
  const out: PlanImportExercise = {
    externalId: exercise.externalId,
    exerciseId: exercise.exerciseId,
    orderIndex: exercise.orderIndex,
    targetSets: exercise.targetSets,
  };
  const { targetRepsLow, targetRepsHigh, targetWeightLbs, restSec } = exercise.targets;
  if (targetRepsLow !== undefined) out.targetRepsLow = targetRepsLow;
  if (targetRepsHigh !== undefined) out.targetRepsHigh = targetRepsHigh;
  if (targetWeightLbs !== undefined) out.targetWeightLbs = targetWeightLbs;
  if (restSec !== undefined) out.restSec = restSec;
  if (exercise.notes !== undefined) out.notes = exercise.notes;
  return out;
}

export interface ImportRange {
  readonly from: string;
  readonly to: string;
}

/**
 * The range to import. Defaults to the ISO week containing `now` (Monday
 * through Sunday) — "import_week" with no argument should mean this week, and
 * a coach assigns work a week at a time.
 */
export function resolveRange(
  input: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: Date,
): ImportRange {
  if (input.from !== undefined && input.to !== undefined) {
    if (input.from > input.to) {
      throw new ToolError('INVALID_INPUT', `from (${input.from}) is after to (${input.to}).`);
    }
    return { from: input.from, to: input.to };
  }
  const monday = startOfIsoWeek(now);
  return {
    from: input.from ?? isoDate(monday),
    to: input.to ?? isoDate(new Date(monday.getTime() + 6 * MS_PER_DAY)),
  };
}

/** Midnight UTC on the Monday of `now`'s week, from `now`'s LOCAL calendar date. */
function startOfIsoWeek(now: Date): Date {
  const utc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayOfWeek = (utc.getUTCDay() + 6) % 7;
  return new Date(utc.getTime() - dayOfWeek * MS_PER_DAY);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
