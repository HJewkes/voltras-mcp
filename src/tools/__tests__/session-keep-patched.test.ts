// VW-584: a session's patched label and carb context survive the re-put at its close.
//
// `session.end` and the guided-load reap rebuild the session row from one server's live state
// and re-put it. A label or carb context patched where that live state cannot see it (the reap
// never carried either; a second server patches through its own connection) used to be put
// back as the live state had it, and the owner's diet phase was stamped onto a guest's session.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { registerSessionTools } = await import('../session-tools.js');
const { reapGuidedLoadScaffold } = await import('../../state/guided-load-reap.js');

const AT = '2026-09-20T18:00:00.000Z';
const PHASE_START = '2026-09-01T00:00:00.000Z';
const CARBS = { level: 'high' as const, hoursSinceLastMeal: 2 };
const SESSION_TOOLS = [
  'session.start',
  'session.end',
  'session.checkin',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
  'session.mark_kind',
  'session.review_list',
];

type Invoke = (name: string, args: unknown) => Promise<unknown>;

interface Server {
  state: ServerState;
  invoke: Invoke;
}

/** The session tools on one server: its store, and a primary slot holding `live`. */
function serverOn(store: SessionStore, live: InstanceType<typeof LiveState>): Server {
  const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
  const placeholders = new Map(
    SESSION_TOOLS.map((name) => [
      name,
      {
        update: (u: { callback: (args: unknown) => Promise<unknown> }) =>
          callbacks.set(name, u.callback),
      },
    ]),
  );
  const slot = { slotId: 'primary', live, modeRevertGuard: new ModeRevertGuard() };
  const state = {
    config: {},
    store,
    slots: new Map([['primary', slot]]),
  } as unknown as ServerState;
  registerSessionTools({} as never, state, placeholders as never);
  return { state, invoke: (name, args) => callbacks.get(name)!(args) };
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-session-keep-patched-'));
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The owner is in a declared phase, so an unlabelled session would be stamped with it. */
async function declareOwnerPhase(store: SessionStore): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'fat-loss',
    startedAt: PHASE_START,
    declaredAt: PHASE_START,
  });
}

/** A stored session, active in one server's memory. */
async function seedActive(
  store: SessionStore,
  extra: { autoCreatedBy?: 'guided_load' } = {},
): Promise<InstanceType<typeof LiveState>> {
  await store.putSession({ id: 'sess-1', startedAt: AT, kind: 'training' });
  const live = new LiveState();
  live.startSession({ sessionId: 'sess-1', startedAt: AT, setIds: [], status: 'active', ...extra });
  return live;
}

describe('the guided-load reap keeps a patched session (VW-584)', () => {
  it('keeps a label set on the auto-session and stamps no diet phase', async () => {
    const store = openStore();
    await declareOwnerPhase(store);
    const server = serverOn(store, await seedActive(store, { autoCreatedBy: 'guided_load' }));

    await server.invoke('session.set_lifter', { lifter: 'Jordan' });
    await reapGuidedLoadScaffold(server.state, 'primary');

    const stored = await store.getSession('sess-1');
    expect(stored?.endedAt).toBeDefined();
    expect(stored?.lifter).toBe('Jordan');
    expect(stored?.dietPhase).toBeUndefined();
  });
});

describe('session.end keeps what another connection patched (VW-584)', () => {
  it('keeps the label and carb context a second server wrote, and stamps no diet phase', async () => {
    const a = openStore();
    const b = openStore();
    await declareOwnerPhase(a);
    const ending = serverOn(a, await seedActive(a));
    const other = serverOn(b, new LiveState());

    await b.patchSession('sess-1', { lifter: 'Jordan' });
    await other.invoke('session.checkin', {
      sessionId: 'sess-1',
      answers: [{ code: 'felt', value: 'Solid.' }],
      preSessionCarbs: CARBS,
    });
    const ended = await ending.invoke('session.end', {});

    expect((ended as { isError?: boolean }).isError).toBeUndefined();
    const stored = await b.getSession('sess-1');
    expect(stored?.endedAt).toBeDefined();
    expect(stored?.lifter).toBe('Jordan');
    expect(stored?.preSessionCarbs).toEqual(CARBS);
    expect(stored?.dietPhase).toBeUndefined();
  });
});
