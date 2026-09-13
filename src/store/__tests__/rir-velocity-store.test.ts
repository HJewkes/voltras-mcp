// The RIR-velocity fit end to end over real stored sets (VW-298).
//
// The arithmetic is covered in `analytics/__tests__/rir-velocity.test.ts`.
// What is covered here is everything between a recorded set and a stored
// curve: which sets the anchor join admits, that the curve is keyed per
// exercise, and that a corpus which stops qualifying takes its stale curve
// with it.

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
  return { id, startedAt: daysAgo(3) };
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

describe('SqliteSessionStore — RIR-velocity fit', () => {
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
});
