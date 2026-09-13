// Tests for the v17 → v18 migration: `planned_exercises.training_intent`
// (VW-266), exercised against a genuinely v17-shaped database rather than a
// fresh current-shape DB with its `user_version` stamp turned back — see
// VW-288, which found that `checkSchemaVersion` refused a real v17 database
// outright and needed a fixture that proves `migrateV17ToV18`'s ALTER runs
// against a table that actually lacks the column.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * The planning tree plus `training_profile`, exactly as v17 shipped them:
 * the v16 fixture's `training_profile` with the two columns
 * `migrateV16ToV17` adds, and `planned_exercises` with no `training_intent`
 * column. Spelled out literally rather than derived from the current
 * `SCHEMA_SQL` so the fixture cannot drift forward with the code under test.
 */
const V17_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE training_profile (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    declared_tier TEXT,
    declared_at TEXT,
    years_training REAL,
    history_consistent INTEGER,
    ever_plateaued INTEGER,
    reported_sets_per_muscle REAL,
    goal TEXT,
    goal_set_at TEXT,
    days_available INTEGER,
    days_reliable INTEGER,
    onboarded_at TEXT,
    current_baseline TEXT,
    effort_tolerance TEXT,
    target TEXT,
    provenance_json TEXT,
    updated_at TEXT NOT NULL,
    injuries_json TEXT,
    named_program_history TEXT
  );
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
    order_index INTEGER NOT NULL DEFAULT 0,
    external_id TEXT
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
    target_rir REAL,
    external_id TEXT
  );
`;

let dir: string;
let path: string;

function seedV17Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V17_SCHEMA_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO training_programs (id, name, created_at)
      VALUES ('prog-1', 'Base Strength', '2026-09-01T00:00:00.000Z');
    INSERT INTO training_blocks (id, program_id, order_index, name, weeks_count)
      VALUES ('block-1', 'prog-1', 0, 'Block 1', 4);
    INSERT INTO training_weeks (id, block_id, order_index)
      VALUES ('week-1', 'block-1', 0);
    INSERT INTO workout_templates (id, week_id, name)
      VALUES ('template-1', 'week-1', 'Day 1');
    INSERT INTO planned_exercises (id, workout_template_id, exercise_id, order_index, target_sets)
      VALUES ('plan-ex-1', 'template-1', 'bench-press', 0, 3);
  `);
  db.exec('PRAGMA user_version = 17');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v18-'));
  path = join(dir, 'v17.sqlite');
  seedV17Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v17 -> v18 migration', () => {
  it('adds training_intent to a genuinely v17-shaped planned_exercises table', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(columns(db, 'planned_exercises').has('training_intent')).toBe(true);
      } finally {
        db.close();
      }

      const plannedExercise = await store.getPlannedExercise('plan-ex-1');
      expect(plannedExercise?.exerciseId).toBe('bench-press');
      expect(plannedExercise?.targetSets).toBe(3);
      expect(plannedExercise?.trainingIntent).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION after migrating', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(23);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });
});
