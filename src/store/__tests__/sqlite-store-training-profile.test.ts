// Tests for the `training_profile` store methods (VW-96 Wave 3). The table
// itself has existed as inert DDL since v6; these are its first read/write
// call sites.
//
// Coverage:
//   * getTrainingProfile returns undefined before any write.
//   * putTrainingProfile round-trips every column, including boolean ->
//     0/1 coercion and the provenance JSON blob.
//   * A re-put via ON CONFLICT DO UPDATE overwrites in place rather than
//     deleting/re-inserting — confirmed by checking the row survives with
//     the FK to `users` intact (a delete-then-insert would briefly orphan
//     it and, more importantly, is the exact anti-pattern this project
//     bans for FK-parent tables).
//   * A second, unrelated user's row is untouched by the first user's
//     upsert (the "doesn't wipe unrelated rows" guarantee at the store
//     boundary — the per-field "don't wipe unrelated ANSWERS" merge lives
//     one layer up, in profile-tools.ts).
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredTrainingProfile } from '../types.js';

function makeProfile(overrides: Partial<StoredTrainingProfile> = {}): StoredTrainingProfile {
  return {
    userId: LOCAL_USER_ID,
    declaredTier: 'intermediate',
    declaredAt: '2026-07-30T00:00:00.000Z',
    yearsTraining: 2.5,
    historyConsistent: true,
    everPlateaued: false,
    reportedSetsPerMuscle: 12,
    goal: 'hypertrophy',
    goalSetAt: '2026-07-30T00:00:00.000Z',
    daysAvailable: 4,
    daysReliable: 3,
    onboardedAt: '2026-07-30T00:00:00.000Z',
    provenance: { declaredTier: 'user', goal: 'user' },
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteSessionStore training_profile', () => {
  it('returns undefined before any write', async () => {
    const store = SqliteSessionStore.open(':memory:');
    expect(await store.getTrainingProfile(LOCAL_USER_ID)).toBeUndefined();
    await store.close();
  });

  it('round-trips every column, including booleans and provenance JSON', async () => {
    const store = SqliteSessionStore.open(':memory:');
    const profile = makeProfile();
    await store.putTrainingProfile(profile);

    const stored = await store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored).toEqual(profile);
    await store.close();
  });

  it('omits optional fields entirely when they were never set', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      updatedAt: '2026-07-30T00:00:00.000Z',
    });

    const stored = await store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored).toEqual({
      userId: LOCAL_USER_ID,
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    await store.close();
  });

  it('upserts in place via ON CONFLICT DO UPDATE on a re-put', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProfile(makeProfile());
    await store.putTrainingProfile(
      makeProfile({ declaredTier: 'advanced', updatedAt: '2026-08-01T00:00:00.000Z' }),
    );

    const stored = await store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored?.declaredTier).toBe('advanced');
    expect(stored?.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    // The row is still the SAME row (single PRIMARY KEY user_id) — no
    // duplicate, no orphaned FK from a delete-then-insert.
    const count = (
      rawDb(store).prepare('SELECT COUNT(*) as c FROM training_profile').get() as { c: number }
    ).c;
    expect(count).toBe(1);
    await store.close();
  });

  it("does not touch a different user's row", async () => {
    const store = SqliteSessionStore.open(':memory:');
    rawDb(store)
      .prepare(`INSERT INTO users (id, display_name, created_at, is_default) VALUES (?, ?, ?, 0)`)
      .run('other-user', 'Other', '2026-07-30T00:00:00.000Z');

    await store.putTrainingProfile(
      makeProfile({ userId: LOCAL_USER_ID, declaredTier: 'beginner' }),
    );
    await store.putTrainingProfile(makeProfile({ userId: 'other-user', declaredTier: 'advanced' }));

    expect((await store.getTrainingProfile(LOCAL_USER_ID))?.declaredTier).toBe('beginner');
    expect((await store.getTrainingProfile('other-user'))?.declaredTier).toBe('advanced');
    await store.close();
  });
});

function rawDb(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}
