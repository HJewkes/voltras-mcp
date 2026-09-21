// The RIR-velocity fit end to end over real stored sets (VW-298).
//
// The arithmetic is covered in `analytics/__tests__/rir-velocity.test.ts`.
// What is covered here is everything between a recorded set and a stored
// curve: which sets the anchor join admits, that the curve is keyed per
// exercise, and that a corpus which stops qualifying takes its stale curve
// with it.

import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { RIR_VELOCITY_MODEL_VERSION } from '../../analytics/rir-velocity.js';
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

function rep(setId: string, index: number, vCon: number): StoredRep {
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
      endPosition: 0.5,
    },
    eccentric: EMPTY_PHASE,
  };
}

/**
 * A six-rep set that decays to failure: the last rep sits under 70% of the
 * fastest non-first rep and the trajectory never turns back up, which is what
 * the harvest filter reads as a genuine grind-out.
 */
function failureSet(
  id: string,
  sessionId: string,
  exerciseId: string,
  velocities: readonly number[],
): StoredSet {
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    exerciseId,
    startedAt: daysAgo(3),
    endedAt: daysAgo(3),
    partial: false,
    trainingMode: 'Weight Training',
    weightLbs: 150,
    setPurpose: 'working',
    setIndexInSession: 1,
    reps: velocities.map((v, i) => rep(id, i, v)),
  };
}

const DECAY = [0.45, 0.42, 0.38, 0.34, 0.3, 0.26] as const;
/** Same shape, half the slope: a different lifter's curve on a second lift. */
const SHALLOW_DECAY = [0.6, 0.585, 0.57, 0.555, 0.54, 0.525] as const;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function session(id: string): StoredSession {
  return { id, startedAt: daysAgo(3), kind: 'training' };
}

async function storeWith(sets: readonly StoredSet[]): Promise<SqliteSessionStore> {
  const store = SqliteSessionStore.open(':memory:');
  const seen = new Set<string>();
  for (const set of sets) {
    if (!seen.has(set.sessionId)) {
      await store.putSession(session(set.sessionId));
      seen.add(set.sessionId);
    }
    await store.putSet(set);
    await store.harvestFailureAnchor(set);
  }
  return store;
}

/** Three failure sets of one exercise, one per session. */
function threeSessions(exerciseId: string, velocities: readonly number[]): StoredSet[] {
  return ['sess-1', 'sess-2', 'sess-3'].map((sessionId, i) =>
    failureSet(`${exerciseId}-set-${String(i)}`, sessionId, exerciseId, velocities),
  );
}

function rawDb(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

/** A stored curve as an earlier release wrote it, before the resistance family existed. */
function storeOldCurve(store: SqliteSessionStore, exerciseId: string, version: string): void {
  rawDb(store)
    .prepare(
      `INSERT INTO rir_velocity_models
        (user_id, exercise_id, model_json, fitted_at, sample_size, fit_quality)
       VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', 12, 0.9)`,
    )
    .run(LOCAL_USER_ID, exerciseId, JSON.stringify({ form: 'linear', version }));
}

describe('SqliteSessionStore — RIR-velocity fit', () => {
  // VW-489. The same corpus, one flag apart. A test pull is a true velocity at a
  // true load, but it is not taken at training effort, so it does not calibrate
  // anything. This is the mutant tripwire for the anchor join's kind filter.
  it('does not fit a curve from a corpus marked test', async () => {
    const store = await storeWith(threeSessions('row', DECAY));
    try {
      const trained = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');
      await store.setSessionKind(['sess-1', 'sess-2', 'sess-3'], 'test');
      const tested = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      expect(trained.model).not.toBeNull();
      expect(tested.model).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('fits and stores a curve from failure-anchored sets in the band', async () => {
    // Arrange
    const store = await storeWith(threeSessions('row', DECAY));
    try {
      // Act
      const fit = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      // Assert: 18 reps over 3 sets and 3 sessions, velocity rising with RIR.
      expect(fit.model).not.toBeNull();
      expect(fit.qualification).toMatchObject({
        qualifyingSets: 3,
        qualifyingSessions: 3,
        qualifyingPoints: 18,
      });
      expect(fit.model?.slopeMpsPerRir).toBeGreaterThan(0);
      expect(fit.model?.anchorSources).toEqual({ failure: 3, selfReport: 0 });

      const stored = await store.getRirVelocityModel(LOCAL_USER_ID, 'row');
      expect(stored?.sampleSize).toBe(18);
      expect(stored?.fitQuality).toBeGreaterThan(0.9);
    } finally {
      await store.close();
    }
  });

  it('keys the curve per exercise, so two lifts do not share one answer', async () => {
    // Arrange: the same lifter, two exercises, deliberately different decay.
    const store = await storeWith([
      ...threeSessions('row', DECAY),
      ...threeSessions('press', SHALLOW_DECAY),
    ]);
    try {
      // Act
      await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');
      await store.refitRirVelocityModel(LOCAL_USER_ID, 'press');

      // Assert
      const row = await store.getRirVelocityModel(LOCAL_USER_ID, 'row');
      const press = await store.getRirVelocityModel(LOCAL_USER_ID, 'press');
      expect(row?.model.slopeMpsPerRir).not.toEqual(press?.model.slopeMpsPerRir);
      expect(row?.model.interceptMps).not.toEqual(press?.model.interceptMps);
    } finally {
      await store.close();
    }
  });

  it('stores nothing for a lifter with one qualifying set', async () => {
    // Arrange
    const store = await storeWith(threeSessions('row', DECAY).slice(0, 1));
    try {
      // Act
      const fit = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      // Assert
      expect(fit.model).toBeNull();
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'row')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('ignores sets with no failure anchor rather than guessing their reps in reserve', async () => {
    // Arrange: recorded and in the band, but never harvested, so nothing says
    // how many reps were left.
    const store = SqliteSessionStore.open(':memory:');
    try {
      for (const set of threeSessions('row', DECAY)) {
        await store.putSession(session(set.sessionId));
        await store.putSet(set);
      }

      // Act
      const fit = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      // Assert
      expect(fit.model).toBeNull();
      expect(fit.qualification.qualifyingSets).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('deletes a stored curve when a new max drops its sets out of the band', async () => {
    // Arrange: a curve fitted from 150 lb sets, which sit at roughly 83% of the
    // estimate those same sets produce.
    const store = await storeWith(threeSessions('row', DECAY));
    try {
      await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'row')).not.toBeUndefined();

      // Act: a 250 lb single raises the reference 1RM far enough that every
      // fitted set is now under 70% of it.
      const heavy = failureSet('row-max', 'sess-4', 'row', [0.2]);
      await store.putSession(session('sess-4'));
      await store.putSet({ ...heavy, weightLbs: 250 });
      const refit = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      // Assert: no curve, and the stale one is gone rather than left readable.
      expect(refit.model).toBeNull();
      expect(refit.qualification.qualifyingSets).toBe(0);
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'row')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  // VW-538. Chains and eccentric overload change what a rep in reserve costs,
  // so their sets must not bend a constant-load curve.
  it('fits only the constant-load sets and says how many it saw', async () => {
    // Arrange: three constant-load failure sets, plus one under chains and one
    // under eccentric overload that would otherwise qualify.
    const constant = threeSessions('row', DECAY);
    const chains = { ...failureSet('row-chains', 'sess-1', 'row', DECAY), chainsLbs: 20 };
    const eccentric = { ...failureSet('row-ecc', 'sess-2', 'row', DECAY), eccentricPct: 15 };
    const store = await storeWith([...constant, chains, eccentric]);
    try {
      // Act
      const fit = await store.refitRirVelocityModel(LOCAL_USER_ID, 'row');

      // Assert
      expect(fit.qualification).toMatchObject({ observedSets: 3, qualifyingSets: 3 });
      expect(fit.model?.setCount).toBe(3);
      expect(fit.model?.resistanceFamily).toBe('constant');
      expect(fit.model?.version).toBe(RIR_VELOCITY_MODEL_VERSION);
    } finally {
      await store.close();
    }
  });

  it('refits a curve stored under an older version and removes one that no longer qualifies', async () => {
    // Arrange: 'row' still has a qualifying corpus, 'press' has none.
    const store = await storeWith(threeSessions('row', DECAY));
    try {
      storeOldCurve(store, 'row', 'rir-velocity@1.0.0');
      storeOldCurve(store, 'press', 'rir-velocity@1.0.0');

      // Act
      const counts = await store.refitStaleRirVelocityModels();
      const repeat = await store.refitStaleRirVelocityModels();

      // Assert
      expect(counts).toEqual({ stored: 2, refitted: 1, removed: 1 });
      expect(repeat).toEqual({ stored: 1, refitted: 0, removed: 0 });
      const row = await store.getRirVelocityModel(LOCAL_USER_ID, 'row');
      expect(row?.model).toMatchObject({
        version: RIR_VELOCITY_MODEL_VERSION,
        resistanceFamily: 'constant',
      });
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'press')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('leaves a curve stamped with the current version alone', async () => {
    // Arrange: no sets at all, so a refit would delete it.
    const store = SqliteSessionStore.open(':memory:');
    try {
      storeOldCurve(store, 'row', RIR_VELOCITY_MODEL_VERSION);

      // Act
      const counts = await store.refitStaleRirVelocityModels();

      // Assert
      expect(counts).toEqual({ stored: 1, refitted: 0, removed: 0 });
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'row')).not.toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
