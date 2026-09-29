// Every audited action stays inside one event-loop turn (VW-660, VW-512 S4).
//
// An audited action runs inside `store.transaction`, and a transaction that spans a turn lets
// other work on the shared connection (a BLE rep write, an MCP tool call, a dashboard read) run
// while it is open. That work throws `STORE_TRANSACTION_BUSY` rather than joining. So each
// allowlisted action and each plan-builder route runs here under two probes: a `setImmediate`
// queued before the action starts must not fire before it settles, and a store read from that
// callback must not be refused. A new allowlist entry without a case below fails the test.
//
// Mock adapter, in-memory store, synthetic rows.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_ALLOWLIST } from '../allowlist.js';
import { captureActionHandlers, type CapturedTools } from '../capture-handlers.js';
import {
  executeAction,
  executeAudited,
  hashInput,
  type ActionOutcome,
  type HandlerOutcome,
} from '../execute.js';
import { loadConfig } from '../../config.js';
import {
  createPlannedExercise,
  createProgramWithScaffold,
  createWorkout,
  deletePlannedExercise,
  reorderPlannedExercises,
  updatePlannedExercise,
} from '../../dashboard/plan-api.js';
import { log } from '../../logger.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, type StoredRep } from '../../store/types.js';
import { registerPlanTools } from '../../tools/plan-tools.js';

const TODAY = '2026-09-16T12:00:00.000Z';
const THIS_MONDAY = '2026-09-14';
const savedEnv = { ...process.env };

let state: ServerState;
let tools: CapturedTools;
let actionSeq = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TODAY));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  tools = captureActionHandlers(state);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await state.store.close();
  process.env = { ...savedEnv };
});

/** Run a `plan-tools` handler to seed rows, the way the coach would have written them. */
async function seedWithPlanTool(name: string, input: unknown): Promise<void> {
  let handler: ((args: unknown) => Promise<{ isError?: boolean }>) | undefined;
  const recorder = {
    get: (toolName: string) => ({
      update(updates: { callback?: unknown }): void {
        if (toolName === name) handler = updates.callback as typeof handler;
      },
    }),
  };
  registerPlanTools(
    undefined as unknown as McpServer,
    state,
    recorder as unknown as Parameters<typeof registerPlanTools>[2],
  );
  const result = await handler!(input);
  expect(result.isError, `seeding ${name} failed`).not.toBe(true);
}

async function seedDatedBlock(): Promise<void> {
  await seedWithPlanTool('plan.program.create', { id: 'prog-1', name: 'Synthetic program' });
  await seedWithPlanTool('plan.block.create', {
    id: 'block-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Synthetic block',
    weeksCount: 3,
    startsOn: THIS_MONDAY,
  });
}

async function seedSession(): Promise<void> {
  await state.store.putSession({ id: 'sess-1', startedAt: TODAY, kind: 'training' });
}

interface ActionCase {
  seed?: () => Promise<void>;
  /** Read after `seed`, so an input can name a row the seed wrote. */
  input: () => unknown;
}

const ACTION_CASES: Record<string, ActionCase> = {
  'profile.log_bodyweight': { input: () => ({ bodyweightLbs: 180 }) },
  'profile.log_weekly_checkin': { input: () => ({ hunger: 'medium', sleepQuality: 'high' }) },
  'session.checkin': {
    seed: seedSession,
    input: () => ({ sessionId: 'sess-1', answers: [{ code: 'next', value: 'medium' }] }),
  },
  'goal.accept_target': {
    seed: seedProposedTarget,
    input: () => ({ targetId: proposedTargetId }),
  },
  'goal.weekly_review': { input: () => ({ weekOf: THIS_MONDAY }) },
  'plan.week.skip': { seed: seedDatedBlock, input: () => ({ blockId: 'block-1', week: 1 }) },
  'profile.respond_recomp_advisory': {
    seed: seedDatedBlock,
    input: () => ({ response: 'declined' }),
  },
  'profile.set_diet_phase': { input: () => ({ phase: 'maintenance' }) },
};

let proposedTargetId = '';

/** Eight reps with empty phases: enough for a lift to count as trained, nothing more. */
function syntheticReps(setId: string): StoredRep[] {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 1000,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return Array.from({ length: 8 }, (_, index) => ({
    repNumber: index + 1,
    concentric: phase,
    eccentric: phase,
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  }));
}

/** One trained session of a catalog lift, then a proposal for it: a cold starting ramp. */
async function seedProposedTarget(): Promise<void> {
  const exerciseId = state.exercises.list()[0].id;
  const at = '2026-09-09T12:00:00.000Z';
  await state.store.putSession({ kind: 'training', id: 'sess-lift', startedAt: at, endedAt: at });
  await state.store.putSet({
    id: 'set-lift',
    sessionId: 'sess-lift',
    userId: LOCAL_USER_ID,
    exerciseId,
    startedAt: at,
    endedAt: at,
    partial: false,
    weightLbs: 135,
    setPurpose: 'working',
    reps: syntheticReps('set-lift'),
  });
  const declared = await callCaptured('goal.declare_priorities', {
    items: [{ kind: 'lift', ref: exerciseId, level: 'specialize' }],
    horizonWeeks: 6,
  });
  const priorityId = (declared.priorities as { id: string }[])[0].id;
  const proposed = await callCaptured('goal.propose_targets', { priorityId });
  proposedTargetId = (proposed.targets as { targetId: string }[])[0].targetId;
}

async function callCaptured(name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await tools.get(name)!.handler(input);
  const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
  expect(result.isError, `seeding ${name} failed: ${JSON.stringify(body)}`).not.toBe(true);
  return body;
}

interface TurnProbe {
  turned: boolean;
  refused: unknown;
}

/**
 * Queue a callback for the next event-loop turn that records whether it fired and whether a
 * store read from it was refused. Queued before the action starts, so it can only fire
 * mid-action if the action yields.
 */
function armTurnProbe(): { probe: TurnProbe; disarm: () => void } {
  const probe: TurnProbe = { turned: false, refused: undefined };
  const immediate = setImmediate(() => {
    probe.turned = true;
    state.store.getSession('sess-probe').catch((err: unknown) => (probe.refused = err));
  });
  return { probe, disarm: () => clearImmediate(immediate) };
}

/**
 * The shape S3 wires into `executeAudited`: claim, handler and completion inside one
 * `store.transaction`, asserted to settle before the next event-loop turn.
 */
async function runInOneTurn(run: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
  const warn = vi.spyOn(log, 'warn');
  const { probe, disarm } = armTurnProbe();
  let outcome: ActionOutcome;
  try {
    outcome = await state.store.transaction(run);
  } finally {
    disarm();
  }
  expect(probe.turned, 'the action spanned an event-loop turn').toBe(false);
  expect(probe.refused, 'a foreign store read was refused mid-action').toBeUndefined();
  expect(JSON.stringify(outcome.body)).not.toContain('STORE_TRANSACTION');
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('event-loop turn'));
  return outcome;
}

function nextActionId(): string {
  actionSeq += 1;
  return `act-${actionSeq}`;
}

describe('every allowlisted action settles inside one event-loop turn', () => {
  it('has a case for every allowlist entry, and none for a name off it', () => {
    expect(Object.keys(ACTION_CASES).sort()).toEqual(Object.keys(ACTION_ALLOWLIST).sort());
  });

  it.each(Object.keys(ACTION_ALLOWLIST))('%s', async (name) => {
    const actionCase = ACTION_CASES[name];
    expect(actionCase, `${name} has no no-yield case`).toBeDefined();
    await actionCase.seed?.();
    const input = actionCase.input();

    const outcome = await runInOneTurn(() =>
      executeAction(
        { name, actionId: nextActionId(), actor: 'user', surface: 'wall', input },
        { store: state.store, tools, now: () => new Date() },
      ),
    );

    expect(outcome.body, JSON.stringify(outcome.body)).toMatchObject({ ok: true });
  });
});

interface PlanFixture {
  programId: string;
  templateId: string;
  plannedExerciseIds: string[];
}

async function seedPlanTree(): Promise<PlanFixture> {
  const scaffold = await createProgramWithScaffold(state.store, { name: 'Synthetic plan' });
  const templateId = scaffold.template.id;
  const plannedExerciseIds: string[] = [];
  for (const exerciseId of ['bench-press', 'lat-pulldown']) {
    const created = await createPlannedExercise(state.store, templateId, { exerciseId });
    plannedExerciseIds.push(created.plannedExercise.id);
  }
  return { programId: scaffold.program.id, templateId, plannedExerciseIds };
}

const PLAN_ROUTE_CASES: Record<string, (plan: PlanFixture) => Promise<unknown>> = {
  'plan.program.create': () => createProgramWithScaffold(state.store, { name: 'Another plan' }),
  'plan.workout.create': (plan) => createWorkout(state.store, plan.programId, { name: 'B' }),
  'plan.exercise.create': (plan) =>
    createPlannedExercise(state.store, plan.templateId, { exerciseId: 'row' }),
  'plan.exercise.reorder': (plan) =>
    reorderPlannedExercises(state.store, plan.templateId, {
      plannedExerciseIds: [...plan.plannedExerciseIds].reverse(),
    }),
  'plan.exercise.update': (plan) =>
    updatePlannedExercise(state.store, plan.plannedExerciseIds[0], { targetSets: 4 }),
  'plan.exercise.delete': (plan) => deletePlannedExercise(state.store, plan.plannedExerciseIds[1]),
};

describe('every plan-builder route settles inside one event-loop turn', () => {
  it('covers all six routes', () => {
    expect(Object.keys(PLAN_ROUTE_CASES)).toHaveLength(6);
  });

  it.each(Object.keys(PLAN_ROUTE_CASES))('%s', async (actionName) => {
    const plan = await seedPlanTree();
    const run = async (): Promise<HandlerOutcome> => ({
      ok: true,
      result: await PLAN_ROUTE_CASES[actionName](plan),
    });

    const outcome = await runInOneTurn(() =>
      executeAudited(
        {
          actionName,
          actionId: nextActionId(),
          actor: 'user',
          surface: 'wall',
          inputHash: hashInput({ route: actionName }),
          run,
        },
        { store: state.store, tools, now: () => new Date() },
      ),
    );

    expect(outcome.body, JSON.stringify(outcome.body)).toMatchObject({ ok: true });
  });
});
