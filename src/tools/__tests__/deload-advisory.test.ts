// VW-592: per-muscle breach discovery over `checkMrvGuard`, on an in-memory
// store with synthetic sessions (`fixtures/deload-sessions.ts`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectDeloadBreaches, type DeloadAdvisoryDeps } from '../deload-advisory.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { catalogExercise, deloadSessionRecorder } from './fixtures/deload-sessions.js';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let store: SessionStore;
let deps: DeloadAdvisoryDeps;
let recordSet: ReturnType<typeof deloadSessionRecorder>['recordSet'];
let recordSession: ReturnType<typeof deloadSessionRecorder>['recordSession'];
let recordWeekly: ReturnType<typeof deloadSessionRecorder>['recordWeekly'];

beforeEach(() => {
  store = openTestStore();
  ({ recordSet, recordSession, recordWeekly } = deloadSessionRecorder(store, NOW));
  deps = { store, exercises: { getById: catalogExercise } };
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
