// Tests for the v21 -> v22 migration: `asymmetry_equation` on
// `isometric_measurements` (VW-295), exercised against a genuinely v21-shaped
// database rather than a fresh current-shape DB with its `user_version` stamp
// turned back — VW-288 found that stamping a current DB backwards proves
// nothing, because the column under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * `users` and `isometric_measurements` / `isometric_trials` exactly as they
 * stood after v21 (VW-280 keys present) but before v22 — no
 * `asymmetry_equation`. Spelled out literally rather than derived from the
 * current `SCHEMA_SQL` so the fixture cannot drift forward with the code
 * under test.
 */
const V21_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE isometric_measurements (
    id TEXT PRIMARY KEY,
    measured_at TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    first_side_tested TEXT,
    duration_ms INTEGER NOT NULL,
    trials_requested INTEGER NOT NULL,
    rest_ms INTEGER NOT NULL,
    between_sides_rest_ms INTEGER,
    user_id TEXT,
    exercise_id TEXT,
    session_id TEXT
  );
  CREATE INDEX idx_isometric_measurements_measured_at
    ON isometric_measurements(measured_at);
  CREATE INDEX idx_isometric_measurements_keyed
    ON isometric_measurements(user_id, exercise_id, measured_at);
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

function seedV21Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V21_SCHEMA_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO isometric_measurements
      (id, measured_at, analysis_version, first_side_tested,
       duration_ms, trials_requested, rest_ms, between_sides_rest_ms,
       user_id, exercise_id, session_id)
      VALUES ('meas-old', '2026-09-01T10:00:00.000Z', 1, 'right', 5000, 3, 90000, 120000,
              'local', 'seated-row', 'sess-old');
    INSERT INTO isometric_trials
      (id, measurement_id, device_id, side, slot, trial_index,
       peak_force_lbs, plateau_force_lbs, plateau_start_ms, plateau_end_ms, valid)
      VALUES ('trial-old', 'meas-old', 'AA:BB:CC:01', 'left', 'left', 1, 200, 190, 1200, 1700, 1);
  `);
  db.exec('PRAGMA user_version = 21');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v22-'));
  path = join(dir, 'v21.sqlite');
  seedV21Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v21 -> v22 migration', () => {
  it('adds asymmetry_equation on a genuinely v21-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(columns(db, 'isometric_measurements').has('asymmetry_equation')).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the pre-existing row with no equation rather than inventing one', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const read = await store.getIsometricMeasurement('meas-old');
      expect(read).not.toBeUndefined();
      // Nothing is back-filled: a pre-v22 row never named an equation, and
      // guessing one would misrepresent what was actually computed.
      expect(read).not.toHaveProperty('asymmetryEquation');
      // Its keys and trials survive the migration intact.
      expect(read?.userId).toBe('local');
      expect(read?.sides[0].trials).toHaveLength(1);
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
        expect(version.user_version).toBe(23);
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
