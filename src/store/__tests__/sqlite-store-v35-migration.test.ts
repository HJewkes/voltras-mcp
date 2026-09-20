// Tests for the v34 -> v35 migration: `sessions.kind` and `sets.kind` (VW-489), exercised
// against genuinely v34-shaped tables. Additive and back-fills NOTHING — the whole point is
// that history written before the flag existed reads as never reviewed, and is excluded.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTrainingDays } from '../../analytics/training-days.js';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/** `users`, `sessions` and `sets` as they stood at v34, with NO `kind` on either. */
const V34_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT,
    user_id TEXT REFERENCES users(id),
    bilateral_group_id TEXT,
    source TEXT NOT NULL DEFAULT 'local',
    catalog_version TEXT,
    diet_phase TEXT,
    lifter TEXT,
    pre_session_carbs_level TEXT,
    pre_session_carbs_hours_since_meal REAL
  );
  CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    partial INTEGER NOT NULL,
    set_purpose TEXT NOT NULL DEFAULT 'working',
    weight_lbs REAL,
    lifter TEXT,
    source TEXT NOT NULL DEFAULT 'local'
  );
`;

const AT = '2026-09-19T00:00:00.000Z';
const ENDED = '2026-09-19T01:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v35-'));
  path = join(dir, 'store.sqlite');
  const db = new DatabaseSync(path);
  db.exec(V34_SCHEMA_SQL);
  db.exec(`INSERT INTO users (id, created_at, is_default) VALUES ('${LOCAL_USER_ID}', '${AT}', 1)`);
  db.exec(
    `INSERT INTO sessions (id, started_at, ended_at, user_id, exercise_id)
     VALUES ('old', '${AT}', '${ENDED}', '${LOCAL_USER_ID}', 'bench-press')`,
  );
  db.exec(
    `INSERT INTO sets (id, session_id, user_id, started_at, ended_at, partial, weight_lbs)
     VALUES ('old-set', 'old', '${LOCAL_USER_ID}', '${AT}', '${ENDED}', 0, 135)`,
  );
  db.exec('PRAGMA user_version = 34');
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v34 -> v35 migration', () => {
  it('adds kind to both tables and back-fills neither row', async () => {
    const store = SqliteSessionStore.open(path);

    const session = await store.getSession('old');
    const [set] = await store.getSetsForSession('old');

    expect(session?.kind).toBeUndefined();
    expect(set?.kind).toBeUndefined();
    await store.close();
  });

  // The owner's ruling: history from before the flag is left out until he marks it.
  it('leaves the migrated row out of every training-day read until it is marked', async () => {
    const store = SqliteSessionStore.open(path);

    const before = await readTrainingDays(store, '2026-09-20T00:00:00.000Z');
    await store.setSessionKind(['old'], 'training');
    const after = await readTrainingDays(store, '2026-09-20T00:00:00.000Z');

    expect(before).toEqual([]);
    expect(after).toEqual(['2026-09-19']);
    await store.close();
  });

  it('stamps v35 and is idempotent on re-open', async () => {
    const first = SqliteSessionStore.open(path);
    await first.setSessionKind(['old'], 'test');
    await first.close();

    const second = SqliteSessionStore.open(path);
    const reread = await second.getSession('old');
    await second.close();
    const db = new DatabaseSync(path);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();

    expect(reread?.kind).toBe('test');
    // The store stamps the CURRENT schema version, not this migration's target:
    // a v34 file runs every rung above it in one open.
    expect(version.user_version).toBe(38);
  });
});
