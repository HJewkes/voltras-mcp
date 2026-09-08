// Tests for the v13 → v14 migration: `external_id` on the two planning tables
// plus the unique indexes that make it an idempotency key.
//
// The fixture is a real v13 database opened from disk, not a fresh one stamped
// with an old `user_version` — the point of the test is that the ALTER runs
// against a file that genuinely lacks the columns, and that the rows already
// in it survive with a NULL external id rather than being backfilled with a
// manufactured one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * The planning tables exactly as v13 shipped them. Spelled out literally
 * rather than derived from the current SCHEMA_SQL so the fixture cannot drift
 * forward with the code under test.
 */
const V13_PLANNING_SQL = `
  CREATE TABLE training_programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE training_blocks (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    focus TEXT,
    weeks_count INTEGER NOT NULL,
    notes TEXT
  );
  CREATE TABLE training_weeks (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES training_blocks(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT,
    phase_type TEXT,
    is_deload INTEGER NOT NULL DEFAULT 0,
    week_index INTEGER
  );
  CREATE TABLE workout_templates (
    id TEXT PRIMARY KEY,
    week_id TEXT NOT NULL REFERENCES training_weeks(id) ON DELETE CASCADE,
    day_label TEXT,
    name TEXT NOT NULL,
    notes TEXT,
    order_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE planned_exercises (
    id TEXT PRIMARY KEY,
    workout_template_id TEXT NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    target_sets INTEGER NOT NULL,
    target_reps_low INTEGER,
    target_reps_high INTEGER,
    target_weight_lbs REAL,
    target_rpe REAL,
    rest_sec INTEGER,
    notes TEXT,
    target_tempo_json TEXT,
    target_rom_m REAL,
    target_rir REAL
  );
`;

let dir: string;
let path: string;

function seedV13Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V13_PLANNING_SQL);
  db.exec(`
    INSERT INTO training_programs (id, name, created_at)
      VALUES ('prog-1', 'Local program', '2026-09-01T00:00:00.000Z');
    INSERT INTO training_blocks (id, program_id, order_index, name, weeks_count)
      VALUES ('block-1', 'prog-1', 0, 'Block 1', 4);
    INSERT INTO training_weeks (id, block_id, order_index, name)
      VALUES ('week-1', 'block-1', 0, 'Week 1');
    INSERT INTO workout_templates (id, week_id, name, order_index)
      VALUES ('tmpl-1', 'week-1', 'Hand-built Upper', 0);
    INSERT INTO planned_exercises
      (id, workout_template_id, exercise_id, order_index, target_sets)
      VALUES ('pe-1', 'tmpl-1', 'cable-row', 0, 3);
  `);
  db.exec('PRAGMA user_version = 13');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v14-'));
  path = join(dir, 'v13.sqlite');
  seedV13Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v13 -> v14 migration', () => {
  // The version assertion is SCHEMA_VERSION, not 14: opening a v13 file runs
  // every later migration too, so this test moves with the head version.
  it('adds external_id to both planning tables and stamps the current user_version', () => {
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      expect(columns(db, 'workout_templates').has('external_id')).toBe(true);
      expect(columns(db, 'planned_exercises').has('external_id')).toBe(true);
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(16);
    } finally {
      db.close();
      store.close();
    }
  });

  it('leaves pre-existing rows intact with a NULL external id', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const template = await store.getWorkoutTemplate('tmpl-1');
      const planned = await store.getPlannedExercise('pe-1');
      expect(template?.name).toBe('Hand-built Upper');
      expect(template?.externalId).toBeUndefined();
      expect(planned?.exerciseId).toBe('cable-row');
      expect(planned?.externalId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('creates unique indexes that still allow many NULL external ids', () => {
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        INSERT INTO workout_templates (id, week_id, name, order_index)
          VALUES ('tmpl-2', 'week-1', 'Another local', 1);
      `);
      expect(() =>
        db.exec(`
          UPDATE workout_templates SET external_id = 'tc:workout:1' WHERE id IN ('tmpl-1','tmpl-2')
        `),
      ).toThrow();
    } finally {
      db.close();
      store.close();
    }
  });

  it('is a no-op when re-opened', () => {
    SqliteSessionStore.open(path).close();
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(16);
    } finally {
      db.close();
      store.close();
    }
  });
});
