// VW-975: a comparison whose sessions span a break of 15+ days is not a regression signal.
//
// The rule lives in the drift guard, which the MRV guard runs first, so both are covered here
// against a real store. Every fixture is synthetic.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BaselineKey, Phase } from '@voltras/workout-analytics';

import { checkDriftGuard } from '../../store/drift-guard.js';
import { checkMrvGuard } from '../../store/mrv-guard.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID, type StoredRep, type StoredSet } from '../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW - n * DAY_MS).toISOString();

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

function makeRep(setId: string, index: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: start,
      endTime: start + 1000,
      endPosition: 0.5,
      _totalVelocity: 0.5,
      _movementSampleCount: 1,
    },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + 1000,
      endTime: start + 3000,
      startPosition: 0.5,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

const key: BaselineKey = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

async function putSession(
  store: SessionStore,
  id: string,
  ageDays: number,
  exerciseId: string,
  repCount: number,
): Promise<void> {
  const at = daysAgo(ageDays);
  await store.putSession({ kind: 'training', id, startedAt: at, endedAt: at });
  const set: StoredSet = {
    id: `${id}-set`,
    sessionId: id,
    userId: LOCAL_USER_ID,
    exerciseId,
    startedAt: at,
    endedAt: at,
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(`${id}-set`, i)),
  };
  await store.putSet(set);
}

/** Ten reps, then six (a 40% volume-load drop at the same load), then four. */
async function putDecline(store: SessionStore, ages: readonly [number, number, number]) {
  await putSession(store, 's1', ages[0], 'bench-press', 10);
  await putSession(store, 's2', ages[1], 'bench-press', 6);
  await putSession(store, 's3', ages[2], 'bench-press', 4);
}

const mrv = (store: SessionStore) =>
  checkMrvGuard(store, { key, session1Id: 's1', session2Id: 's2', session3Id: 's3' });

describe('mrvguard across a layoff', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = openTestStore();
  });

  it('gives no advisory when a 60-day gap sits before a 40% load drop', async () => {
    await putDecline(store, [66, 6, 3]);

    const { priorPair, guard } = await mrv(store);

    expect(priorPair.evaluable).toBe(false);
    expect(priorPair.reasoning).toMatch(/60-day break/);
    expect(guard.mrvFlagged).toBe(false);
  });

  it('still flags the same drop without a gap', async () => {
    await putDecline(store, [9, 6, 3]);

    const { priorPair, guard } = await mrv(store);

    expect(priorPair.volumeLoadDeltaPct).toBeCloseTo(-40, 5);
    expect(guard.mrvFlagged).toBe(true);
  });

  it('flags the drop when other lifts were trained through the gap', async () => {
    await putDecline(store, [66, 6, 3]);
    for (let age = 59; age > 6; age -= 7) {
      await putSession(store, `squat-${String(age)}`, age, 'squat', 5);
    }

    const { guard } = await mrv(store);

    expect(guard.mrvFlagged).toBe(true);
  });
});

describe('driftguard across a layoff', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = openTestStore();
  });

  const drift = () =>
    checkDriftGuard(store, { key, baselineSessionId: 's1', currentSessionId: 's2' });

  it('refuses a pair either side of a 15-day break', async () => {
    await putSession(store, 's1', 20, 'bench-press', 6);
    await putSession(store, 's2', 5, 'bench-press', 6);

    const verdict = await drift();

    expect(verdict.comparable).toBe(false);
    expect(verdict.reasoning).toMatch(/15-day break/);
  });

  it('compares a pair 14 days apart, inside the no-break band', async () => {
    await putSession(store, 's1', 19, 'bench-press', 6);
    await putSession(store, 's2', 5, 'bench-press', 6);

    const verdict = await drift();

    expect(verdict.comparable).toBe(true);
  });
});
