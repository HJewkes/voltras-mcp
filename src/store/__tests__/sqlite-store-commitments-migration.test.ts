// The commitments migration (VW-505): the lifter's two text columns, `revision`, the
// per-revision unique index and the append-only trigger, exercised against a genuinely
// pre-migration `commitments` table holding a row (VW-288). Additive and back-fills nothing.
//
// Named for what it migrates rather than for a version number, so a re-number is `TO_VERSION`
// alone: this took v35 against main, then v37 once VW-489 and VW-502 landed ahead of it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

const TO_VERSION = 37;
const FROM_VERSION = TO_VERSION - 1;

/** `users` and `commitments` as they stood before the change: no words, no revision. */
const PRIOR_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE commitments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    sessions_per_week INTEGER NOT NULL,
    days_json TEXT,
    declared_at TEXT NOT NULL
  );
`;

const AT = '2026-09-20T18:00:00.000Z';
const WEEK = '2026-09-21';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-commitments-'));
  path = join(dir, 'store.sqlite');
  const db = new DatabaseSync(path);
  db.exec(PRIOR_SCHEMA_SQL);
  db.exec(`INSERT INTO users (id, created_at, is_default) VALUES ('${LOCAL_USER_ID}', '${AT}', 1)`);
  db.exec(
    `INSERT INTO commitments (id, user_id, effective_from, sessions_per_week, days_json, declared_at)
     VALUES ('old', '${LOCAL_USER_ID}', '${WEEK}', 3, '[]', '${AT}')`,
  );
  db.exec(`PRAGMA user_version = ${FROM_VERSION}`);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the commitments migration', () => {
  it('keeps the existing row, leaves its words unanswered and reads it as revision 1', async () => {
    const store = SqliteSessionStore.open(path);

    const read = await store.getCommitmentForWeek(LOCAL_USER_ID, WEEK);
    await store.close();

    expect(read).toMatchObject({ id: 'old', revision: 1, ifThen: '', wording: '' });
  });

  it('files a correction for the pre-existing week as the next revision', async () => {
    const store = SqliteSessionStore.open(path);

    const declared = await store.declareCommitment({
      userId: LOCAL_USER_ID,
      effectiveFrom: WEEK,
      days: [{ day: 'Monday', fallbackDay: 'Tuesday' }],
      ifThen: 'If Monday goes, then Tuesday takes it.',
      wording: 'One lift a week to start.',
      declaredAt: AT,
    });
    await store.close();

    expect(declared.commitment.revision).toBe(2);
    expect(declared.unchanged).toBe(false);
  });

  it('stamps the version, is idempotent on re-open and installs both guards', async () => {
    await SqliteSessionStore.open(path).close();
    await SqliteSessionStore.open(path).close();

    const db = new DatabaseSync(path);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'commitments'
           ORDER BY name`,
      )
      .all() as unknown as { name: string }[];
    const rows = db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number };
    db.close();

    expect(version.user_version).toBe(TO_VERSION);
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      'commitments_append_only',
      'commitments_no_delete',
    ]);
    expect(rows.n).toBe(1);
  });

  it('guards the pre-existing row against a DELETE once migrated', async () => {
    await SqliteSessionStore.open(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(() => db.exec('DELETE FROM commitments')).toThrow(/never deleted/);
      expect((db.prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n).toBe(
        1,
      );
    } finally {
      db.close();
    }
  });

  it('gives a fresh store the same shape as the migrated one', async () => {
    await SqliteSessionStore.open(path).close();
    const freshPath = join(dir, 'fresh.sqlite');
    await SqliteSessionStore.open(freshPath).close();

    expect(shapeOf(freshPath)).toEqual(shapeOf(path));
  });
});

/** The columns, index and trigger a reader depends on, in a form two files can be compared by. */
function shapeOf(file: string): { columns: string[]; indexes: string[]; triggers: string[] } {
  const db = new DatabaseSync(file);
  const columns = (
    db.prepare(`SELECT name FROM pragma_table_info('commitments')`).all() as unknown as {
      name: string;
    }[]
  ).map((row) => row.name);
  const objects = db
    .prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'commitments'`)
    .all() as unknown as { type: string; name: string }[];
  db.close();
  return {
    columns: columns.sort(),
    indexes: objects
      .filter((row) => row.type === 'index')
      .map((row) => row.name)
      .sort(),
    triggers: objects
      .filter((row) => row.type === 'trigger')
      .map((row) => row.name)
      .sort(),
  };
}
