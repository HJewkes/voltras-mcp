// VW-536: a session is linked to one workout, or one planned lift, once. `plan.complete_workout`
// and `plan.attach_to_session` both promise that a retry returns the existing link rather than
// writing a second, and both used to keep the promise with a read before the write. Two calls
// at once each read "no link yet" and each wrote one. Every case runs in the two variants of
// `store-concurrency.test.ts`: one store instance, and two instances on one temp file.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import type { SessionStore } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));

const { registerPlanTools } = await import('../plan-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

const AT = '2026-09-20T18:00:00.000Z';

type Result = { isError: boolean; body: { assignment?: { id: string } } };
type Call = (name: string, args: unknown) => Promise<Result>;
type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function planToolsOn(store: SessionStore): Call {
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback) },
    ]),
  );
  const state = {
    store,
    slots: new Map(),
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
  registerPlanTools({} as never, state, placeholders as never);
  return async (name, args) => {
    const result = await callbacks.get(name)!(args);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as never };
  };
}

let dir: string;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-assignment-'));
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedPlan(store: SessionStore): Promise<void> {
  await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0, isDeload: false });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', orderIndex: 0, name: 'Upper' });
  await store.putPlannedExercise({
    id: 'pe',
    workoutTemplateId: 'tpl',
    exerciseId: 'cable-row',
    orderIndex: 0,
    targetSets: 3,
  } as never);
  await store.putSession({ id: 'sess-1', startedAt: AT });
}

/** Run one call on each connection at once, and return the links the session ends with. */
async function race(connections: 1 | 2, name: string, args: unknown) {
  const a = openStore();
  const b = connections === 1 ? a : openStore();
  await seedPlan(a);
  const results = await Promise.all([planToolsOn(a)(name, args), planToolsOn(b)(name, args)]);
  return { results, links: await b.getAssignmentsForSession('sess-1') };
}

describe.each([1, 2] as const)('assignment idempotency with %i connection(s) (VW-536)', (n) => {
  it('writes one link when a workout is completed twice at once', async () => {
    const { results, links } = await race(n, 'plan.complete_workout', {
      sessionId: 'sess-1',
      workoutTemplateId: 'tpl',
    });

    expect(links).toHaveLength(1);
    expect(results.map((r) => r.body.assignment?.id)).toEqual([links[0].id, links[0].id]);
  });

  it('writes one link when a planned lift is attached twice at once', async () => {
    const { links } = await race(n, 'plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe',
    });

    expect(links).toHaveLength(1);
  });

  it('writes one link when a workout is attached twice at once', async () => {
    const { links } = await race(n, 'plan.attach_to_session', {
      sessionId: 'sess-1',
      workoutTemplateId: 'tpl',
    });

    expect(links).toHaveLength(1);
  });
});
