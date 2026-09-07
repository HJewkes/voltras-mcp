// The failure-anchor writer and what it unblocks (VW-174 / B59).
//
// `failure_anchors` had DDL and a reader since v7 and no writer, so
// `anchorCount` was structurally 0 and no baseline could ever leave
// PROVISIONAL. These tests cover the write path end to end: harvest, upsert
// identity, and the promotion the anchors now make possible.

import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID, type StoredRep, type StoredSession, type StoredSet } from '../types.js';

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
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function rep(setId: string, index: number, vCon: number, rom: number): StoredRep {
  return {
    id: `${setId}-rep-${String(index)}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      _totalVelocity: vCon,
      _movementSampleCount: 1,
      _lastMovementVelocity: vCon,
      peakVelocity: vCon,
      endPosition: rom,
    },
    eccentric: EMPTY_PHASE,
  };
}

/** A five-rep set that grinds down to `terminal` m/s at full range. */
function decaySet(id: string, sessionId: string, terminal: number, startedAt: string): StoredSet {
  const velocities = [0.6, 0.62, 0.55, terminal + 0.08, terminal];
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    exerciseId: 'row',
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: 170,
    setIndexInSession: 1,
    reps: velocities.map((v, i) => rep(id, i, v, 0.5)),
  };
}

function session(id: string, startedAt: string): StoredSession {
  return { id, startedAt, exerciseId: 'row', exerciseName: 'Cable Row' };
}

/** Days before now, ISO — anchors must be recent or the baseline reads STALE. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function openWith(sets: { set: StoredSet; sessionStartedAt: string }[]) {
  const store = SqliteSessionStore.open(':memory:');
  const seen = new Set<string>();
  for (const { set, sessionStartedAt } of sets) {
    if (!seen.has(set.sessionId)) {
      await store.putSession(session(set.sessionId, sessionStartedAt));
      seen.add(set.sessionId);
    }
    await store.putSet(set);
  }
  return store;
}

describe('SqliteSessionStore — failure-anchor harvest', () => {
  it('writes one anchor per set and re-running the same filter version updates it in place', async () => {
    const startedAt = daysAgo(1);
    const store = await openWith([
      { set: decaySet('set-1', 'sess-1', 0.4, startedAt), sessionStartedAt: startedAt },
    ]);
    try {
      const first = await store.harvestFailureAnchor(decaySet('set-1', 'sess-1', 0.4, startedAt));
      const second = await store.harvestFailureAnchor(decaySet('set-1', 'sess-1', 0.4, startedAt));

      expect([first, second]).toEqual(['failure', 'failure']);
      const rows = rawAnchors(store);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        set_id: 'set-1',
        filter_verdict: 'failure',
        source: 'harvested',
        rep_count: 5,
        load_lbs: 170,
      });
      expect(rows[0].terminal_velocity_mps).toBeCloseTo(0.4, 5);
    } finally {
      await store.close();
    }
  });

  it('records the abort verdict without letting it count as an anchor', async () => {
    const startedAt = daysAgo(1);
    const cutShort = decaySet('set-abort', 'sess-1', 0.4, startedAt);
    // Flat velocities, half-rep finish: the injury hazard, not a failure.
    cutShort.reps = [0.6, 0.62, 0.58, 0.62, 0.4].map((v, i) =>
      rep('set-abort', i, v, i === 4 ? 0.18 : 0.5),
    );
    const store = await openWith([{ set: cutShort, sessionStartedAt: startedAt }]);
    try {
      expect(await store.harvestFailureAnchor(cutShort)).toBe('abort');

      expect(rawAnchors(store)[0].filter_verdict).toBe('abort');
      const baseline = await store.recalcBaseline({
        userId: LOCAL_USER_ID,
        exerciseId: 'row',
      });
      expect(baseline.anchorCount).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('records the session position the anchor was harvested at', async () => {
    const sessionStart = daysAgo(1);
    const setStart = new Date(Date.parse(sessionStart) + 1800_000).toISOString();
    const set = decaySet('set-late', 'sess-1', 0.4, setStart);
    const store = await openWith([{ set, sessionStartedAt: sessionStart }]);
    try {
      await store.harvestFailureAnchor(set);

      expect(rawAnchors(store)[0].session_position_sec).toBe(1800);
    } finally {
      await store.close();
    }
  });

  it('promotes a key to CALIBRATED once three agreeing anchors span two sessions', async () => {
    // Three genuine failures, terminal velocities within a few percent of each
    // other, recorded across two separate bouts — the protocol's §4.4 bar.
    const first = daysAgo(9);
    const second = daysAgo(2);
    const sets = [
      { set: decaySet('set-a', 'sess-1', 0.4, first), sessionStartedAt: first },
      { set: decaySet('set-b', 'sess-1', 0.42, first), sessionStartedAt: first },
      { set: decaySet('set-c', 'sess-2', 0.41, second), sessionStartedAt: second },
    ];
    const store = await openWith(sets);
    try {
      for (const { set } of sets) await store.harvestFailureAnchor(set);

      const baseline = await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });

      expect(baseline.state).toBe('CALIBRATED');
      expect(baseline.anchorCount).toBe(3);
      expect(baseline.anchorSpread).toBeLessThan(0.15);
      expect(baseline.lastAnchorAt).toBe(second);
    } finally {
      await store.close();
    }
  });

  it('back-fills an existing corpus through reharvestExercise, and stays idempotent', async () => {
    const startedAt = daysAgo(3);
    const warmup: StoredSet = { ...decaySet('set-warm', 'sess-1', 0.4, startedAt), isWarmup: true };
    const sets = [
      { set: decaySet('set-a', 'sess-1', 0.4, startedAt), sessionStartedAt: startedAt },
      { set: warmup, sessionStartedAt: startedAt },
    ];
    const store = await openWith(sets);
    try {
      const key = { userId: LOCAL_USER_ID, exerciseId: 'row' };
      const counts = await store.reharvestExercise(key);
      const repeat = await store.reharvestExercise(key);

      // The warm-up is filtered out by purpose before the evaluator sees it.
      expect(counts).toEqual({ failure: 1, abort: 0, notCandidate: 0 });
      expect(repeat).toEqual(counts);
      expect(rawAnchors(store)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('skips a set with no exercise, which has no baseline key to inform', async () => {
    const startedAt = daysAgo(1);
    const orphan: StoredSet = { ...decaySet('set-x', 'sess-1', 0.4, startedAt) };
    delete orphan.exerciseId;
    const store = await openWith([{ set: orphan, sessionStartedAt: startedAt }]);
    try {
      expect(await store.harvestFailureAnchor(orphan)).toBe('not_candidate');
      expect(rawAnchors(store)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});

interface AnchorRow {
  set_id: string | null;
  filter_verdict: string;
  filter_version: string;
  source: string;
  rep_count: number | null;
  load_lbs: number | null;
  terminal_velocity_mps: number | null;
  session_position_sec: number | null;
}

function rawAnchors(store: SqliteSessionStore): AnchorRow[] {
  const db = (store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
  return db.prepare(`SELECT * FROM failure_anchors ORDER BY observed_at`).all() as AnchorRow[];
}
