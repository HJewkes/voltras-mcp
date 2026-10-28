// VW-919: who ended a session lives in `sessions.closed_by`, not in its notes.
//
// The idle rule used to append its closer to the notes, and the next `session.end` re-put, built
// from live state that never carried notes, nulled it. The closer is now a column the first
// closer holds, and the rule's close is a row in the activity trail.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { registerSessionTools } = await import('../session-tools.js');
const { closeIdleSessions } = await import('../../state/idle-session-close.js');
const { toActivityRow } = await import('../../dashboard/activity.js');

const AT = '2026-09-20T18:00:00.000Z';
const LATER = new Date('2026-09-21T06:00:00.000Z');
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

type ToolResult = { content: { text: string }[] };
type Invoke = (name: string, args: unknown) => Promise<ToolResult>;

/** The session tools on one server: its store, and a primary slot holding `live`. */
function serverOn(store: SessionStore, live: InstanceType<typeof LiveState>): Invoke {
  const callbacks = new Map<string, (args: unknown) => Promise<ToolResult>>();
  const placeholders = new Map(
    SESSION_TOOLS.map((name) => [
      name,
      { update: (u: { callback: never }) => callbacks.set(name, u.callback) },
    ]),
  );
  const slot = { slotId: 'primary', live, modeRevertGuard: new ModeRevertGuard() };
  const state = {
    config: {},
    store,
    slots: new Map([['primary', slot]]),
  } as unknown as ServerState;
  registerSessionTools({} as never, state, placeholders as never);
  return (name, args) => callbacks.get(name)!(args);
}

function payload<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]!.text) as T;
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-session-closed-by-'));
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A stored session, active in one server's memory. */
async function seedActive(store: SessionStore): Promise<InstanceType<typeof LiveState>> {
  await store.putSession({ id: 'sess-1', startedAt: AT, kind: 'training' });
  const live = new LiveState();
  live.startSession({ sessionId: 'sess-1', startedAt: AT, setIds: [], status: 'active' });
  return live;
}

describe('the session closer', () => {
  it('records the lifter as the closer of a session.end', async () => {
    const store = openStore();
    const invoke = serverOn(store, await seedActive(store));

    await invoke('session.end', {});

    expect((await store.getSession('sess-1'))?.closedBy).toBe('manual');
  });

  it('keeps the idle rule as the closer through a later session.end re-put', async () => {
    const ending = openStore();
    const booting = openStore();
    const invoke = serverOn(ending, await seedActive(ending));

    await closeIdleSessions(booting, LATER);
    await invoke('session.end', {});

    expect((await booting.getSession('sess-1'))?.closedBy).toBe('rule:idle');
  });

  it('shows the closer on session.get and session.list', async () => {
    const store = openStore();
    await store.putSession({ id: 'sess-1', startedAt: AT, kind: 'training' });
    await closeIdleSessions(store, LATER);
    const invoke = serverOn(store, new LiveState());

    const got = payload<{ session: { closedBy?: string } }>(
      await invoke('session.get', { id: 'sess-1' }),
    );
    const listed = payload<{ id: string; closedBy?: string }[]>(await invoke('session.list', {}));

    expect(got.session.closedBy).toBe('rule:idle');
    expect(listed.find((row) => row.id === 'sess-1')?.closedBy).toBe('rule:idle');
  });

  it("records an idle close in the activity trail as the rule's, with the closer as its reason", async () => {
    const store = openStore();
    await store.putSession({ id: 'sess-1', startedAt: AT, kind: 'training' });

    await closeIdleSessions(store, LATER);

    const rows = (await store.listActivity({ sessionId: 'sess-1' })).map(toActivityRow);
    expect(rows).toEqual([
      expect.objectContaining({
        actor: 'rule',
        tool: 'session.end',
        reason: 'rule:idle',
        outcome: 'ok',
        sessionId: 'sess-1',
      }),
    ]);
  });
});
