// Tests for the v24 -> v25 migration: optional self-reported pre-session
// carb context on `sessions` (VW-307), exercised against a genuinely
// v24-shaped database rather than a fresh current-shape DB with its
// `user_version` stamp turned back — VW-288 found that stamping a current DB
// backwards proves nothing, because the table under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users`, `sessions`, `exercise_baselines` and `rir_velocity_models` exactly
 * as they stood after v24 — the `rir_velocity_models` table VW-298 added and
 * the four `optimal_mvt*` columns VW-299 added are PRESENT, and `sessions`
 * has no `pre_session_carbs_*` columns. Spelled out literally rather than
 * derived from the current `SCHEMA_SQL` so the fixture cannot drift forward
 * with the code under test.
 */
const V24_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT,
    lifter TEXT,
    diet_phase TEXT
  );
  CREATE TABLE exercise_baselines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
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
    optimal_mvt REAL,
    optimal_mvt_error_pct REAL,
    optimal_mvt_sample_size INTEGER,
    optimal_mvt_observed_v1rm REAL,
    UNIQUE (user_id, exercise_id)
  );
  CREATE TABLE rir_velocity_models (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    model_json TEXT NOT NULL,
    fitted_at TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    fit_quality REAL,
    PRIMARY KEY (user_id, exercise_id)
  );
`;

let dir: string;
let path: string;

function seedV24Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V24_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.exec(`
    INSERT INTO sessions (id, started_at) VALUES ('sess-old', '2026-09-01T10:00:00.000Z');
  `);
  db.exec('PRAGMA user_version = 24');
  db.close();
}

function tables(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v25-'));
  path = join(dir, 'v24.sqlite');
  seedV24Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v24 -> v25 migration', () => {
  it('adds the pre_session_carbs columns on a genuinely v24-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const sessionColumns = columns(db, 'sessions');
        expect(sessionColumns.has('pre_session_carbs_level')).toBe(true);
        expect(sessionColumns.has('pre_session_carbs_hours_since_meal')).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves rir_velocity_models and the v23 MVT columns alone', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(tables(db).has('rir_velocity_models')).toBe(true);
        const baselineColumns = columns(db, 'exercise_baselines');
        for (const column of [
          'optimal_mvt',
          'optimal_mvt_error_pct',
          'optimal_mvt_sample_size',
          'optimal_mvt_observed_v1rm',
        ]) {
          expect(baselineColumns.has(column)).toBe(true);
        }
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('back-fills nothing: a pre-existing row reads back with the field ABSENT, never defaulted', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const session = await store.getSession('sess-old');
      expect(session).not.toBeUndefined();
      expect(session?.preSessionCarbs).toBeUndefined();
      expect('preSessionCarbs' in (session ?? {})).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and is a no-op when re-opened', () => {
    SqliteSessionStore.open(path).close();
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(38);
        const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
        expect(row.n).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });
});
