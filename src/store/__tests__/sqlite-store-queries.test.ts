// Tests for the Wave-2 read API: counts, the by-id planning-tree getters, and
// the per-exercise set query (schema v7).
//
// Two behaviours here are load-bearing and easy to get subtly wrong:
//
//   * `countSets({ collapseBilateral: true })` counts GROUPS. A NULL
//     `bilateral_group_id` is not a group — the obvious `COUNT(DISTINCT ...)`
//     implementation folds every ungrouped set into one and silently
//     under-counts. The multi-NULL case below is the guard for that.
//   * An EMPTY `purpose` array matches nothing. An empty filter list that
//     silently means "all" returns warm-ups to a caller who asked for working
//     sets, with nothing erroring.
//
// `setup_id` and the non-warmup `set_purpose` values have no writer yet
// (`putSet` writes 'working'/'warmup' and never touches `setup_id`), so those
// fixtures are seeded through the raw handle. That is deliberate: inventing a
// writer here would be a different change than closing the read gap.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Phase, Rep } from '@voltras/workout-analytics';
import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSet } from '../types.js';

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
  const rep: Rep = {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.62, peakForce: 88 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.41 },
  };
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

function makeSet(overrides: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: 'sess-1',
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:01:00.000Z',
    partial: false,
    reps: [],
    ...overrides,
  };
}

function rawDb(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe('SqliteSessionStore.countSessions', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 's1', startedAt: '2025-01-01T00:00:00.000Z' });
    await store.putSession({
      id: 's2',
      startedAt: '2025-02-01T00:00:00.000Z',
      exerciseId: 'bench-press',
    });
    await store.putSession({
      id: 's3',
      startedAt: '2025-03-01T00:00:00.000Z',
      exerciseId: 'bench-press',
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it('counts every session with no filter', async () => {
    expect(await store.countSessions()).toBe(3);
    expect(await store.countSessions({})).toBe(3);
  });

  it('counts within a date window', async () => {
    expect(await store.countSessions({ from: '2025-02-01T00:00:00.000Z' })).toBe(2);
    expect(await store.countSessions({ to: '2025-02-01T00:00:00.000Z' })).toBe(2);
    expect(
      await store.countSessions({
        from: '2025-01-15T00:00:00.000Z',
        to: '2025-02-15T00:00:00.000Z',
      }),
    ).toBe(1);
  });

  it('counts by exercise, and composes with the date window', async () => {
    expect(await store.countSessions({ exerciseId: 'bench-press' })).toBe(2);
    expect(
      await store.countSessions({ exerciseId: 'bench-press', from: '2025-03-01T00:00:00.000Z' }),
    ).toBe(1);
    expect(await store.countSessions({ exerciseId: 'squat' })).toBe(0);
  });

  it('counts by user', async () => {
    // `putSession` does not write `sessions.user_id` (no writer as of v7), so
    // the dimension is seeded directly to exercise the filter.
    rawDb(store).exec(`UPDATE sessions SET user_id = '${LOCAL_USER_ID}' WHERE id IN ('s1','s2')`);
    expect(await store.countSessions({ userId: LOCAL_USER_ID })).toBe(2);
    expect(await store.countSessions({ userId: 'nobody' })).toBe(0);
  });

  it('ignores pagination — the count of a page is not a count', async () => {
    expect(await store.countSessions({ limit: 1, offset: 2 })).toBe(3);
  });
});

describe('SqliteSessionStore planning-tree by-id getters', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Base',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Accumulation',
      focus: 'hypertrophy',
      weeksCount: 4,
    });
    await store.putTrainingWeek({
      id: 'week-1',
      blockId: 'block-1',
      orderIndex: 2,
      name: 'Week 3',
    });
    await store.putWorkoutTemplate({
      id: 'tmpl-1',
      weekId: 'week-1',
      name: 'Upper A',
      orderIndex: 0,
    });
    await store.putPlannedExercise({
      id: 'pe-1',
      workoutTemplateId: 'tmpl-1',
      exerciseId: 'bench-press',
      orderIndex: 0,
      targetSets: 3,
      targetRepsLow: 6,
      targetRepsHigh: 8,
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it('walks a planned exercise back up to its block', async () => {
    const planned = await store.getPlannedExercise('pe-1');
    expect(planned).toMatchObject({
      id: 'pe-1',
      workoutTemplateId: 'tmpl-1',
      exerciseId: 'bench-press',
      targetSets: 3,
      targetRepsLow: 6,
      targetRepsHigh: 8,
    });

    const template = await store.getWorkoutTemplate(planned?.workoutTemplateId ?? '');
    const week = await store.getTrainingWeek(template?.weekId ?? '');
    expect(week).toEqual({ id: 'week-1', blockId: 'block-1', orderIndex: 2, name: 'Week 3' });

    const block = await store.getTrainingBlock(week?.blockId ?? '');
    expect(block).toMatchObject({ id: 'block-1', programId: 'prog-1', focus: 'hypertrophy' });
  });

  it('returns undefined for a missing id', async () => {
    expect(await store.getTrainingWeek('no-such-week')).toBeUndefined();
    expect(await store.getTrainingBlock('no-such-block')).toBeUndefined();
    expect(await store.getPlannedExercise('no-such-exercise')).toBeUndefined();
  });
});

describe('SqliteSessionStore.countSets', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: '2025-01-01T00:00:00.000Z' });
  });

  afterEach(async () => {
    await store.close();
  });

  it('counts rows by default and groups when collapsing', async () => {
    // One bilateral pair (two rows, one group id) plus two unpaired sets.
    await store.putSet(makeSet({ id: 'set-L', side: 'left', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-R', side: 'right', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-3' }));
    await store.putSet(makeSet({ id: 'set-4' }));

    expect(await store.countSets({})).toBe(4);
    expect(await store.countSets({ collapseBilateral: false })).toBe(4);
    expect(await store.countSets({ collapseBilateral: true })).toBe(3);
  });

  it('does not collapse NULL-group sets into one', async () => {
    // The bug this guards: `COUNT(DISTINCT bilateral_group_id)` treats every
    // NULL as the same bucket, so five single-armed sets would count as one.
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await store.putSet(makeSet({ id: `set-${id}` }));
    }
    expect(await store.countSets({ collapseBilateral: true })).toBe(5);
  });

  it('counts each bilateral group once regardless of how many groups there are', async () => {
    await store.putSet(makeSet({ id: 'set-1L', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-1R', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-2L', bilateralGroupId: 'g2' }));
    await store.putSet(makeSet({ id: 'set-2R', bilateralGroupId: 'g2' }));
    await store.putSet(makeSet({ id: 'set-solo' }));

    expect(await store.countSets({})).toBe(5);
    expect(await store.countSets({ collapseBilateral: true })).toBe(3);
  });

  it('filters by session and user, and composes with collapsing', async () => {
    await store.putSession({ id: 'sess-2', startedAt: '2025-01-02T00:00:00.000Z' });
    await store.putSet(makeSet({ id: 'set-1', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-2', bilateralGroupId: 'g1' }));
    await store.putSet(makeSet({ id: 'set-3', sessionId: 'sess-2' }));

    expect(await store.countSets({ sessionId: 'sess-1' })).toBe(2);
    expect(await store.countSets({ sessionId: 'sess-1', collapseBilateral: true })).toBe(1);
    expect(await store.countSets({ sessionId: 'sess-2' })).toBe(1);
    expect(await store.countSets({ userId: LOCAL_USER_ID })).toBe(3);
    expect(await store.countSets({ userId: 'nobody' })).toBe(0);
  });

  it('counts zero on an empty store', async () => {
    expect(await store.countSets({})).toBe(0);
    expect(await store.countSets({ collapseBilateral: true })).toBe(0);
  });
});

describe('SqliteSessionStore.getSetsForExercise', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: '2025-01-01T00:00:00.000Z' });
    await store.putSession({ id: 'sess-2', startedAt: '2025-02-01T00:00:00.000Z' });

    // Two setups for the same exercise, seeded raw: setup inference has no
    // writer yet, and `sets.setup_id` is an FK into this table.
    rawDb(store).exec(`
      INSERT INTO exercise_setups (id, user_id, exercise_id, detected_at)
      VALUES ('setup-a', '${LOCAL_USER_ID}', 'bench-press', '2025-01-01T00:00:00.000Z'),
             ('setup-b', '${LOCAL_USER_ID}', 'bench-press', '2025-01-01T00:00:00.000Z');
    `);

    await store.putSet(
      makeSet({
        id: 'bench-1',
        startedAt: '2025-01-01T00:10:00.000Z',
        side: 'left',
        settingsHash: 'v1:aaa',
        reps: [makeRep('bench-1', 0), makeRep('bench-1', 1)],
      }),
    );
    await store.putSet(
      makeSet({
        id: 'bench-2',
        startedAt: '2025-01-01T00:20:00.000Z',
        side: 'right',
        settingsHash: 'v1:bbb',
      }),
    );
    await store.putSet(
      makeSet({
        id: 'bench-3',
        sessionId: 'sess-2',
        startedAt: '2025-02-01T00:10:00.000Z',
        side: 'left',
        settingsHash: 'v1:aaa',
        isWarmup: true,
      }),
    );
    await store.putSet(
      makeSet({ id: 'squat-1', exerciseId: 'squat', startedAt: '2025-01-01T00:30:00.000Z' }),
    );

    rawDb(store).exec(`
      UPDATE sets SET setup_id = 'setup-a' WHERE id IN ('bench-1','bench-3');
      UPDATE sets SET setup_id = 'setup-b' WHERE id = 'bench-2';
      UPDATE sets SET set_purpose = 'probe' WHERE id = 'bench-2';
    `);
  });

  afterEach(async () => {
    await store.close();
  });

  async function ids(filter: Parameters<SqliteSessionStore['getSetsForExercise']>[0]) {
    const sets = await store.getSetsForExercise(filter);
    return sets.map((s) => s.id);
  }

  const KEY = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  it('returns only the named exercise, oldest-first', async () => {
    expect(await ids(KEY)).toEqual(['bench-1', 'bench-2', 'bench-3']);
    expect(await ids({ ...KEY, exerciseId: 'squat' })).toEqual(['squat-1']);
    expect(await ids({ ...KEY, exerciseId: 'deadlift' })).toEqual([]);
  });

  it('scopes to the user', async () => {
    expect(await ids({ ...KEY, userId: 'nobody' })).toEqual([]);
  });

  it('filters by setup', async () => {
    expect(await ids({ ...KEY, setupId: 'setup-a' })).toEqual(['bench-1', 'bench-3']);
    expect(await ids({ ...KEY, setupId: 'setup-b' })).toEqual(['bench-2']);
  });

  it('filters by side', async () => {
    expect(await ids({ ...KEY, side: 'left' })).toEqual(['bench-1', 'bench-3']);
    expect(await ids({ ...KEY, side: 'right' })).toEqual(['bench-2']);
  });

  it('filters by settings hash', async () => {
    expect(await ids({ ...KEY, settingsHash: 'v1:aaa' })).toEqual(['bench-1', 'bench-3']);
    expect(await ids({ ...KEY, settingsHash: 'v1:zzz' })).toEqual([]);
  });

  it('filters by purpose, including multi-value lists', async () => {
    expect(await ids({ ...KEY, purpose: ['working'] })).toEqual(['bench-1']);
    expect(await ids({ ...KEY, purpose: ['warmup'] })).toEqual(['bench-3']);
    expect(await ids({ ...KEY, purpose: ['probe'] })).toEqual(['bench-2']);
    expect(await ids({ ...KEY, purpose: ['working', 'probe'] })).toEqual(['bench-1', 'bench-2']);
    expect(await ids({ ...KEY, purpose: ['technique'] })).toEqual([]);
  });

  it('matches nothing on an empty purpose list', async () => {
    expect(await ids({ ...KEY, purpose: [] })).toEqual([]);
  });

  it('filters by date range', async () => {
    expect(await ids({ ...KEY, from: '2025-02-01T00:00:00.000Z' })).toEqual(['bench-3']);
    expect(await ids({ ...KEY, to: '2025-01-01T00:15:00.000Z' })).toEqual(['bench-1']);
    expect(
      await ids({ ...KEY, from: '2025-01-01T00:00:00.000Z', to: '2025-01-31T00:00:00.000Z' }),
    ).toEqual(['bench-1', 'bench-2']);
  });

  it('applies a limit, and is unbounded without one', async () => {
    expect(await ids({ ...KEY, limit: 2 })).toEqual(['bench-1', 'bench-2']);
    expect(await ids({ ...KEY, limit: 1 })).toEqual(['bench-1']);
    expect((await ids(KEY)).length).toBe(3);
  });

  it('composes every filter', async () => {
    expect(
      await ids({
        ...KEY,
        setupId: 'setup-a',
        side: 'left',
        settingsHash: 'v1:aaa',
        purpose: ['working', 'warmup'],
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-01-31T00:00:00.000Z',
      }),
    ).toEqual(['bench-1']);
    // One member changed, nothing matches — the filters really do AND.
    expect(await ids({ ...KEY, setupId: 'setup-a', side: 'left', settingsHash: 'v1:bbb' })).toEqual(
      [],
    );
  });

  it('returns sets with their reps loaded', async () => {
    const [set] = await store.getSetsForExercise({ ...KEY, limit: 1 });
    expect(set?.reps).toHaveLength(2);
    expect(set?.reps[0]).toMatchObject({ id: 'bench-1-r0', setId: 'bench-1', index: 0 });
    expect(set?.reps[0]?.concentric.peakForce).toBe(88);
  });

  it('passes gaps through as gaps', async () => {
    // `weightLbs` and `trainingMode` were never written on these fixtures.
    const [set] = await store.getSetsForExercise({ ...KEY, limit: 1 });
    expect(set).not.toHaveProperty('weightLbs');
    expect(set).not.toHaveProperty('trainingMode');
  });
});
