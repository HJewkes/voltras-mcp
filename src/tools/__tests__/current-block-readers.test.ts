// Every reader that defaults a plan goes through the one current-block rule (VW-475). Each test
// runs on the owner's undated plan shape, where "newest program" would pick the finished test
// program, so a reader that bypasses the rule fails here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { fetchPlanTree } from '../../dashboard/plan-api.js';
import {
  RETURN_ONLY_EXERCISE,
  RETURN_PROGRAM,
  dateBlock,
  seedOwnerShapedPlan,
} from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { buildWeeklyReport } from '../report-tools.js';

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
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SqliteSessionStore;
let state: ServerState;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
  state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerPlanTools({} as never, state, placeholders as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await callbacks.get(name)!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('plan.next_workout', () => {
  it('walks the program with work left when nothing is dated', async () => {
    const next = await call('plan.next_workout', {});

    expect(next.template).toMatchObject({ id: 'day-a' });
    expect(next.block).toMatchObject({ id: 'b1' });
  });

  it('walks only the current dated block', async () => {
    await dateBlock(store, 'b2', '2026-09-14', 2);

    const next = await call('plan.next_workout', {});

    expect(next.template).toMatchObject({ id: 'b2w1-0', name: 'Upper A' });
    expect(next.block).toMatchObject({ id: 'b2' });
  });

  it('never continues an ended block in a gap', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);

    const next = await call('plan.next_workout', {});

    expect(next).toMatchObject({
      ok: true,
      unplanned: true,
      state: 'gap',
      endedBlock: { id: 'b1' },
      nextBlock: null,
    });
    expect(next.template).toBeUndefined();
  });

  it('still walks a named program in full', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);

    const next = await call('plan.next_workout', { programId: 'return' });

    expect(next.template).toMatchObject({ id: 'day-a' });
  });
});

describe('plan.complete_workout', () => {
  it('returns the current-block read after the write', async () => {
    const done = await call('plan.complete_workout', {
      workoutTemplateId: 'day-a',
      sessionId: 'sess-day-b',
    });

    expect(done.current).toMatchObject({
      state: 'undated_only',
      program: { name: RETURN_PROGRAM },
    });
  });
});

describe('plan.current_block', () => {
  it('returns the resolver read', async () => {
    const read = await call('plan.current_block', {});

    expect(read).toMatchObject({ state: 'undated_only', program: { name: RETURN_PROGRAM } });
  });
});

describe('/api/plan-tree', () => {
  it('opens on the program the current-block rule picks', async () => {
    const tree = await fetchPlanTree(store, () => undefined);

    expect(tree.program?.name).toBe(RETURN_PROGRAM);
  });
});

describe('report.weekly', () => {
  it("reads progression against the current-block rule's program", async () => {
    await store.putSet(rowSet());

    const report = await buildWeeklyReport(state, {
      from: '2026-09-07T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
    });

    expect(report.progression.map((line) => line.exerciseId)).toEqual([RETURN_ONLY_EXERCISE]);
  });
});

const PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0.6,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 1,
  _totalHoldDuration: 0,
  peakVelocity: 0.6,
  peakForce: 0,
  peakLoad: 0,
};

function rowSet(): StoredSet {
  const reps: StoredRep[] = [0, 1].map((index) => ({
    id: `row-r${index}`,
    setId: 'row',
    index,
    repNumber: index + 1,
    concentric: PHASE,
    eccentric: PHASE,
  }));
  return {
    id: 'row',
    sessionId: 'sess-day-b',
    exerciseId: RETURN_ONLY_EXERCISE,
    startedAt: '2026-09-07T15:05:00.000Z',
    endedAt: '2026-09-07T15:06:00.000Z',
    partial: false,
    weightLbs: 100,
    reps,
  };
}
