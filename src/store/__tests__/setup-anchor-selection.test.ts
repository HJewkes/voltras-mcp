// Setup-aware failure-anchor selection (VW-204).
//
// Three things are load-bearing here, and the first is the one most likely to
// ship unnoticed:
//
//   * AN EXERCISE WITH NO INFERRED SETUPS MUST NOT MOVE. That is the common
//     case — most exercises will never be clustered — and anchor evidence
//     feeds the CALIBRATED gate, so losing an anchor there degrades every
//     downstream read with no error and no failing assertion anywhere else.
//   * THE POOLED KEY MUST KEEP COUNTING STAMPED ANCHORS. The old reader
//     filtered `setup_id IS NULL`, which matched everything only because
//     nothing wrote the column. Stamping the writer while leaving that
//     predicate in place would thin every pooled baseline out silently as
//     setups get inferred. `keeps counting anchors after they are stamped` is
//     the test that separates this change from that wrong one.
//   * PREFER, THEN FALL BACK. A setup-keyed read takes its own setup's anchors
//     when there are any — exactly one is enough, there is no minimum — and
//     the whole pool when there are none, saying which it did.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { selectSetupAnchors, type AnchorObservation } from '../exercise-baselines.js';
import { inferExerciseSetups } from '../exercise-setups.js';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID, type StoredRep, type StoredSet } from '../types.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

/**
 * One rep that travelled `romM` metres at `vCon` m/s. `_movementSampleCount`
 * clears the measurable floor so `selectEligibleReps` judges it rather than
 * discarding the set as uncorroborated.
 */
function makeRep(setId: string, index: number, vCon: number, romM: number): StoredRep {
  const start = index * 3000;
  return {
    id: `${setId}-r${String(index)}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: start,
      endTime: start + 1500,
      endPosition: romM,
      _movementSampleCount: 4,
      _totalVelocity: vCon,
      _lastMovementVelocity: vCon,
      peakVelocity: vCon,
    },
    eccentric: { ...EMPTY_PHASE, startTime: start + 1500, endTime: start + 3000 },
  };
}

/**
 * A five-rep working set that grinds down to `terminal` m/s at a constant
 * `romM` — a failure by the harvest filter, and one ROM observation for the
 * clustering.
 */
function failureSet(
  id: string,
  opts: { sessionId: string; terminal: number; romM: number; at: string },
): StoredSet {
  const velocities = [0.6, 0.62, 0.55, opts.terminal + 0.08, opts.terminal];
  return {
    id,
    sessionId: opts.sessionId,
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: opts.at,
    endedAt: opts.at,
    partial: false,
    weightLbs: 170,
    setIndexInSession: 1,
    reps: velocities.map((v, i) => makeRep(id, i, v, opts.romM)),
  };
}

const KEY = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

describe('selectSetupAnchors', () => {
  const anchor = (id: string, setupId?: string): AnchorObservation => ({
    sessionBucket: id,
    observedAt: daysAgo(1),
    ...(setupId !== undefined ? { setupId } : {}),
  });

  it('takes the whole pool and reports no fallback when the key names no setup', () => {
    const pool = [anchor('a'), anchor('b', 'setup-1')];

    const selection = selectSetupAnchors(undefined, pool);

    expect(selection.scope).toBe('pooled');
    expect(selection.pooledFallback).toBe(false);
    expect(selection.anchors).toEqual(pool);
  });

  it('prefers a single same-setup anchor over a larger pool — one is the boundary', () => {
    // The exact-equality boundary of the only comparison this module makes.
    // `sameSetup.length === 1` must take the setup branch; a rule written as
    // "enough same-setup anchors" would need a number nothing here can source.
    const mine = anchor('mine', 'setup-1');
    const selection = selectSetupAnchors('setup-1', [
      anchor('other-a', 'setup-2'),
      mine,
      anchor('other-b', 'setup-2'),
      anchor('unstamped'),
    ]);

    expect(selection.scope).toBe('setup');
    expect(selection.pooledFallback).toBe(false);
    expect(selection.anchors).toEqual([mine]);
    expect(selection.anchorCount).toBe(1);
  });

  it('falls back to the whole pool, and says so, when no anchor carries the setup', () => {
    const pool = [anchor('other', 'setup-2'), anchor('unstamped')];

    const selection = selectSetupAnchors('setup-1', pool);

    expect(selection.scope).toBe('pooled');
    expect(selection.pooledFallback).toBe(true);
    expect(selection.anchors).toEqual(pool);
    expect(selection.reason).toMatch(/pooled anchors used/);
  });

  it('never treats an unstamped anchor as belonging to the requested setup', () => {
    // Absent means unknown, not "some other bench". If `undefined === undefined`
    // ever matched, an exercise with one clustered setup would count every
    // legacy anchor as that setup's own.
    const selection = selectSetupAnchors('setup-1', [anchor('legacy')]);

    expect(selection.scope).toBe('pooled');
    expect(selection.pooledFallback).toBe(true);
  });
});

describe('anchor selection over the store', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: daysAgo(9) });
    await store.putSession({ id: 'sess-2', startedAt: daysAgo(2) });
  });

  afterEach(async () => {
    await store.close();
  });

  it('leaves an exercise with no inferred setups exactly where it was', async () => {
    // The common case. Nothing has been clustered, so every anchor is
    // unstamped and the pooled key must read all three and promote, precisely
    // as it did before setup-awareness existed.
    const sets = [
      failureSet('set-a', { sessionId: 'sess-1', terminal: 0.4, romM: 0.3, at: daysAgo(9) }),
      failureSet('set-b', { sessionId: 'sess-1', terminal: 0.42, romM: 0.3, at: daysAgo(9) }),
      failureSet('set-c', { sessionId: 'sess-2', terminal: 0.41, romM: 0.3, at: daysAgo(2) }),
    ];
    for (const set of sets) await store.putSet(set);
    for (const set of sets) await store.harvestFailureAnchor(set);

    const baseline = await store.recalcBaseline(KEY);
    const selection = await store.describeAnchorSelection(KEY);

    expect(baseline.state).toBe('CALIBRATED');
    expect(baseline.anchorCount).toBe(3);
    expect(selection).toEqual({
      scope: 'pooled',
      pooledFallback: false,
      anchorCount: 3,
      reason: 'pooled key: every anchor for the exercise counts',
    });
    // Old selection vs new, on the same corpus: the pre-VW-204 reader filtered
    // `setup_id IS NULL`, and with nothing stamped it must see the same rows in
    // the same order as the reader that no longer filters at all.
    expect(anchorTuples(store, 'fa.setup_id IS NULL')).toEqual(anchorTuples(store, '1 = 1'));
  });

  it('keeps counting anchors in the pooled baseline after the clustering stamps them', async () => {
    // The regression this change exists to avoid. Once the writer stamps
    // `setup_id`, a reader still filtering `setup_id IS NULL` would drop every
    // stamped anchor from the pooled key — no error, just a baseline that
    // quietly stops being CALIBRATED.
    const sets = [
      failureSet('set-a', { sessionId: 'sess-1', terminal: 0.4, romM: 0.3, at: daysAgo(9) }),
      failureSet('set-b', { sessionId: 'sess-1', terminal: 0.42, romM: 0.3, at: daysAgo(9) }),
      failureSet('set-c', { sessionId: 'sess-2', terminal: 0.41, romM: 0.3, at: daysAgo(2) }),
    ];
    for (const set of sets) await store.putSet(set);
    await inferExerciseSetups(store, KEY);
    for (const set of sets) await store.harvestFailureAnchor(set);

    const stamped = rawAnchors(store);
    const baseline = await store.recalcBaseline(KEY);

    expect(stamped.every((row) => row.setup_id !== null)).toBe(true);
    expect(baseline.anchorCount).toBe(3);
    expect(baseline.state).toBe('CALIBRATED');
  });

  it('reads only its own setup’s anchors when the wrong cluster would answer differently', async () => {
    // Two clearly separated ROM clusters, each with its own terminal velocity.
    // A pooled read averages two benches; the setup-keyed read must not.
    const near = [
      failureSet('near-1', { sessionId: 'sess-1', terminal: 0.4, romM: 0.3, at: daysAgo(9) }),
      failureSet('near-2', { sessionId: 'sess-2', terminal: 0.41, romM: 0.3, at: daysAgo(2) }),
      failureSet('near-3', { sessionId: 'sess-2', terminal: 0.4, romM: 0.3, at: daysAgo(2) }),
    ];
    const far = [
      failureSet('far-1', { sessionId: 'sess-1', terminal: 0.2, romM: 0.6, at: daysAgo(9) }),
      failureSet('far-2', { sessionId: 'sess-2', terminal: 0.21, romM: 0.6, at: daysAgo(2) }),
      failureSet('far-3', { sessionId: 'sess-2', terminal: 0.2, romM: 0.6, at: daysAgo(2) }),
    ];
    for (const set of [...near, ...far]) await store.putSet(set);
    const summary = await inferExerciseSetups(store, KEY);
    for (const set of [...near, ...far]) await store.harvestFailureAnchor(set);
    const [nearSetup, farSetup] = summary.setups;

    const nearSelection = await store.describeAnchorSelection({ ...KEY, setupId: nearSetup.id });
    const farSelection = await store.describeAnchorSelection({ ...KEY, setupId: farSetup.id });
    const pooledSelection = await store.describeAnchorSelection(KEY);

    expect(summary.setups).toHaveLength(2);
    expect(nearSelection).toMatchObject({ scope: 'setup', pooledFallback: false, anchorCount: 3 });
    expect(farSelection).toMatchObject({ scope: 'setup', pooledFallback: false, anchorCount: 3 });
    expect(pooledSelection.anchorCount).toBe(6);
    // The wrong cluster would answer visibly differently: the pooled spread
    // mixes 0.4 m/s and 0.2 m/s anchors and blows past the CALIBRATED
    // tolerance, while each setup on its own is tight enough to promote.
    const pooled = await store.recalcBaseline(KEY);
    const nearBaseline = await store.recalcBaseline({ ...KEY, setupId: nearSetup.id });
    expect(pooled.anchorSpread).toBeGreaterThan(0.15);
    expect(pooled.state).not.toBe('CALIBRATED');
    expect(nearBaseline.anchorSpread).toBeLessThan(0.15);
    expect(nearBaseline.state).toBe('CALIBRATED');
  });

  it('falls back to the exercise pool for a setup whose sets produced no anchor', async () => {
    // A newly-opened setup has sets but no failures yet. It must keep the
    // baseline it would have had, and the fallback must be visible rather than
    // inferred from an anchor count.
    const near = [
      failureSet('near-1', { sessionId: 'sess-1', terminal: 0.4, romM: 0.3, at: daysAgo(9) }),
      failureSet('near-2', { sessionId: 'sess-2', terminal: 0.41, romM: 0.3, at: daysAgo(2) }),
      failureSet('near-3', { sessionId: 'sess-2', terminal: 0.4, romM: 0.3, at: daysAgo(2) }),
    ];
    // Flat velocities: a working set at the second bench that never stalled.
    const steady = failureSet('far-1', {
      sessionId: 'sess-2',
      terminal: 0.6,
      romM: 0.6,
      at: daysAgo(2),
    });
    steady.reps = [0.6, 0.6, 0.61, 0.6, 0.6].map((v, i) => makeRep('far-1', i, v, 0.6));
    for (const set of [...near, steady]) await store.putSet(set);
    const summary = await inferExerciseSetups(store, KEY);
    for (const set of [...near, steady]) await store.harvestFailureAnchor(set);
    const farSetup = summary.setups[1];

    const selection = await store.describeAnchorSelection({ ...KEY, setupId: farSetup.id });

    expect(selection).toEqual({
      scope: 'pooled',
      pooledFallback: true,
      anchorCount: 3,
      reason: 'no anchor carries this setup; pooled anchors used instead',
    });
  });

  it('stamps the setup the set row carries, not the one the caller happens to hold', async () => {
    // `set.end` clusters and then harvests, so the object in hand is a copy
    // made before the stamp landed. Reading the row is what makes the live
    // close produce a setup-keyed anchor instead of waiting for a reharvest.
    const set = failureSet('set-a', {
      sessionId: 'sess-1',
      terminal: 0.4,
      romM: 0.3,
      at: daysAgo(9),
    });
    await store.putSet(set);
    const summary = await inferExerciseSetups(store, KEY);

    await store.harvestFailureAnchor(set);

    expect(set.setupId).toBeUndefined();
    expect(rawAnchors(store)[0].setup_id).toBe(summary.setups[0].id);
  });
});

interface AnchorRow {
  set_id: string | null;
  setup_id: string | null;
}

function rawAnchors(store: SqliteSessionStore): AnchorRow[] {
  return query<AnchorRow>(
    store,
    `SELECT set_id, setup_id FROM failure_anchors ORDER BY observed_at`,
  );
}

/** The counting anchors one `where` clause selects, in selection order. */
function anchorTuples(store: SqliteSessionStore, where: string): unknown[] {
  return query(
    store,
    `SELECT fa.set_id, fa.observed_at, fa.terminal_velocity_mps
       FROM failure_anchors fa
      WHERE ${where} AND fa.lifter IS NULL AND fa.filter_verdict = 'failure'
      ORDER BY fa.observed_at ASC`,
  );
}

function query<T>(store: SqliteSessionStore, sql: string): T[] {
  const db = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db;
  return db.prepare(sql).all() as T[];
}
