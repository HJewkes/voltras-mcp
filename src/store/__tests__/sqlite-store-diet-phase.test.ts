// Tests for the `diet_phases` writer and its readers (VW-149 / VW-150).
//
// The table and the `sessions.diet_phase` column have been inert DDL since v6;
// these are their first write call sites. There is NO DDL change here, so the
// "pre-existing database" case is a fresh temp file on the CURRENT schema,
// closed and reopened — with no schema movement, that IS a database created
// before this change. The real store file is never touched.
//
// Coverage shape, one describe per invariant the review asked for:
//   * Declaring closes the open range, so at most one range is open.
//   * A retroactive `startedAt` rewrites the timeline forward and leaves
//     exactly one covering range per probed instant.
//   * The stamp on a NEW session agrees with the table; after a retroactive
//     correction the stamp goes stale and the TABLE wins on read.
//   * A guest lifter's session is never stamped and never resolves.
//   * `training_weeks.phase_type` is neither read nor written.
//   * `SCHEMA_VERSION` does not move.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';

const T = {
  jan: '2026-01-01T00:00:00.000Z',
  feb: '2026-02-01T00:00:00.000Z',
  mar: '2026-03-01T00:00:00.000Z',
  apr: '2026-04-01T00:00:00.000Z',
} as const;

const DECLARED_AT = '2026-04-15T00:00:00.000Z';

function open(): SqliteSessionStore {
  return SqliteSessionStore.open(':memory:');
}

async function declare(store: SqliteSessionStore, phase: string, startedAt: string): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase,
    startedAt,
    declaredAt: DECLARED_AT,
  });
}

describe('declareDietPhase — overlap freedom', () => {
  it('closes the open range at the new start rather than leaving two open', async () => {
    const store = open();
    await declare(store, 'gain', T.jan);
    await declare(store, 'fat-loss', T.mar);

    const timeline = await store.listDietPhases(LOCAL_USER_ID);
    expect(timeline.map((p) => [p.phase, p.startedAt, p.endedAt])).toEqual([
      ['gain', T.jan, T.mar],
      ['fat-loss', T.mar, undefined],
    ]);
  });

  it('leaves exactly one covering range per instant after a retroactive correction', async () => {
    const store = open();
    await declare(store, 'gain', T.jan);
    await declare(store, 'maintenance', T.mar);
    // The correction: "actually I started cutting in February." It supersedes
    // the March declaration entirely.
    await declare(store, 'fat-loss', T.feb);

    const timeline = await store.listDietPhases(LOCAL_USER_ID);
    expect(timeline.map((p) => [p.phase, p.startedAt, p.endedAt])).toEqual([
      ['gain', T.jan, T.feb],
      ['fat-loss', T.feb, undefined],
    ]);
    for (const [instant, expected] of [
      [T.jan, 'gain'],
      ['2026-01-31T23:59:59.999Z', 'gain'],
      [T.feb, 'fat-loss'],
      [T.mar, 'fat-loss'],
      [T.apr, 'fat-loss'],
    ] as const) {
      const covering = await store.getDietPhaseCovering(LOCAL_USER_ID, instant, instant);
      expect(covering?.phase, instant).toBe(expected);
    }
  });

  it('re-declaring at the same instant replaces rather than duplicating', async () => {
    const store = open();
    await declare(store, 'gain', T.feb);
    await declare(store, 'maintenance', T.feb);

    const timeline = await store.listDietPhases(LOCAL_USER_ID);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.phase).toBe('maintenance');
  });

  it('reports no covering phase for a window straddling two phases', async () => {
    const store = open();
    await declare(store, 'gain', T.jan);
    await declare(store, 'fat-loss', T.mar);

    expect(await store.getDietPhaseCovering(LOCAL_USER_ID, T.feb, T.apr)).toBeUndefined();
    expect((await store.getDietPhaseCovering(LOCAL_USER_ID, T.mar, T.apr))?.phase).toBe('fat-loss');
  });

  it('reports no covering phase before the first declaration', async () => {
    const store = open();
    await declare(store, 'gain', T.mar);

    expect(await store.getDietPhaseCovering(LOCAL_USER_ID, T.jan, T.jan)).toBeUndefined();
  });
});

describe('sessions.diet_phase stamp', () => {
  it('stamps a new session from the range covering its start', async () => {
    const store = open();
    await declare(store, 'fat-loss', T.jan);
    await store.putSession({ id: 'sess-1', startedAt: T.feb });

    expect((await store.getSession('sess-1'))?.dietPhase).toBe('fat-loss');
    expect(await store.getSessionDietPhase('sess-1')).toBe('fat-loss');
  });

  it('leaves the stamp absent when no phase covers the session', async () => {
    const store = open();
    await declare(store, 'fat-loss', T.mar);
    await store.putSession({ id: 'sess-1', startedAt: T.jan });

    expect((await store.getSession('sess-1'))?.dietPhase).toBeUndefined();
    expect(await store.getSessionDietPhase('sess-1')).toBeUndefined();
  });

  it('re-stamps on the session.end re-put so a mid-session correction lands', async () => {
    const store = open();
    await store.putSession({ id: 'sess-1', startedAt: T.feb });
    expect((await store.getSession('sess-1'))?.dietPhase).toBeUndefined();

    await declare(store, 'gain', T.jan);
    await store.putSession({ id: 'sess-1', startedAt: T.feb, endedAt: T.mar });

    expect((await store.getSession('sess-1'))?.dietPhase).toBe('gain');
  });

  it('lets the TABLE win over a stale stamp on an older session', async () => {
    const store = open();
    await declare(store, 'gain', T.jan);
    await store.putSession({ id: 'sess-1', startedAt: T.feb });
    expect((await store.getSession('sess-1'))?.dietPhase).toBe('gain');

    // The lifter corrects history: February was actually a cut. The stored row
    // is not rewritten — the DDL comment makes the table the source of truth —
    // so the stamp and the resolved value now disagree, on purpose.
    await declare(store, 'fat-loss', T.feb);

    expect((await store.getSession('sess-1'))?.dietPhase).toBe('gain');
    expect(await store.getSessionDietPhase('sess-1')).toBe('fat-loss');
  });

  it('resolves undefined for a session that does not exist', async () => {
    const store = open();
    expect(await store.getSessionDietPhase('nope')).toBeUndefined();
  });
});

describe('guest lifters (VW-169)', () => {
  it('never stamps or resolves the owner phase onto a guest session', async () => {
    const store = open();
    await declare(store, 'fat-loss', T.jan);
    await store.putSession({ id: 'guest-sess', startedAt: T.feb, lifter: 'Jordan' });
    await store.putSession({ id: 'owner-sess', startedAt: T.feb });

    expect((await store.getSession('guest-sess'))?.dietPhase).toBeUndefined();
    expect(await store.getSessionDietPhase('guest-sess')).toBeUndefined();
    // The owner's own session in the same window still resolves, so the guest
    // result is the lifter check and not an empty table.
    expect(await store.getSessionDietPhase('owner-sess')).toBe('fat-loss');
  });
});

describe('file-backed database', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vmcp-diet-phase-'));
    path = join(dir, 'vmcp.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes into a database created before this change without moving user_version', async () => {
    const seeded = SqliteSessionStore.open(path);
    await seeded.putSession({ id: 'old-sess', startedAt: T.feb });
    seeded.close();
    const before = readUserVersion(path);

    const reopened = SqliteSessionStore.open(path);
    await reopened.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'fat-loss',
      startedAt: T.jan,
      declaredAt: DECLARED_AT,
    });
    // The session predates the declaration, so its stamp is absent while the
    // table answers — the retroactive-correction path against old rows.
    expect((await reopened.getSession('old-sess'))?.dietPhase).toBeUndefined();
    expect(await reopened.getSessionDietPhase('old-sess')).toBe('fat-loss');
    reopened.close();

    const after = readUserVersion(path);
    expect(after).toBe(before);
    expect(after).toBe(17);
  });

  it('falls back to the stamp when no range covers the session any more', async () => {
    const store = SqliteSessionStore.open(path);
    await store.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'gain',
      startedAt: T.jan,
      declaredAt: DECLARED_AT,
    });
    await store.putSession({ id: 'sess-1', startedAt: T.feb });
    store.close();

    // A hand-edited timeline: the covering range is gone but the stamp remains.
    // `declareDietPhase` cannot produce this, which is exactly why the fallback
    // branch needs a test that reaches past it.
    exec(path, `DELETE FROM diet_phases`);

    const reopened = SqliteSessionStore.open(path);
    expect(await reopened.getDietPhaseCovering(LOCAL_USER_ID, T.feb, T.feb)).toBeUndefined();
    expect(await reopened.getSessionDietPhase('sess-1')).toBe('gain');
    reopened.close();
  });

  it('neither reads nor writes training_weeks.phase_type', async () => {
    const seeded = SqliteSessionStore.open(path);
    await seeded.putTrainingProgram({ id: 'prog-1', name: 'Return Block', createdAt: T.jan });
    await seeded.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 1,
      name: 'Block 1',
      weeksCount: 4,
    });
    await seeded.putTrainingWeek({ id: 'week-1', blockId: 'block-1', orderIndex: 1 });
    seeded.close();
    // The PRESCRIBED phase, set outside this feature's surface — the store
    // contract does not expose `phase_type` at all, which is the separation.
    exec(path, `UPDATE training_weeks SET phase_type = 'accumulation' WHERE id = 'week-1'`);

    const store = SqliteSessionStore.open(path);
    await store.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'fat-loss',
      startedAt: T.jan,
      declaredAt: DECLARED_AT,
    });
    await store.putSession({ id: 'sess-1', startedAt: T.feb });
    // The OBSERVED phase resolves, and disagrees with the prescribed one...
    expect(await store.getSessionDietPhase('sess-1')).toBe('fat-loss');
    store.close();

    // ...while the prescribed one is exactly where it was left.
    expect(readPhaseType(path, 'week-1')).toBe('accumulation');
  });
});

/** `user_version` read through a fresh handle. The store must be closed first. */
function readUserVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

function readPhaseType(path: string, weekId: string): unknown {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT phase_type FROM training_weeks WHERE id = ?').get(weekId) as
      | { phase_type: unknown }
      | undefined;
    return row?.phase_type;
  } finally {
    db.close();
  }
}

function exec(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
