// Tests for the v22 -> v23 migration: the fitted MVT columns on
// `exercise_baselines` (VW-299), exercised against a genuinely v22-shaped
// database rather than a fresh current-shape DB with its `user_version` stamp
// turned back — VW-288 found that stamping a current DB backwards proves
// nothing, because the columns under test are already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineRowId } from '../exercise-baselines.js';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users`, `exercise_setups` and `exercise_baselines` exactly as they stood
 * after v22 but before v23 — no `optimal_mvt` and no audit columns beside it.
 * Spelled out literally rather than derived from the current `SCHEMA_SQL` so
 * the fixture cannot drift forward with the code under test.
 */
const V22_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE exercise_setups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    label TEXT,
    detected_at TEXT NOT NULL,
    confirmed_at TEXT,
    cluster_version TEXT,
    retired_at TEXT,
    setup_anchor TEXT CHECK (setup_anchor IN ('low','mid','chest','high')),
    mount_hole INTEGER,
    cable_length_setting_json TEXT,
    mode TEXT
  );
  CREATE TABLE exercise_baselines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    setup_id TEXT REFERENCES exercise_setups(id) ON DELETE SET NULL,
    side TEXT CHECK (side IN ('left','right')),
    state TEXT NOT NULL
      CHECK (state IN ('COLD','SHAPE_ONLY','PROVISIONAL','CALIBRATED','STALE')),
    confidence REAL,
    observed_sessions INTEGER NOT NULL DEFAULT 0,
    anchor_count INTEGER NOT NULL DEFAULT 0,
    anchor_spread REAL,
    last_anchor_at TEXT,
    first_observed_at TEXT,
    updated_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT,
    algorithm_version TEXT NOT NULL,
    UNIQUE (user_id, exercise_id, setup_id, side)
  );
`;

const OLD_ROW_ID = baselineRowId({ userId: LOCAL_USER_ID, exerciseId: 'seated-row' });

let dir: string;
let path: string;

function seedV22Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V22_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.prepare(
    `INSERT INTO exercise_baselines
       (id, user_id, exercise_id, state, confidence, observed_sessions,
        anchor_count, updated_at, algorithm_version)
     VALUES (?, ?, 'seated-row', 'CALIBRATED', 0.82, 5, 3,
             '2026-09-01T10:00:00.000Z', 'baseline@1.0.0')`,
  ).run(OLD_ROW_ID, LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 22');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v23-'));
  path = join(dir, 'v22.sqlite');
  seedV22Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v22 -> v23 migration', () => {
  it('adds the fitted-MVT columns on a genuinely v22-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const cols = columns(db, 'exercise_baselines');
        expect(cols.has('optimal_mvt')).toBe(true);
        expect(cols.has('optimal_mvt_error_pct')).toBe(true);
        expect(cols.has('optimal_mvt_sample_size')).toBe(true);
        expect(cols.has('optimal_mvt_observed_v1rm')).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the pre-existing row unfitted rather than inventing a threshold', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const read = await store.getBaseline({ userId: LOCAL_USER_ID, exerciseId: 'seated-row' });

      expect(read).not.toBeUndefined();
      // Nothing is back-filled: a pre-v23 row was never fitted, and a threshold
      // guessed here would be read as evidence it is not.
      expect(read).not.toHaveProperty('optimalMvt');
      expect(read).not.toHaveProperty('optimalMvtObservedV1rm');
      // Its state survives the migration intact.
      expect(read?.state).toBe('CALIBRATED');
      expect(read?.anchorCount).toBe(3);
    } finally {
      store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and is a no-op when re-opened', () => {
    SqliteSessionStore.open(path).close();
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(35);
        const row = db.prepare('SELECT COUNT(*) AS n FROM exercise_baselines').get() as {
          n: number;
        };
        expect(row.n).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });
});
