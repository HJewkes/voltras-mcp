// Tests for the v23 -> v24 migration: the `rir_velocity_models` table
// (VW-298), exercised against a genuinely v23-shaped database rather than a
// fresh current-shape DB with its `user_version` stamp turned back — VW-288
// found that stamping a current DB backwards proves nothing, because the table
// under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users`, `sessions`, `exercise_setups` and `exercise_baselines` exactly as
 * they stood after v23 — the four `optimal_mvt*` columns VW-299 added are
 * PRESENT, and there is no `rir_velocity_models`. Spelled out literally rather
 * than derived from the current `SCHEMA_SQL` so the fixture cannot drift
 * forward with the code under test.
 */
const V23_SCHEMA_SQL = `
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
    notes TEXT
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
    optimal_mvt REAL,
    optimal_mvt_error_pct REAL,
    optimal_mvt_sample_size INTEGER,
    optimal_mvt_observed_v1rm REAL,
    UNIQUE (user_id, exercise_id, setup_id, side)
  );
`;

let dir: string;
let path: string;

function seedV23Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V23_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.exec(`
    INSERT INTO sessions (id, started_at) VALUES ('sess-old', '2026-09-01T10:00:00.000Z');
  `);
  db.exec('PRAGMA user_version = 23');
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
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v24-'));
  path = join(dir, 'v23.sqlite');
  seedV23Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v23 -> v24 migration', () => {
  it('adds rir_velocity_models on a genuinely v23-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(tables(db).has('rir_velocity_models')).toBe(true);
        expect(columns(db, 'rir_velocity_models')).toEqual(
          new Set([
            'user_id',
            'exercise_id',
            'model_json',
            'fitted_at',
            'sample_size',
            'fit_quality',
          ]),
        );
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the v23 MVT columns alone', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        // This migration adds a table and touches no existing column, so the
        // fit VW-299 landed one version earlier must survive it intact.
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

  it('back-fills no curve: a lifter with no fit reads as having none', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      // Nothing is invented for pre-v24 history. A fit is an optimisation over
      // a selected corpus, so the only honest way to get a row is to run it.
      expect(await store.getRirVelocityModel(LOCAL_USER_ID, 'row')).toBeUndefined();
      expect(await store.getSession('sess-old')).not.toBeUndefined();
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
        expect(version.user_version).toBe(35);
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
