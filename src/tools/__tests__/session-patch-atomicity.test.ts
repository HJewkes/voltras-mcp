// VW-536: two session tools that each change one field of the stored session, at once.
//
// `session.checkin` sets the carb context by session id and `session.set_lifter` relabels the
// active session. Each used to read the whole row and write it back, so the later write put
// the earlier one's field back as it had read it. Run in the two variants of
// `store-concurrency.test.ts`: one store instance, and two instances on one temp file (the
// two-server case, where only the relabelling server holds the session in memory). The
// relabel is injected at the check-in's write, because `Promise.all` alone does not
// interleave these two handlers between the read and the write.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { SessionStore } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');

const AT = '2026-09-20T18:00:00.000Z';
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

/** The session tools on one server: its store, and a primary slot holding `live`. */
function serverOn(store: SessionStore, live: InstanceType<typeof LiveState>): Invoke {
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
  const slots = new Map([['primary', { slotId: 'primary', live }]]);
  const state = { store, slots } as unknown as ServerState;
  registerSessionTools({} as never, state, placeholders as never);
  return (name, args) => callbacks.get(name)!(args);
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-session-patch-'));
  const store = SqliteSessionStore.open(join(dir, 'store.sqlite'));
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A stored session, active in the relabelling server's memory. */
async function seedActive(store: SessionStore): Promise<InstanceType<typeof LiveState>> {
  await store.putSession({ id: 'sess-1', startedAt: AT });
  const live = new LiveState();
  live.startSession({ sessionId: 'sess-1', startedAt: AT, setIds: [], status: 'active' });
  return live;
}

const FELT = [{ code: 'felt', value: 'Solid.' }];
const CARBS = { level: 'high' as const, hoursSinceLastMeal: 2 };

describe.each([1, 2] as const)('session field writes with %i connection(s) (VW-536)', (n) => {
  it('keeps both the carb context and the lifter label', async () => {
    const a = openStore();
    const b = n === 1 ? a : openStore();
    const relabel = serverOn(a, await seedActive(a));
    const checkin = serverOn(b, new LiveState());
    // The relabel commits after the check-in has read the session and before it writes.
    let relabelled: Promise<unknown> | undefined;
    const put = b.putSession.bind(b);
    vi.spyOn(b, 'putSession').mockImplementationOnce(async (session) => {
      relabelled = relabel('session.set_lifter', { lifter: 'Jordan' });
      await relabelled;
      return put(session);
    });

    const checked = await checkin('session.checkin', {
      sessionId: 'sess-1',
      answers: FELT,
      preSessionCarbs: CARBS,
    });
    await (relabelled ?? relabel('session.set_lifter', { lifter: 'Jordan' }));

    expect((checked as { isError?: boolean }).isError).toBeUndefined();
    const stored = await b.getSession('sess-1');
    expect(stored?.lifter).toBe('Jordan');
    expect(stored?.preSessionCarbs).toEqual(CARBS);
  });
});
