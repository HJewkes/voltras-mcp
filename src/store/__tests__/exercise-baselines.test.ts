// Tests for the `exercise_baselines` state machine and its first writer
// (VW-116 / B56).
//
// Three things here are load-bearing:
//
//   * The ratchet gates. A promotion that fires one anchor early, or on three
//     anchors from a single session, produces a CALIBRATED baseline that then
//     drives user-visible near-failure cues off correlated noise.
//   * The NULL-`setup_id` upsert. SQLite treats NULLs in a UNIQUE index as
//     DISTINCT, so `UNIQUE (user_id, exercise_id, setup_id, side)` never fires
//     while `setup_id` is NULL — conflicting on it would append a duplicate
//     row per recalc instead of updating. The conflict target is `id`.
//   * Row identity is WA's `baselineKeyId`, not a hand-rolled string, so the
//     analytics layer and the store agree on what a baseline IS.
//
// `failure_anchors` has no writer either (harvesting is a separate task), so
// anchors are seeded through the raw handle — the same convention
// `sqlite-store-queries.test.ts` uses for `exercise_setups`.

import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  baselineKeyId,
  matchesBaselineKey,
  type BaselineKey,
  type Phase,
} from '@voltras/workout-analytics';

import {
  BASELINE_ALGORITHM_VERSION,
  BASELINE_THRESHOLDS,
  deriveBaselineState,
  summarizeSets,
  type AnchorObservation,
  type BaselineObservations,
} from '../exercise-baselines.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSet } from '../types.js';

const NOW = new Date('2025-06-01T00:00:00.000Z');

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

/** A rep lasting `durationSec`, so the tempo-consistency gate has something to read. */
function makeRep(setId: string, index: number, durationSec = 3): StoredRep {
  const start = index * durationSec * 1000;
  return {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, startTime: start, endTime: start + durationSec * 500 },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + durationSec * 500,
      endTime: start + durationSec * 1000,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

/**
 * Fixture timestamps for the store tests are relative to the wall clock:
 * `recalcBaseline` reads `new Date()` for the staleness gate, so a fixed
 * historical date would silently start returning STALE once it aged past the
 * window.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function makeSet(
  overrides: Partial<StoredSet> & { id: string; sessionId: string },
  repCount = 5,
  repDurationSec = 3,
): StoredSet {
  return {
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: daysAgo(3),
    endedAt: daysAgo(3),
    partial: false,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(overrides.id, i, repDurationSec)),
    ...overrides,
  };
}

function observations(over: Partial<BaselineObservations> = {}): BaselineObservations {
  return {
    qualifyingSetCount: 3,
    observedSessions: 2,
    firstObservedAt: '2025-05-01T00:00:00.000Z',
    lastObservedAt: '2025-05-20T00:00:00.000Z',
    anchors: [],
    ...over,
  };
}

function anchors(velocities: number[], sessionBuckets: string[]): AnchorObservation[] {
  return velocities.map((v, i) => ({
    sessionBucket: sessionBuckets[i] ?? `sess-${String(i)}`,
    terminalVelocityMps: v,
  }));
}

describe('deriveBaselineState — the ratchet', () => {
  it('is COLD below the qualifying-set floor', () => {
    const out = deriveBaselineState(observations({ qualifyingSetCount: 2 }), NOW);
    expect(out.state).toBe('COLD');
    expect(out.confidence).toBe(0);
  });

  it('is COLD when qualifying sets disagree on tempo, however many there are', () => {
    const out = deriveBaselineState(observations({ qualifyingSetCount: 9, tempoCv: 0.9 }), NOW);
    expect(out.state).toBe('COLD');
  });

  it('reaches SHAPE_ONLY on shape alone, with no anchor', () => {
    const out = deriveBaselineState(observations({ tempoCv: 0.1 }), NOW);
    expect(out.state).toBe('SHAPE_ONLY');
    expect(out.anchorCount).toBe(0);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThan(0.5);
  });

  it('is PROVISIONAL on one or two anchors', () => {
    for (const n of [1, 2]) {
      const out = deriveBaselineState(
        observations({ anchors: anchors(Array(n).fill(0.2) as number[], ['s1', 's2']) }),
        NOW,
      );
      expect(out.state).toBe('PROVISIONAL');
      expect(out.anchorCount).toBe(n);
    }
  });

  it('reaches CALIBRATED on three tight anchors across two sessions', () => {
    const out = deriveBaselineState(
      observations({ anchors: anchors([0.2, 0.21, 0.205], ['s1', 's1', 's2']) }),
      NOW,
    );
    expect(out.state).toBe('CALIBRATED');
    expect(out.anchorSpread).toBeLessThan(BASELINE_THRESHOLDS.maxCalibratedAnchorSpread);
    expect(out.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('holds at PROVISIONAL when three anchors disagree, however many there are', () => {
    const out = deriveBaselineState(
      observations({ anchors: anchors([0.1, 0.3, 0.6], ['s1', 's2', 's3']) }),
      NOW,
    );
    expect(out.state).toBe('PROVISIONAL');
    expect(out.anchorSpread).toBeGreaterThan(BASELINE_THRESHOLDS.maxCalibratedAnchorSpread);
  });

  it('holds at PROVISIONAL when every anchor came from one session', () => {
    const out = deriveBaselineState(
      observations({ anchors: anchors([0.2, 0.21, 0.205], ['s1', 's1', 's1']) }),
      NOW,
    );
    expect(out.state).toBe('PROVISIONAL');
  });

  it('degrades to STALE past the observation window, recording why', () => {
    const out = deriveBaselineState(
      observations({
        lastObservedAt: '2025-01-01T00:00:00.000Z',
        anchors: anchors([0.2, 0.21, 0.205], ['s1', 's1', 's2']),
      }),
      NOW,
    );
    expect(out.state).toBe('STALE');
    expect(out.invalidatedAt).toBe(NOW.toISOString());
    expect(out.invalidationReason).toContain('60d');
  });

  it('re-enters CALIBRATED once a fresh observation lands', () => {
    const stale = observations({
      lastObservedAt: '2025-01-01T00:00:00.000Z',
      anchors: anchors([0.2, 0.21, 0.205], ['s1', 's1', 's2']),
    });
    expect(deriveBaselineState(stale, NOW).state).toBe('STALE');
    const fresh = deriveBaselineState(
      { ...stale, lastObservedAt: '2025-05-30T00:00:00.000Z' },
      NOW,
    );
    expect(fresh.state).toBe('CALIBRATED');
    expect(fresh.invalidatedAt).toBeUndefined();
  });
});

describe('summarizeSets', () => {
  it('counts DISTINCT sessions, not sets', () => {
    const out = summarizeSets([
      makeSet({ id: 'a', sessionId: 'sess-1' }),
      makeSet({ id: 'b', sessionId: 'sess-1' }),
      makeSet({ id: 'c', sessionId: 'sess-2' }),
    ]);
    expect(out.qualifyingSetCount).toBe(3);
    expect(out.observedSessions).toBe(2);
  });

  it('excludes sets below the rep floor from the shape count', () => {
    const out = summarizeSets([
      makeSet({ id: 'a', sessionId: 'sess-1' }, 5),
      makeSet({ id: 'b', sessionId: 'sess-2' }, 3),
    ]);
    expect(out.qualifyingSetCount).toBe(1);
  });

  it('reports tempo spread across sets performed at different cadences', () => {
    const consistent = summarizeSets([
      makeSet({ id: 'a', sessionId: 'sess-1' }, 5, 3),
      makeSet({ id: 'b', sessionId: 'sess-2' }, 5, 3.1),
    ]);
    expect(consistent.tempoCv ?? 1).toBeLessThan(BASELINE_THRESHOLDS.maxShapeTempoCv);

    const erratic = summarizeSets([
      makeSet({ id: 'a', sessionId: 'sess-1' }, 5, 1),
      makeSet({ id: 'b', sessionId: 'sess-2' }, 5, 6),
    ]);
    expect(erratic.tempoCv ?? 0).toBeGreaterThan(BASELINE_THRESHOLDS.maxShapeTempoCv);
  });
});

describe('SqliteSessionStore baseline read/write', () => {
  let store: SqliteSessionStore;
  const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  function rawDb(): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
  }

  function countRows(): number {
    const row = rawDb().prepare(`SELECT COUNT(*) AS n FROM exercise_baselines`).get() as {
      n: number;
    };
    return row.n;
  }

  function seedAnchor(
    id: string,
    setId: string | null,
    velocity: number,
    verdict = 'failure',
  ): void {
    rawDb()
      .prepare(
        `INSERT INTO failure_anchors
           (id, user_id, set_id, exercise_id, observed_at, source,
            terminal_velocity_mps, filter_inputs_json, filter_verdict, filter_version)
         VALUES (?, ?, ?, 'bench-press', ?, 'harvested',
                 ?, '{}', ?, 'f@1.0.0')`,
      )
      .run(id, LOCAL_USER_ID, setId, daysAgo(2), velocity, verdict);
  }

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    for (const s of ['sess-1', 'sess-2', 'sess-3']) {
      await store.putSession({ id: s, startedAt: daysAgo(3) });
    }
    await store.putSet(makeSet({ id: 'set-1', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'set-2', sessionId: 'sess-2' }));
    await store.putSet(makeSet({ id: 'set-3', sessionId: 'sess-3' }));
  });

  it('returns undefined before the key has ever been recalculated', async () => {
    expect(await store.getBaseline(key)).toBeUndefined();
  });

  it('writes a NULL-setup row keyed on WA baselineKeyId, and updates it in place', async () => {
    const first = await store.recalcBaseline(key);
    expect(first.id).toBe(baselineKeyId(key));
    expect(first.setupId).toBeUndefined();
    expect(first.state).toBe('SHAPE_ONLY');
    expect(first.algorithmVersion).toBe(BASELINE_ALGORITHM_VERSION);
    expect(countRows()).toBe(1);

    // The UNIQUE constraint is inert while setup_id is NULL, so this is the
    // guard that the upsert conflicts on `id` rather than appending.
    seedAnchor('anchor-1', 'set-1', 0.2);
    const second = await store.recalcBaseline(key);
    expect(countRows()).toBe(1);
    expect(second.state).toBe('PROVISIONAL');
    expect((await store.getBaseline(key))?.state).toBe('PROVISIONAL');
  });

  it('keys per-side baselines separately from the pooled one', async () => {
    await store.putSet(makeSet({ id: 'set-l1', sessionId: 'sess-1', side: 'left' }));
    await store.putSet(makeSet({ id: 'set-l2', sessionId: 'sess-2', side: 'left' }));

    const pooled = await store.recalcBaseline(key);
    const left = await store.recalcBaseline({ ...key, side: 'left' });

    expect(left.id).not.toBe(pooled.id);
    expect(countRows()).toBe(2);
    // Pooled sees all five sets; the left key sees only its own two, which is
    // below the shape floor.
    expect(pooled.state).toBe('SHAPE_ONLY');
    expect(left.state).toBe('COLD');
  });

  it('selects rows with WA BaselineKey matching semantics', async () => {
    await store.putSet(makeSet({ id: 'set-r1', sessionId: 'sess-1', side: 'right' }));
    await store.recalcBaseline(key);
    await store.recalcBaseline({ ...key, side: 'right' });

    const stored = [
      await store.getBaseline(key),
      await store.getBaseline({ ...key, side: 'right' }),
    ];
    const keys: BaselineKey[] = stored.map((b) => ({
      userId: b?.userId ?? '',
      exerciseId: b?.exerciseId ?? '',
      ...(b?.side !== undefined ? { side: b.side } : {}),
    }));

    // A filter naming `side` selects only the per-side key. The wildcard rule
    // is asymmetric: the pooled key does NOT answer a side-specific query.
    expect(keys.filter((k) => matchesBaselineKey(k, { side: 'right' }))).toHaveLength(1);
    expect(keys.filter((k) => matchesBaselineKey(k, { userId: LOCAL_USER_ID }))).toHaveLength(2);
  });

  it('counts only anchors the harvest filter accepted', async () => {
    seedAnchor('anchor-1', 'set-1', 0.2);
    seedAnchor('anchor-2', 'set-2', 0.21);
    seedAnchor('anchor-3', 'set-3', 0.205, 'abort');
    const out = await store.recalcBaseline(key);
    expect(out.anchorCount).toBe(2);
    expect(out.state).toBe('PROVISIONAL');
  });

  it('does not promote on three anchors harvested from one session', async () => {
    // Same session for all three: the distinct-session gate must hold.
    await store.putSet(makeSet({ id: 'set-1b', sessionId: 'sess-1' }));
    await store.putSet(makeSet({ id: 'set-1c', sessionId: 'sess-1' }));
    seedAnchor('anchor-1', 'set-1', 0.2);
    seedAnchor('anchor-2', 'set-1b', 0.21);
    seedAnchor('anchor-3', 'set-1c', 0.205);
    expect((await store.recalcBaseline(key)).state).toBe('PROVISIONAL');

    seedAnchor('anchor-4', 'set-2', 0.203);
    const promoted = await store.recalcBaseline(key);
    expect(promoted.state).toBe('CALIBRATED');
    expect(promoted.anchorCount).toBe(4);
  });

  it('rejects a key naming a setup, since setup inference has no writer', async () => {
    await expect(store.getBaseline({ ...key, setupId: 'setup-a' })).rejects.toThrow(/setup/);
    await expect(store.recalcBaseline({ ...key, setupId: 'setup-a' })).rejects.toThrow(/setup/);
  });

  it('ignores warm-up sets as shape evidence', async () => {
    const warmOnly = { ...key, exerciseId: 'row' };
    await store.putSet(
      makeSet({ id: 'w1', sessionId: 'sess-1', exerciseId: 'row', isWarmup: true }),
    );
    await store.putSet(
      makeSet({ id: 'w2', sessionId: 'sess-2', exerciseId: 'row', isWarmup: true }),
    );
    await store.putSet(
      makeSet({ id: 'w3', sessionId: 'sess-3', exerciseId: 'row', isWarmup: true }),
    );
    const out = await store.recalcBaseline(warmOnly);
    expect(out.state).toBe('COLD');
    expect(out.observedSessions).toBe(0);
  });
});
