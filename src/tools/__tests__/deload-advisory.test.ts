// VW-592: per-muscle breach discovery over `checkMrvGuard`, on an in-memory
// store with synthetic sessions. Every fixture is one exercise at a matched
// load, so rep count alone moves volume load from week to week.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exercise, Phase } from '@voltras/workout-analytics';

import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { SetPurpose, StoredRep } from '../../store/types.js';
import { collectDeloadBreaches, type DeloadAdvisoryDeps } from '../deload-advisory.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

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

const CATALOG: Record<string, string[]> = {
  'synthetic-press': ['chest'],
  'synthetic-fly': ['chest'],
  'synthetic-curl': ['biceps'],
};

interface SessionSpec {
  daysAgo: number;
  reps: number;
  exerciseId?: string;
  romM?: number;
  purpose?: SetPurpose;
  lifter?: string;
}

function makeRep(setId: string, index: number, romM: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, startTime: start, endTime: start + 1000, endPosition: romM },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + 1000,
      endTime: start + 3000,
      startPosition: romM,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

let store: SessionStore;
let deps: DeloadAdvisoryDeps;
let sessionCount = 0;

async function recordSession(spec: SessionSpec): Promise<string> {
  sessionCount += 1;
  const sessionId = `s${String(sessionCount)}`;
  const at = new Date(NOW.getTime() - spec.daysAgo * DAY_MS).toISOString();
  const lifter = spec.lifter === undefined ? {} : { lifter: spec.lifter };
  await store.putSession({ kind: 'training', id: sessionId, startedAt: at, ...lifter });
  await recordSet(sessionId, `${sessionId}-set`, spec);
  return sessionId;
}

async function recordSet(sessionId: string, setId: string, spec: SessionSpec): Promise<void> {
  const at = new Date(NOW.getTime() - spec.daysAgo * DAY_MS).toISOString();
  await store.putSet({
    userId: LOCAL_USER_ID,
    exerciseId: spec.exerciseId ?? 'synthetic-press',
    id: setId,
    sessionId,
    startedAt: at,
    endedAt: at,
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: spec.reps }, (_, i) => makeRep(setId, i, spec.romM ?? 0.5)),
    ...(spec.purpose === undefined ? {} : { setPurpose: spec.purpose }),
    ...(spec.lifter === undefined ? {} : { lifter: spec.lifter }),
  });
}

async function recordWeekly(
  reps: [number, number, number],
  exerciseId?: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, count] of reps.entries()) {
    ids.push(await recordSession({ daysAgo: 15 - i * 7, reps: count, exerciseId }));
  }
  return ids;
}

beforeEach(() => {
  store = openTestStore();
  sessionCount = 0;
  deps = {
    store,
    exercises: {
      getById: (id: string) =>
        CATALOG[id] === undefined ? undefined : ({ id, muscleGroups: CATALOG[id] } as Exercise),
    },
  };
});

afterEach(async () => {
  await store.close();
});

describe('collectDeloadBreaches', () => {
  it('confirms a muscle whose exercise missed on two consecutive sessions', async () => {
    // Arrange
    const ids = await recordWeekly([6, 4, 3]);

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toHaveLength(1);
    expect(muscles[0]).toMatchObject({
      muscle: 'chest',
      state: 'confirmed',
      confirmedAt: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
    });
    expect(muscles[0]?.evidence).toEqual([
      { exerciseId: 'synthetic-press', sessionIds: ids, reasoning: expect.any(String) },
    ]);
  });

  it('marks a single miss as provisional', async () => {
    // Arrange
    await recordWeekly([6, 4, 4]);

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'provisional' }]);
  });

  it('marks a muscle clear when both pairs held', async () => {
    // Arrange
    await recordWeekly([6, 6, 7]);

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'clear' }]);
  });

  it('marks a muscle inconclusive when the drift guard refuses both pairs', async () => {
    // Arrange: the middle session moved through a far shorter range than either neighbour
    await recordSession({ daysAgo: 15, reps: 10 });
    await recordSession({ daysAgo: 8, reps: 8, romM: 0.2 });
    await recordSession({ daysAgo: 1, reps: 6 });

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'inconclusive' }]);
    expect(muscles[0]?.evidence[0]?.reasoning).toContain('drift guard refused');
  });

  it('skips guest-labelled and non-working sessions when picking the last three', async () => {
    // Arrange
    const ids = await recordWeekly([6, 4, 3]);
    await recordSession({ daysAgo: 0.5, reps: 12, lifter: 'Guest' });
    for (const purpose of ['warmup', 'probe', 'technique'] as const) {
      await recordSession({ daysAgo: 0.25, reps: 12, purpose });
    }

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'confirmed' }]);
    expect(muscles[0]?.evidence[0]?.sessionIds).toEqual(ids);
  });

  it('does not report a muscle only a guest or a warm-up trained this week', async () => {
    // Arrange
    await recordSession({ daysAgo: 2, reps: 8, exerciseId: 'synthetic-curl', lifter: 'Guest' });
    await recordSession({ daysAgo: 1, reps: 8, exerciseId: 'synthetic-curl', purpose: 'warmup' });

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toEqual([]);
  });

  it('does not report a muscle a guest trained inside an owner session', async () => {
    // Arrange
    const ids = await recordWeekly([6, 4, 3]);
    const newest = ids[2] as string;
    await recordSet(newest, `${newest}-guest`, {
      daysAgo: 1,
      reps: 8,
      exerciseId: 'synthetic-curl',
      lifter: 'Guest',
    });

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles.map((signal) => signal.muscle)).toEqual(['chest']);
  });

  it('does not consider a muscle whose newest session is older than seven days', async () => {
    // Arrange
    await recordSession({ daysAgo: 22, reps: 6 });
    await recordSession({ daysAgo: 15, reps: 4 });
    await recordSession({ daysAgo: 8, reps: 3 });

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toEqual([]);
  });

  it('ignores sessions recorded after now', async () => {
    // Arrange
    await recordWeekly([6, 6, 7]);
    await recordSession({ daysAgo: -1, reps: 2 });

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'clear' }]);
  });

  it('downgrades a confirmation to provisional when a sibling exercise improved', async () => {
    // Arrange
    await recordWeekly([6, 4, 3], 'synthetic-press');
    await recordWeekly([6, 7, 8], 'synthetic-fly');

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'provisional' }]);
    expect(muscles[0]?.evidence.map((item) => item.exerciseId).sort()).toEqual([
      'synthetic-fly',
      'synthetic-press',
    ]);
  });

  it('keeps a confirmation when the sibling exercise only held', async () => {
    // Arrange
    await recordWeekly([6, 4, 3], 'synthetic-press');
    await recordWeekly([6, 6, 6], 'synthetic-fly');

    // Act
    const muscles = await collectDeloadBreaches(deps, NOW);

    // Assert
    expect(muscles).toMatchObject([{ muscle: 'chest', state: 'confirmed' }]);
  });
});
