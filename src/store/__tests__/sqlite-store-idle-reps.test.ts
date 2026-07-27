// Tests for idle-rep persistence (schema v7, Wave 1-S).
//
// An idle rep is a rep performed while no set was armed. Until this writer the
// `idle_reps` table existed and stayed empty, so recorded volume under-counted
// by an unknown amount. These cases pin the behaviours that make the row
// trustworthy: absent context stays absent (no session invented, no `0` weight,
// no defaulted side), and the full rep survives the round trip.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';
import { SqliteSessionStore } from '../sqlite-store.js';
import type { StoredIdleRep, StoredSession } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(overrides: Partial<Rep> = {}): Rep {
  return {
    repNumber: 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.62, peakForce: 88 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.41 },
    ...overrides,
  };
}

function makeIdleRep(overrides: Partial<StoredIdleRep> = {}): StoredIdleRep {
  return {
    id: 'idle-1',
    userId: 'local',
    observedAt: '2025-01-01T00:00:05.000Z',
    slot: 'primary',
    deviceId: 'AA:BB:CC',
    side: 'left',
    weightLbs: 45,
    rep: makeRep(),
    ...overrides,
  };
}

const SESSION: StoredSession = {
  id: 'sess-1',
  startedAt: '2025-01-01T00:00:00.000Z',
};

describe('SqliteSessionStore idle reps', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession(SESSION);
  });

  afterEach(async () => {
    await store.close();
  });

  it('round-trips every populated field', async () => {
    await store.putIdleRep(makeIdleRep({ sessionId: 'sess-1' }));
    const [got] = await store.listIdleReps({});
    expect(got).toMatchObject({
      id: 'idle-1',
      userId: 'local',
      sessionId: 'sess-1',
      deviceId: 'AA:BB:CC',
      slot: 'primary',
      side: 'left',
      observedAt: '2025-01-01T00:00:05.000Z',
      weightLbs: 45,
    });
  });

  it('persists a rep observed with no session at all', async () => {
    // The user walks up and pulls the handle before any `session.start`. The
    // rep is as real as any other; only the session id is unknown.
    const { sessionId: _omitted, ...noSession } = makeIdleRep({ id: 'idle-nosess' });
    await store.putIdleRep(noSession);
    const [got] = await store.listIdleReps({});
    expect(got.id).toBe('idle-nosess');
    expect('sessionId' in got).toBe(false);
  });

  it('reads back the full rep payload, not a summary', async () => {
    await store.putIdleRep(makeIdleRep());
    const [got] = await store.listIdleReps({});
    expect(got.rep?.concentric.peakVelocity).toBe(0.62);
    expect(got.rep?.concentric.peakForce).toBe(88);
    expect(got.rep?.eccentric.peakVelocity).toBe(0.41);
  });

  it('coerces non-finite numbers in the payload to 0 rather than null', async () => {
    const rep = makeRep({
      concentric: { ...EMPTY_PHASE, peakVelocity: Number.NaN, peakForce: Number.POSITIVE_INFINITY },
    });
    await store.putIdleRep(makeIdleRep({ rep }));
    const [got] = await store.listIdleReps({});
    expect(got.rep?.concentric.peakVelocity).toBe(0);
    expect(got.rep?.concentric.peakForce).toBe(0);
  });

  it('leaves an unknown weight absent instead of writing a 0 sentinel', async () => {
    const { weightLbs: _omitted, ...noWeight } = makeIdleRep();
    await store.putIdleRep(noWeight);
    const [got] = await store.listIdleReps({});
    expect('weightLbs' in got).toBe(false);
  });

  it('leaves an unresolved side absent instead of defaulting one', async () => {
    const { side: _omitted, ...noSide } = makeIdleRep();
    await store.putIdleRep(noSide);
    const [got] = await store.listIdleReps({});
    expect('side' in got).toBe(false);
  });

  it('filters by session, excluding reps from other sessions', async () => {
    await store.putSession({ id: 'sess-2', startedAt: '2025-01-02T00:00:00.000Z' });
    await store.putIdleRep(makeIdleRep({ id: 'a', sessionId: 'sess-1' }));
    await store.putIdleRep(makeIdleRep({ id: 'b', sessionId: 'sess-2' }));
    await store.putIdleRep(makeIdleRep({ id: 'c', sessionId: 'sess-1' }));

    const got = await store.listIdleReps({ sessionId: 'sess-1' });
    expect(got.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('filters by observed-at window', async () => {
    await store.putIdleRep(makeIdleRep({ id: 'early', observedAt: '2025-01-01T00:00:00.000Z' }));
    await store.putIdleRep(makeIdleRep({ id: 'mid', observedAt: '2025-01-01T01:00:00.000Z' }));
    await store.putIdleRep(makeIdleRep({ id: 'late', observedAt: '2025-01-01T02:00:00.000Z' }));

    const got = await store.listIdleReps({
      from: '2025-01-01T00:30:00.000Z',
      to: '2025-01-01T01:30:00.000Z',
    });
    expect(got.map((r) => r.id)).toEqual(['mid']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putIdleRep(
        makeIdleRep({ id: `idle-${i}`, observedAt: `2025-01-01T00:00:0${i}.000Z` }),
      );
    }
    const got = await store.listIdleReps({ limit: 2 });
    expect(got.map((r) => r.id)).toEqual(['idle-0', 'idle-1']);
  });

  it('re-putting the same id updates in place rather than duplicating', async () => {
    await store.putIdleRep(makeIdleRep({ weightLbs: 45 }));
    await store.putIdleRep(makeIdleRep({ weightLbs: 60 }));
    const got = await store.listIdleReps({});
    expect(got.length).toBe(1);
    expect(got[0].weightLbs).toBe(60);
  });

  it('clears the session link rather than the row when the session is deleted', async () => {
    // `session_id ... ON DELETE SET NULL`: the rep outlives its session, which
    // is the whole point of capturing work that no set owns.
    await store.putIdleRep(makeIdleRep({ sessionId: 'sess-1' }));
    // The store deliberately exposes no session-delete API; reach the handle
    // directly to exercise the FK edge the schema declares.
    (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `DELETE FROM sessions WHERE id = 'sess-1'`,
    );
    const got = await store.listIdleReps({});
    expect(got.length).toBe(1);
    expect('sessionId' in got[0]).toBe(false);
  });
});
