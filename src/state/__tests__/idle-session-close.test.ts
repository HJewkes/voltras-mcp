// Idle sessions are ended by rule at boot, at their last rep (VW-856).

import { afterEach, describe, expect, it } from 'vitest';

import { closeIdleSessions, IDLE_SESSION_CLOSER } from '../idle-session-close.js';
import { openSqliteTestStore, removeTestStoreDirs } from '../../store/__tests__/open-test-store.js';
import type { StoredSet } from '../../store/types.js';

afterEach(() => {
  removeTestStoreDirs();
});

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

    const closed = await closeIdleSessions(store, new Date('2026-01-12T09:00:00.000Z'));

    const stored = await store.getSession('s1');
    expect(closed).toEqual(['s1']);
    expect(stored?.endedAt).toBe('2026-01-11T00:20:00.000Z');
    expect(stored?.notes).toContain(IDLE_SESSION_CLOSER);
  });

  it('leaves a session with a rep inside the idle window open', async () => {
    const store = openSqliteTestStore();
    await store.putSession({ id: 's2', startedAt: '2026-01-12T05:00:00.000Z' });
    await store.putSet(
      setWithReps('set2', 's2', '2026-01-12T05:10:00.000Z', '2026-01-12T05:20:00.000Z'),
    );

    const closed = await closeIdleSessions(store, new Date('2026-01-12T09:00:00.000Z'));

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

    await closeIdleSessions(store, new Date('2026-01-12T09:00:00.000Z'));

    const stored = await store.getSession('s3');
    expect(stored?.endedAt).toBe('2026-01-10T08:00:00.000Z');
    expect(stored?.notes).toMatch(/^bench test\nClosed by rule:idle/);
  });

  it('does not touch a session that already ended', async () => {
    const store = openSqliteTestStore();
    await store.putSession({
      id: 's4',
      startedAt: '2026-01-01T08:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
    });

    const closed = await closeIdleSessions(store, new Date('2026-01-12T09:00:00.000Z'));

    expect(closed).toEqual([]);
  });
});
