// The planning sitting (VW-476): the brief, the prompt at every site that carries it, and the
// block a declaration defaults to. Runs on the owner's plan shape, clock pinned to Saturday
// 2026-09-19 unless a test moves it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLANNING_PROMPT } from '../../plan/current-block.js';
import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { registerPlanTools } = await import('../plan-tools.js');
const { registerGoalTools } = await import('../goal-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Body = Record<string, unknown>;

let store: SqliteSessionStore;
let callbacks: Map<string, Callback>;

function at(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-09-19T12:00:00.000Z');
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
  const state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.') || name.startsWith('goal.')).map(
      (name) => [
        name,
        {
          update: (u: { callback: Callback }) => callbacks.set(name, u.callback),
          remove: () => {},
        },
      ],
    ),
  );
  registerPlanTools({} as never, state, placeholders as never);
  registerGoalTools({} as never, state, placeholders as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function call(name: string, args: unknown): Promise<Body> {
  const result = await callbacks.get(name)!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Body;
}

async function move(blockId: string, startsOn: string, reason?: string): Promise<void> {
  const live = await store.getLiveBlockSchedule(blockId);
  await store.appendBlockSchedule({
    ...live!,
    startsOn,
    kind: 'moved',
    declaredAt: '2026-09-02T12:00:00.000Z',
    ...(reason !== undefined ? { reason } : {}),
  });
}

describe('plan.block.planning_brief', () => {
  // VW-489: the brief's "days trained" excludes unreviewed history, so the sitting
  // has to be told what is being withheld before it plans against a zero.
  it('says how many past days are waiting on a review', async () => {
    const at = '2026-09-10T15:00:00.000Z';
    await store.putSession({ id: 'unreviewed', startedAt: at, endedAt: at });
    await store.putSet({
      id: 'unreviewed-set',
      sessionId: 'unreviewed',
      startedAt: at,
      endedAt: at,
      partial: false,
      reps: [],
    });

    const brief = await call('plan.block.planning_brief', {});

    expect(brief.unreviewedDays).toBe(1);
    expect(brief.unreviewedDayList).toEqual(['2026-09-10']);
  });

  it("suggests a Monday start and the real program's next block for an undated store", async () => {
    const brief = await call('plan.block.planning_brief', {});

    expect(brief).toMatchObject({
      state: 'undated_only',
      finishing: null,
      next: { block: { name: 'Block 2 — Orientation' } },
    });
    expect(brief.suggested).toEqual({
      startsOn: '2026-09-21',
      endsOn: '2026-10-04',
      weeksCount: 2,
      deloadWeek: null,
      basis: 'the first Monday from today, counting today when it is a Monday',
    });
    expect(brief.conflicts).toEqual([]);
    expect(brief.dietPhase).toBeNull();
    expect(brief.planning).toMatchObject({ due: true, prompt: PLANNING_PROMPT });
  });

  it('suggests today on a Monday, even with a session already logged today', async () => {
    at('2026-09-21T18:00:00.000Z');
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'monday',
      startedAt: '2026-09-21T15:00:00.000Z',
      endedAt: '2026-09-21T16:00:00.000Z',
    });

    const brief = await call('plan.block.planning_brief', {});

    expect(brief).toMatchObject({ suggested: { startsOn: '2026-09-21' } });
  });

  it('reads the finishing block and suggests the Monday after it ends', async () => {
    await dateBlock(store, 'b1', '2026-09-07', 4);

    const brief = await call('plan.block.planning_brief', {});

    expect(brief).toMatchObject({
      finishing: {
        block: { id: 'b1' },
        trained: { templatesPlanned: 2, templatesDone: 1, trainingDays: ['2026-09-07'] },
      },
      next: { block: { id: 'b2' } },
      suggested: { startsOn: '2026-10-05', weeksCount: 2 },
    });
  });

  it('carries the history fact of a block that moved twice', async () => {
    await dateBlock(store, 'b2', '2026-09-28', 2);
    await move('b2', '2026-10-05');
    await move('b2', '2026-10-12', 'travel');

    const brief = await call('plan.block.planning_brief', {});

    expect(brief).toMatchObject({
      next: {
        history: {
          moves: 2,
          fact: 'This block has moved twice: first planned for Mon 28 Sep, now Mon 12 Oct (travel).',
        },
      },
      suggested: { startsOn: '2026-10-12' },
    });
  });

  it('names a dated block the suggested range would overlap', async () => {
    await dateBlock(store, 'b1', '2026-09-07', 4);
    await dateBlock(store, 'discovery', '2026-10-12', 1);

    const brief = await call('plan.block.planning_brief', {});

    expect(brief).toMatchObject({
      next: { block: { id: 'b2' } },
      suggested: { startsOn: '2026-10-05' },
    });
    expect(brief.conflicts).toEqual(['"Discovery Block" runs 2026-10-12 to 2026-10-18.']);
  });

  it('shows the declared diet phase', async () => {
    await store.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'maintenance',
      startedAt: '2026-09-01T00:00:00.000Z',
      declaredAt: '2026-09-01T00:00:00.000Z',
    });

    const brief = await call('plan.block.planning_brief', {});

    expect(brief.dietPhase).toMatchObject({ phase: 'maintenance', recompMode: null });
  });

  it('writes nothing', async () => {
    await call('plan.block.planning_brief', {});

    expect(await store.listLiveBlockSchedules()).toEqual([]);
    expect(await store.listPriorities(LOCAL_USER_ID)).toEqual([]);
  });
});

describe('the planning prompt at every site', () => {
  it('plan.next_workout carries it when planning is due', async () => {
    const next = await call('plan.next_workout', {});

    expect(next.planning).toMatchObject({ due: true, prompt: PLANNING_PROMPT });
  });

  it('plan.next_workout carries no prompt mid-block', async () => {
    await dateBlock(store, 'b1', '2026-09-14', 4);

    const next = await call('plan.next_workout', {});

    expect(next.planning).toMatchObject({ due: false, prompt: null });
  });

  it('plan.complete_workout carries it on its current-block read', async () => {
    const done = await call('plan.complete_workout', {
      workoutTemplateId: 'day-a',
      sessionId: 'sess-day-b',
    });

    expect(done).toMatchObject({ current: { planning: { due: true, prompt: PLANNING_PROMPT } } });
  });

  it('plan.current_block carries it in a gap', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);

    const read = await call('plan.current_block', {});

    expect(read.planning).toMatchObject({ due: true, prompt: PLANNING_PROMPT });
  });
});

describe('goal.declare_priorities', () => {
  const ITEMS = [{ kind: 'lift', ref: 'seated-row', level: 'specialize' }];

  it('defaults to the upcoming dated block', async () => {
    await dateBlock(store, 'b1', '2026-09-07', 2);
    await dateBlock(store, 'b2', '2026-09-21', 2);

    const declared = await call('goal.declare_priorities', { items: ITEMS });

    expect(declared.block).toEqual({ id: 'b2', defaulted: true });
    expect(declared).toMatchObject({ priorities: [{ blockId: 'b2', horizonWeeks: 2 }] });
  });

  it('defaults to the current block when nothing is planned after it', async () => {
    await dateBlock(store, 'b1', '2026-09-14', 4);

    const declared = await call('goal.declare_priorities', { items: ITEMS });

    expect(declared.block).toEqual({ id: 'b1', defaulted: true });
  });

  it('keeps a named block over the default', async () => {
    await dateBlock(store, 'b2', '2026-09-21', 2);

    const named = await call('goal.declare_priorities', { items: ITEMS, blockId: 'b1' });

    expect(named.block).toEqual({ id: 'b1', defaulted: false });
  });

  it('stamps no block when nothing is dated', async () => {
    const declared = await call('goal.declare_priorities', { items: ITEMS });

    expect(declared.block).toBeNull();
    expect(declared).toMatchObject({ priorities: [{ horizonWeeks: 12 }] });
  });
});
