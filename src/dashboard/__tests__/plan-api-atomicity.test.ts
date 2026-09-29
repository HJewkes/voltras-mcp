// VW-585: the planned-exercise PATCH and the block week scaffold, each under two writers.
// Every case runs twice: both callers on one store, and one caller on each of two stores
// over one temp file. Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { updatePlannedExercise } from '../plan-api.js';

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));

const { registerPlanTools } = await import('../../tools/plan-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

const AT = '2026-09-20T18:00:00.000Z';
const ROW_ID = 'pe-1';

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Call = (name: string, args: unknown) => Promise<{ isError: boolean; body: unknown }>;

let dir: string;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

function storePair(connections: 1 | 2): [SessionStore, SessionStore] {
  const a = openStore();
  return [a, connections === 1 ? a : openStore()];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-plan-atomicity-'));
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function planToolsOn(store: SessionStore): Call {
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback) },
    ]),
  );
  const state = { store, exercises: { getById: () => undefined } } as unknown as ServerState;
  registerPlanTools({} as never, state, placeholders as never);
  return async (name, args) => {
    const result = await callbacks.get(name)!(args);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
}

async function seedBand(store: SessionStore): Promise<void> {
  await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'Orientation',
    weeksCount: 4,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0, isDeload: false });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Day A', orderIndex: 0 });
  await store.putPlannedExercise({
    id: ROW_ID,
    workoutTemplateId: 'tpl',
    exerciseId: 'bench-press',
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 6,
    targetRepsHigh: 10,
  });
}

describe.each([1, 2] as const)('planned-exercise PATCH with %i connection(s)', (connections) => {
  it('refuses the second of two patches that would invert the rep band', async () => {
    const [a, b] = storePair(connections);
    await seedBand(a);

    const results = await Promise.allSettled([
      updatePlannedExercise(a, ROW_ID, { targetRepsLow: 9 }),
      updatePlannedExercise(b, ROW_ID, { targetRepsHigh: 7 }),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'invalid_input' } });
    const stored = await a.getPlannedExercise(ROW_ID);
    expect(stored!.targetRepsLow!).toBeLessThanOrEqual(stored!.targetRepsHigh!);
  });

  it('writes nothing when the patch fails validation', async () => {
    const [a] = storePair(connections);
    await seedBand(a);

    await expect(updatePlannedExercise(a, ROW_ID, { targetRepsLow: 12 })).rejects.toMatchObject({
      code: 'invalid_input',
    });

    expect(await a.getPlannedExercise(ROW_ID)).toMatchObject({
      targetRepsLow: 6,
      targetRepsHigh: 10,
    });
  });

  it('reports not_found for a missing row', async () => {
    const [a] = storePair(connections);

    await expect(updatePlannedExercise(a, 'missing', { targetSets: 4 })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe.each([1, 2] as const)('block week scaffold with %i connection(s)', (connections) => {
  it('gives exactly weeksCount rows when two creates share one id', async () => {
    const [a, b] = storePair(connections);
    const [callA, callB] = [planToolsOn(a), planToolsOn(b)];
    await callA('plan.program.create', { id: 'prog', name: 'Return' });
    const create = (call: Call) =>
      call('plan.block.create', {
        id: 'blk',
        programId: 'prog',
        orderIndex: 0,
        name: 'Orientation',
        weeksCount: 4,
        scaffoldWeeks: true,
      });

    const replies = await Promise.all([create(callA), create(callB)]);

    expect(replies.filter((reply) => reply.isError)).toHaveLength(1);
    expect(replies.find((reply) => reply.isError)!.body).toMatchObject({ code: 'WEEKS_EXIST' });
    expect(await a.getTrainingWeeksForBlock('blk')).toHaveLength(4);
  });
});
