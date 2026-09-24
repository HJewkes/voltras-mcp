// One test per reader that must not count a bench test (VW-489, chat design 7.4).
//
// Every case seeds the SAME work twice: once on a session marked `training` and
// once on a session marked `test`, at a load and a date that would change the
// answer if the test row leaked in. A reader that stopped filtering would return
// the test row's number, so each assertion is also the mutant's tripwire.
//
// The predicate lives in one place (`store/session-kind.ts`), applied at the
// store chokepoints that already carry `lifter IS NULL`. These tests run against
// a real sqlite store so the SQL itself is exercised, not a fake's filter.

import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { readTrainingDays } from '../../analytics/training-days.js';
import { getTierSignal } from '../../tools/tier-signal.js';
import { LOCAL_USER_ID, type SessionKind, type StoredRep, type StoredSet } from '../types.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

const EXERCISE = 'row';
const NOW = '2026-09-19T18:00:00.000Z';

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

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A five-rep set that grinds down to `terminal` m/s — the shape the harvest reads as failure. */
function decaySet(id: string, sessionId: string, at: string, weightLbs: number): StoredSet {
  const velocities = [0.6, 0.62, 0.55, 0.48, 0.4];
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    exerciseId: EXERCISE,
    startedAt: at,
    endedAt: at,
    partial: false,
    weightLbs,
    setIndexInSession: 1,
    reps: velocities.map((v, i) => rep(id, i, v)),
  };
}

/**
 * One session of one exercise, with three sets at `weightLbs`.
 *
 * The test day is the MORE RECENT and the HEAVIER of the pair on purpose: every
 * "most recent" and "top load" reader would prefer it if the predicate were
 * dropped.
 */
async function seedDay(
  store: SessionStore,
  id: string,
  kind: SessionKind,
  daysBack: number,
  weightLbs: number,
): Promise<void> {
  const at = daysAgo(daysBack);
  await store.putSession({
    id,
    startedAt: at,
    endedAt: at,
    exerciseId: EXERCISE,
    exerciseName: 'Cable Row',
    kind,
  });
  for (let i = 0; i < 3; i++) {
    const set = decaySet(`${id}-set-${String(i)}`, id, at, weightLbs);
    await store.putSet(set);
    await store.harvestFailureAnchor(set);
  }
}

/** The owner's shape in miniature: one real training day, one bench test since. */
async function openSeeded(): Promise<SessionStore> {
  const store = openTestStore();
  await seedDay(store, 'real', 'training', 5, 170);
  await seedDay(store, 'bench', 'test', 1, 250);
  return store;
}

describe('the shared test/training predicate, per reader (VW-489)', () => {
  it('training days: counts the training day, not the bench-test day', async () => {
    const store = await openSeeded();

    expect(await readTrainingDays(store, NOW)).toEqual([daysAgo(5).slice(0, 10)]);
    await store.close();
  });

  it('tier signal: counts one training day and reports nothing unreviewed', async () => {
    const store = await openSeeded();

    const signal = await getTierSignal({ store }, LOCAL_USER_ID);

    expect(signal.evidence.trainingDaysLogged).toBe(1);
    expect(signal.evidence.unreviewedDays).toBe(0);
    await store.close();
  });

  it('tier signal: reports unreviewed days rather than letting an empty count read as no history', async () => {
    const store = openTestStore();
    await store.putSession({ id: 'unmarked', startedAt: daysAgo(3), endedAt: daysAgo(3) });
    await store.putSet(decaySet('unmarked-set', 'unmarked', daysAgo(3), 100));

    const signal = await getTierSignal({ store }, LOCAL_USER_ID);

    expect(signal.evidence.trainingDaysLogged).toBe(0);
    expect(signal.evidence.unreviewedDays).toBe(1);
    await store.close();
  });

  it('session listing: history trends and the body map see the training session only', async () => {
    const store = await openSeeded();

    const sessions = await store.listSessions({});

    expect(sessions.map((s) => s.id)).toEqual(['real']);
    await store.close();
  });

  it('session listing: reads a bench test back only when asked for one by name', async () => {
    const store = await openSeeded();

    const tests = await store.listSessions({ kind: 'test' });
    const all = await store.listSessions({ kind: 'any' });

    expect(tests.map((s) => s.id)).toEqual(['bench']);
    expect(all.map((s) => s.id).sort()).toEqual(['bench', 'real']);
    await store.close();
  });

  it('per-exercise sets: progression and goal start values never see the bench-test load', async () => {
    const store = await openSeeded();

    const sets = await store.getSetsForExercise({
      userId: LOCAL_USER_ID,
      exerciseId: EXERCISE,
    });

    expect(sets).toHaveLength(3);
    expect([...new Set(sets.map((s) => s.weightLbs))]).toEqual([170]);
    await store.close();
  });

  it('last-time read: the basis session is the last one he TRAINED, not the last one recorded', async () => {
    const store = await openSeeded();

    const basis = await store.getMostRecentSessionIdForExercise({
      userId: LOCAL_USER_ID,
      exerciseId: EXERCISE,
    });

    expect(basis).toBe('real');
    await store.close();
  });

  it('baselines: the anchors behind a baseline are the training sets only', async () => {
    const store = await openSeeded();

    const report = await store.describeAnchorSelection({
      userId: LOCAL_USER_ID,
      exerciseId: EXERCISE,
    });

    expect(report.anchorCount).toBe(3);
    await store.close();
  });

  it('review list: shows the bench test and the training day, which no analytic read does', async () => {
    const store = await openSeeded();

    const rows = await store.listSessionReviewRows({ kind: 'any' });

    expect(rows.map((row) => row.sessionId).sort()).toEqual(['bench', 'real']);
    expect(rows.find((row) => row.sessionId === 'bench')?.kind).toBe('test');
    await store.close();
  });

  it('marking cascades to the sets, so the set-level readers move with the session', async () => {
    const store = await openSeeded();

    await store.setSessionKind(['bench'], 'training');
    const sets = await store.getSetsForExercise({
      userId: LOCAL_USER_ID,
      exerciseId: EXERCISE,
    });

    expect(sets).toHaveLength(6);
    expect(sets.every((set) => set.kind === 'training')).toBe(true);
    await store.close();
  });
});
