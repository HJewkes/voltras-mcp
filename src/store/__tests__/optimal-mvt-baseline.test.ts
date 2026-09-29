// VW-299 end to end: `baselines.recalc` fits the MVT from stored sets and
// persists it beside the observed V1RM it replaces.
//
// The history is the same four sessions the pure fitter's own test uses, seeded
// through the store this time, so the numbers below are the ones a caller
// actually reads off `exercise_baselines` rather than a repeat of the unit
// test's arithmetic.

import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import {
  LOCAL_USER_ID,
  type StoredFailureAnchor,
  type StoredRep,
  type StoredSession,
  type StoredSet,
} from '../types.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

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

function rep(setId: string, index: number, velocity: number): StoredRep {
  return {
    id: `${setId}-rep-${String(index)}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      _totalVelocity: velocity,
      _movementSampleCount: 1,
      _lastMovementVelocity: velocity,
      peakVelocity: velocity,
      endPosition: 0.5,
    },
    eccentric: EMPTY_PHASE,
  };
}

interface SetSpec {
  id: string;
  loadLbs: number;
  velocity: number;
  reps: number;
  failure?: boolean;
}

interface SessionSpec {
  id: string;
  startedAt: string;
  sets: SetSpec[];
}

/** Four sessions: a stable submaximal ramp, unstable maximal singles. */
const HISTORY: SessionSpec[] = [
  {
    id: 's1',
    startedAt: '2026-06-01T10:00:00.000Z',
    sets: [
      { id: 's1-a', loadLbs: 120, velocity: 0.56, reps: 5 },
      { id: 's1-b', loadLbs: 150, velocity: 0.42, reps: 3 },
      { id: 's1-c', loadLbs: 200, velocity: 0.3, reps: 1, failure: true },
    ],
  },
  {
    id: 's2',
    startedAt: '2026-06-08T10:00:00.000Z',
    sets: [
      { id: 's2-a', loadLbs: 130, velocity: 0.51, reps: 5 },
      { id: 's2-b', loadLbs: 160, velocity: 0.38, reps: 3 },
      { id: 's2-c', loadLbs: 175, velocity: 0.31, reps: 4, failure: true },
    ],
  },
  {
    id: 's3',
    startedAt: '2026-06-15T10:00:00.000Z',
    sets: [
      { id: 's3-a', loadLbs: 125, velocity: 0.54, reps: 5 },
      { id: 's3-b', loadLbs: 155, velocity: 0.4, reps: 3 },
      { id: 's3-c', loadLbs: 198, velocity: 0.12, reps: 1, failure: true },
    ],
  },
  {
    id: 's4',
    startedAt: '2026-06-22T10:00:00.000Z',
    sets: [
      { id: 's4-a', loadLbs: 135, velocity: 0.49, reps: 5 },
      { id: 's4-b', loadLbs: 165, velocity: 0.36, reps: 3 },
      { id: 's4-c', loadLbs: 180, velocity: 0.29, reps: 3, failure: true },
    ],
  },
];

function toStoredSet(spec: SetSpec, session: SessionSpec): StoredSet {
  return {
    id: spec.id,
    sessionId: session.id,
    userId: LOCAL_USER_ID,
    exerciseId: 'row',
    startedAt: session.startedAt,
    endedAt: session.startedAt,
    partial: false,
    weightLbs: spec.loadLbs,
    setIndexInSession: 1,
    reps: Array.from({ length: spec.reps }, (_, i) => rep(spec.id, i, spec.velocity)),
  };
}

function toAnchor(spec: SetSpec, session: SessionSpec): StoredFailureAnchor {
  return {
    id: `anchor-${spec.id}`,
    userId: LOCAL_USER_ID,
    setId: spec.id,
    exerciseId: 'row',
    observedAt: session.startedAt,
    source: 'harvested',
    terminalVelocityMps: spec.velocity,
    loadLbs: spec.loadLbs,
    repCount: spec.reps,
    filterInputs: {},
    filterVerdict: 'failure',
    filterVersion: 'test@1',
  };
}

async function openWith(history: SessionSpec[]): Promise<SessionStore> {
  const store = openTestStore();
  for (const session of history) {
    const first: StoredSession = {
      id: session.id,
      startedAt: session.startedAt,
      exerciseId: 'row',
      exerciseName: 'Cable Row',
      kind: 'training',
    };
    await store.putSession(first);
    for (const spec of session.sets) {
      await store.putSet(toStoredSet(spec, session));
      if (spec.failure === true) await store.putFailureAnchor(toAnchor(spec, session));
    }
  }
  return store;
}

describe('baselines.recalc — fitted MVT (VW-299)', () => {
  it('stores a threshold away from the observed V1RM, with the error it achieved', async () => {
    const store = await openWith(HISTORY);
    try {
      const baseline = await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });

      // The heavier of the two maximal singles was recorded at 0.30 m/s. The
      // fit does not use it: predicting each session's 1RM from 0.265 m/s is
      // wrong by 4.02 % against 6.63 % from the observed velocity.
      expect(baseline.optimalMvtObservedV1rm).toBe(0.3);
      expect(baseline.optimalMvt).toBe(0.265);
      expect(baseline.optimalMvtErrorPct).toBe(4.02);
      expect(baseline.optimalMvtSampleSize).toBe(4);
    } finally {
      await store.close();
    }
  });

  it('reads back off the stored row, not just out of the recalc return', async () => {
    const store = await openWith(HISTORY);
    try {
      await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });
      const read = await store.getBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });

      expect(read?.optimalMvt).toBe(0.265);
      expect(read?.optimalMvtObservedV1rm).toBe(0.3);
    } finally {
      await store.close();
    }
  });

  it('leaves the threshold unset when no set was taken to failure', async () => {
    const unanchored = HISTORY.map((session) => ({
      ...session,
      sets: session.sets.map((set) => ({ ...set, failure: false })),
    }));
    const store = await openWith(unanchored);
    try {
      const baseline = await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });

      expect(baseline).not.toHaveProperty('optimalMvt');
      expect(baseline).not.toHaveProperty('optimalMvtObservedV1rm');
    } finally {
      await store.close();
    }
  });

  it('clears a stored fit once the history behind it no longer supports one', async () => {
    const store = await openWith(HISTORY);
    try {
      await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });
      for (const session of HISTORY) {
        for (const spec of session.sets) {
          if (spec.failure === true) {
            await store.putFailureAnchor({
              ...toAnchor(spec, session),
              filterVerdict: 'not_candidate',
            });
          }
        }
      }
      await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });

      const read = await store.getBaseline({ userId: LOCAL_USER_ID, exerciseId: 'row' });
      expect(read).not.toHaveProperty('optimalMvt');
    } finally {
      await store.close();
    }
  });
});
