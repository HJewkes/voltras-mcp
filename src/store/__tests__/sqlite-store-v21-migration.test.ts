// Tests for the v20 -> v21 migration: the lifter / exercise / session keys on
// `isometric_measurements` (VW-280), exercised against a genuinely v20-shaped
// database rather than a fresh current-shape DB with its `user_version` stamp
// turned back — VW-288 found that stamping a current DB backwards proves
// nothing, because the columns under test are already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * `users`, `accountability_state` (the table v20 added), and
 * `isometric_measurements` / `isometric_trials` exactly as they stood before
 * v21 — no `user_id`, `exercise_id` or `session_id`. Spelled out literally
 * rather than derived from the current `SCHEMA_SQL` so the fixture cannot
 * drift forward with the code under test.
 */
const V20_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE accountability_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    entered_at TEXT NOT NULL,
    consecutive_misses INTEGER NOT NULL DEFAULT 0,
    ghost_sends_json TEXT,
    last_inbound_at TEXT,
    last_proactive_sends_json TEXT,
    holding_until TEXT
  );
  CREATE TABLE isometric_measurements (
    id TEXT PRIMARY KEY,
    measured_at TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    first_side_tested TEXT,
    duration_ms INTEGER NOT NULL,
    trials_requested INTEGER NOT NULL,
    rest_ms INTEGER NOT NULL,
    between_sides_rest_ms INTEGER
  );
  CREATE INDEX idx_isometric_measurements_measured_at
    ON isometric_measurements(measured_at);
  CREATE TABLE isometric_trials (
    id TEXT PRIMARY KEY,
    measurement_id TEXT NOT NULL
      REFERENCES isometric_measurements(id) ON DELETE CASCADE,
    device_id TEXT,
    side TEXT,
    slot TEXT,
    trial_index INTEGER NOT NULL,
    peak_force_lbs REAL NOT NULL,
    plateau_force_lbs REAL NOT NULL,
    plateau_start_ms INTEGER NOT NULL,
    plateau_end_ms INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    invalid_reason TEXT
  );
`;

let dir: string;
let path: string;

function seedV20Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V20_SCHEMA_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO isometric_measurements
      (id, measured_at, analysis_version, first_side_tested,
       duration_ms, trials_requested, rest_ms, between_sides_rest_ms)
      VALUES ('meas-old', '2026-09-01T10:00:00.000Z', 1, 'right', 5000, 3, 90000, 120000);
    INSERT INTO isometric_trials
      (id, measurement_id, device_id, side, slot, trial_index,
       peak_force_lbs, plateau_force_lbs, plateau_start_ms, plateau_end_ms, valid)
      VALUES ('trial-old', 'meas-old', 'AA:BB:CC:01', 'left', 'left', 1, 200, 190, 1200, 1700, 1);
  `);
  db.exec('PRAGMA user_version = 20');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function indexNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v21-'));
  path = join(dir, 'v20.sqlite');
  seedV20Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v20 -> v21 migration', () => {
  it('adds the three keys and their index on a genuinely v20-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const present = columns(db, 'isometric_measurements');
        expect(present.has('user_id')).toBe(true);
        expect(present.has('exercise_id')).toBe(true);
        expect(present.has('session_id')).toBe(true);
        // The index names columns a v20 table does not have, so it cannot live
        // in SCHEMA_SQL — that runs before the migration adds them.
        expect(indexNames(db, 'isometric_measurements')).toContain(
          'idx_isometric_measurements_keyed',
        );
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the pre-existing row unkeyed rather than attributing it to the owner', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const read = await store.getIsometricMeasurement('meas-old');
      expect(read).not.toBeUndefined();
      // Nothing is back-filled: the row records a test whose lifter and joint
      // were never written down, and a guessed owner would invent them.
      expect(read).not.toHaveProperty('userId');
      expect(read).not.toHaveProperty('exerciseId');
      expect(read).not.toHaveProperty('sessionId');
      // Its trials survive the migration intact.
      expect(read?.sides[0].trials).toHaveLength(1);

      // …and it can never join a keyed series, only be counted outside one.
      const history = await store.listRecentIsometricMeasurements({
        filter: { userId: 'local', exerciseId: 'seated-row' },
      });
      expect(history.measurements).toEqual([]);
      expect(history.legacyUnkeyed).toBe(1);
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
        expect(version.user_version).toBe(32);
        const row = db.prepare('SELECT COUNT(*) AS n FROM isometric_measurements').get() as {
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
