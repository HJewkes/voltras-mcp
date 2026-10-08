// Idle sessions are ended by rule, at their last rep (VW-856).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import {
  closeIdleSessions,
  endStaleLiveSession,
  IDLE_SESSION_CLOSER,
  noteLiveRep,
} from '../idle-session-close.js';
import { openSqliteTestStore, removeTestStoreDirs } from '../../store/__tests__/open-test-store.js';
import type { StoredSet } from '../../store/types.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { bootstrapState, getSlot } from '../server-state.js';

afterEach(() => {
  removeTestStoreDirs();
});

const NOW = new Date('2026-01-12T09:00:00.000Z');

function setWithReps(id: string, sessionId: string, startedAt: string, endedAt: string): StoredSet {
  return {
    id,
    sessionId,
    startedAt,
    endedAt,
    partial: false,
    reps: [{ id: `${id}-r1`, setId: id, index: 0 } as unknown as StoredSet['reps'][number]],
  } as StoredSet;
}

describe('closeIdleSessions', () => {
  it('ends a session that runs past midnight on its last rep, not on now', async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 's1', startedAt: '2026-01-10T22:30:00.000Z' });
    await store.putSet(
      setWithReps('set1', 's1', '2026-01-10T23:50:00.000Z', '2026-01-11T00:20:00.000Z'),
    );

    const closed = await closeIdleSessions(store, NOW);

    const stored = await store.getSession('s1');
    expect(closed).toEqual(['s1']);
    expect(stored?.endedAt).toBe('2026-01-11T00:20:00.000Z');
    expect(stored?.notes).toContain(IDLE_SESSION_CLOSER);
  });

  it('keeps a session that ran past local midnight on the local day of its last rep', async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 'late', startedAt: '2026-01-11T03:00:00.000Z' });
    await store.putSet(
      setWithReps('late-set', 'late', '2026-01-11T04:50:00.000Z', '2026-01-11T05:30:00.000Z'),
    );

    await closeIdleSessions(store, NOW);

    const endedAt = (await store.getSession('late'))?.endedAt ?? '';
    const day = (at: string) =>
      new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    expect(day(endedAt)).toBe('2026-01-10');
    expect(day(NOW.toISOString())).toBe('2026-01-12');
  });

  it('ends at the newest idle rep when a session holds more than a hundred', async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 'many', startedAt: '2026-01-10T07:00:00.000Z' });
    const base = Date.parse('2026-01-10T08:00:00.000Z');
    for (let i = 0; i < 101; i += 1) {
      await store.putIdleRep({
        id: `ir-${String(i)}`,
        userId: LOCAL_USER_ID,
        sessionId: 'many',
        observedAt: new Date(base + i * 60_000).toISOString(),
        rep: { repNumber: i } as never,
      });
    }

    await closeIdleSessions(store, NOW);

    expect((await store.getSession('many'))?.endedAt).toBe('2026-01-10T09:40:00.000Z');
  });

  it('leaves a session with a rep inside the idle window open', async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 's2', startedAt: '2026-01-12T05:00:00.000Z' });
    await store.putSet(
      setWithReps('set2', 's2', '2026-01-12T05:10:00.000Z', '2026-01-12T05:20:00.000Z'),
    );

    const closed = await closeIdleSessions(store, NOW);

    expect(closed).toEqual([]);
    expect((await store.getSession('s2'))?.endedAt).toBeUndefined();
  });

  it('closes a repless session at its start and keeps its existing notes', async () => {
    const store = openSqliteTestStore();
    await store.putSession({
      id: 's3',
      startedAt: '2026-01-10T08:00:00.000Z',
      notes: 'bench test',
    });

    await closeIdleSessions(store, NOW);

    const stored = await store.getSession('s3');
    expect(stored?.endedAt).toBe('2026-01-10T08:00:00.000Z');
    expect(stored?.notes).toMatch(/^bench test\nClosed by rule:idle/);
  });

  it("closes a guest lifter's session by the same rule", async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 'g1', startedAt: '2026-01-10T08:00:00.000Z', lifter: 'guest' });

    const closed = await closeIdleSessions(store, NOW);

    expect(closed).toEqual(['g1']);
  });

  it('does not touch a session that already ended', async () => {
    const store = openSqliteTestStore();
    await store.putSession({
      id: 's4',
      startedAt: '2026-01-01T08:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
    });

    expect(await closeIdleSessions(store, NOW)).toEqual([]);
  });
});

describe('with a bootstrapped server state', () => {
  const savedEnv = { ...process.env };
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'vmcp-idle-close-'));
    process.env.VOLTRA_ADAPTER = 'mock';
    process.env.VMCP_DB_PATH = join(dbDir, 'store.sqlite');
    process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('closes a stale open session when the server boots', async () => {
    const seed = openSqliteTestStore({ path: process.env.VMCP_DB_PATH! });
    await seed.putSession({ id: 'old', startedAt: '2020-01-01T08:00:00.000Z' });
    await seed.close();

    const state = await bootstrapState(loadConfig());

    try {
      expect((await state.store.getSession('old'))?.endedAt).toBe('2020-01-01T08:00:00.000Z');
    } finally {
      await state.store.close();
    }
  });

  it('ends a live session left idle past the window, at its last rep, before new activity', async () => {
    const state = await bootstrapState(loadConfig());
    try {
      await state.store.putSession({ id: 'live', startedAt: '2026-01-10T08:00:00.000Z' });
      const slot = getSlot(state, 'primary');
      slot.live.startSession({
        sessionId: 'live',
        startedAt: '2026-01-10T08:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      noteLiveRep(state, 'primary', new Date('2026-01-10T09:00:00.000Z'));

      await endStaleLiveSession(state, 'primary', NOW);

      expect(slot.live.session).toBeUndefined();
      expect((await state.store.getSession('live'))?.endedAt).toBe('2026-01-10T09:00:00.000Z');
    } finally {
      await state.store.close();
    }
  });

  it('leaves a live session with a recent rep alone', async () => {
    const state = await bootstrapState(loadConfig());
    try {
      const slot = getSlot(state, 'primary');
      slot.live.startSession({
        sessionId: 'busy',
        startedAt: '2026-01-10T08:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      noteLiveRep(state, 'primary', new Date('2026-01-12T08:00:00.000Z'));

      expect(endStaleLiveSession(state, 'primary', NOW)).toBeUndefined();
      expect(slot.live.session?.sessionId).toBe('busy');
    } finally {
      await state.store.close();
    }
  });
});
