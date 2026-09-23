// The one prescription migration (VW-517): `planned_exercises.goal_kind`,
// `.target_velocity_loss_pct` and `.rest_learning`, plus the empty `learned_rest` table.
//
// Named for what it migrates rather than for a version number, so a re-number is
// `CURRENT_VERSION` and `PRIOR_VERSION` alone. They move independently: `CURRENT_VERSION`
// is whatever the store now stamps, `PRIOR_VERSION` is what this step starts from.
//
// Three fixtures, because a migration that only ever runs on a fresh store proves nothing:
// a genuinely v34-shaped planning tree holding the owner's row shapes (VW-288), the chain
// from v37 with the three columns genuinely absent, and a fresh store.
//
// The two rulings under test: a written rest keeps behaving as it does today
// (`rest_learning = 0`), and `goal_kind` comes from `defaultGoalKind`, so a row with a rep
// range AND an RPE is a `rep_range` row whose RPE is its cap.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLearnedRestContext } from '../learned-rest-context.js';
import { SqliteSessionStore } from '../sqlite-store.js';

const CURRENT_VERSION = 41;
/** The version THIS step starts from, not whatever precedes the newest one: it was
 *  `CURRENT_VERSION - 1` while this was the newest step, and VW-521 landed above it. */
const PRIOR_VERSION = 37;

/** The planning tree as it stood at v34: `planned_exercises` with none of the three. */
const V34_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
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
    training_intent TEXT,
    external_id TEXT
  );
`;

const AT = '2026-09-20T00:00:00.000Z';

/**
 * One row per case the two backfills have to separate. Five lifts in one workout, which is
 * the owner's shape: rep ranges everywhere, a rest on some of them, an RPE on one.
 */
const OWNER_SHAPED_ROWS = `
  INSERT INTO users (id, created_at, is_default) VALUES ('local', '${AT}', 1);
  INSERT INTO training_programs (id, name, created_at) VALUES ('prog', 'Return', '${AT}');
  INSERT INTO training_blocks (id, program_id, order_index, name, weeks_count)
    VALUES ('blk', 'prog', 0, 'Block 1', 4);
  INSERT INTO training_weeks (id, block_id, order_index, name, week_index)
    VALUES ('wk', 'blk', 0, 'Week 1', 0);
  INSERT INTO workout_templates (id, week_id, name, order_index)
    VALUES ('tpl', 'wk', 'Upper', 0);
  INSERT INTO planned_exercises
    (id, workout_template_id, exercise_id, order_index, target_sets,
     target_reps_low, target_reps_high, target_rpe, rest_sec)
  VALUES
    ('pe-range-rest',  'tpl', 'bench-press', 0, 3, 8, 10, NULL, 150),
    ('pe-range-rpe',   'tpl', 'row',         1, 3, 8, 10, 9,    NULL),
    ('pe-rpe-only',    'tpl', 'curl',        2, 3, NULL, NULL, 8, NULL),
    ('pe-rest-only',   'tpl', 'press',       3, 3, NULL, NULL, NULL, 90),
    ('pe-bare',        'tpl', 'fly',         4, 3, NULL, NULL, NULL, NULL);
`;

/** What the two backfills must produce, per row. */
const EXPECTED = [
  { id: 'pe-bare', goal_kind: null, rest_learning: 1 },
  { id: 'pe-range-rest', goal_kind: 'rep_range', rest_learning: 0 },
  { id: 'pe-range-rpe', goal_kind: 'rep_range', rest_learning: 1 },
  { id: 'pe-rest-only', goal_kind: null, rest_learning: 0 },
  { id: 'pe-rpe-only', goal_kind: 'target_rpe', rest_learning: 1 },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-prescription-'));
  path = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedV34(): void {
  const db = new DatabaseSync(path);
  db.exec(V34_SCHEMA_SQL);
  db.exec(OWNER_SHAPED_ROWS);
  db.exec(`PRAGMA user_version = 34`);
  db.close();
}

/**
 * A genuine pre-migration v37 file: a fully-shaped store with the three columns and the
 * table taken back off it. Dropping is how the shape is reached, never how it is tested.
 */
function seedPriorVersion(): void {
  SqliteSessionStore.open(path).close();
  const db = new DatabaseSync(path);
  db.exec(`
    ALTER TABLE planned_exercises DROP COLUMN goal_kind;
    ALTER TABLE planned_exercises DROP COLUMN target_velocity_loss_pct;
    ALTER TABLE planned_exercises DROP COLUMN rest_learning;
    DROP TABLE learned_rest;
  `);
  db.exec(OWNER_SHAPED_ROWS.replace(/INSERT INTO users[^;]+;/, ''));
  db.exec(`PRAGMA user_version = ${PRIOR_VERSION}`);
  db.close();
}

function read<T>(sql: string): T[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).all() as unknown as T[];
  } finally {
    db.close();
  }
}

function backfilled(): unknown[] {
  return read(`SELECT id, goal_kind, rest_learning FROM planned_exercises ORDER BY id`);
}

function userVersion(): number {
  return read<{ user_version: number }>('PRAGMA user_version')[0]!.user_version;
}

describe('the prescription migration', () => {
  it('back-fills an owner-shaped v34 store by the two rulings', async () => {
    seedV34();

    await SqliteSessionStore.open(path).close();

    expect(backfilled()).toEqual(EXPECTED);
    expect(userVersion()).toBe(CURRENT_VERSION);
  });

  it('back-fills the same way on the chain from the version before it', async () => {
    seedPriorVersion();

    await SqliteSessionStore.open(path).close();

    expect(backfilled()).toEqual(EXPECTED);
    expect(userVersion()).toBe(CURRENT_VERSION);
  });

  it('leaves every loss target unstated, because no earlier row could carry one', async () => {
    seedV34();

    await SqliteSessionStore.open(path).close();

    expect(
      read(`SELECT COUNT(*) AS n FROM planned_exercises
                   WHERE target_velocity_loss_pct IS NOT NULL`),
    ).toEqual([{ n: 0 }]);
  });

  // The backfill is guarded by the version stamp, not by its own WHERE clause: a planner
  // who turns learning ON for a row that has a rest must not be reset by the next open.
  it('is a no-op on a second open, including for a row edited in between', async () => {
    seedV34();
    await SqliteSessionStore.open(path).close();

    const edit = new DatabaseSync(path);
    edit.exec(`UPDATE planned_exercises SET rest_learning = 1 WHERE id = 'pe-range-rest'`);
    edit.close();
    await SqliteSessionStore.open(path).close();

    expect(backfilled()).toEqual(
      EXPECTED.map((row) => (row.id === 'pe-range-rest' ? { ...row, rest_learning: 1 } : row)),
    );
    expect(userVersion()).toBe(CURRENT_VERSION);
  });

  it('creates learned_rest empty and keyed on the four parts', async () => {
    seedV34();

    await SqliteSessionStore.open(path).close();

    expect(read('SELECT COUNT(*) AS n FROM learned_rest')).toEqual([{ n: 0 }]);
    expect(
      read<{ name: string }>(
        `SELECT name FROM pragma_table_info('learned_rest') WHERE pk > 0 ORDER BY pk`,
      ).map((column) => column.name),
    ).toEqual(['user_id', 'exercise_id', 'intent', 'context']);
  });

  // The owner's ruling (VW-525): `context` is free text validated in code, because each
  // resistance family will later learn its own rest and the family goes in that column.
  // The three columns whose vocabulary is closed keep their CHECKs; this one has none, so
  // `isLearnedRestContext` is the ONLY thing standing between a typo and a stored row.
  it('leaves context unenumerated while the closed columns keep their CHECKs', async () => {
    seedV34();

    await SqliteSessionStore.open(path).close();

    const ddl = read<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learned_rest'`,
    )[0]!.sql;
    expect(ddl).toMatch(/context TEXT NOT NULL DEFAULT 'straight',/);
    expect(ddl).not.toMatch(/CHECK \(context/);
    for (const column of ['intent', 'state', 'base_source']) {
      expect(ddl).toMatch(new RegExp(`CHECK \\(${column} IN`));
    }
  });

  // And the schema really does accept a word this build does not know, which is the whole
  // reason the predicate has to be asked rather than assumed.
  it('accepts an unknown context at the schema level, so only code can refuse one', async () => {
    seedV34();
    await SqliteSessionStore.open(path).close();

    const db = new DatabaseSync(path);
    try {
      expect(isLearnedRestContext('banded')).toBe(false);
      expect(() =>
        db.exec(
          `INSERT INTO learned_rest (user_id, exercise_id, intent, context, value_sec, state,
             base_sec, base_source, run_started_on, history_json, policy_version, updated_at)
           VALUES ('local', 'bench-press', 'strength', 'banded', 120, 'calibrating', 120,
             'plan', '2026-09-20', '[]', 'adaptive-rest@1.0.0', '${AT}')`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('gives a fresh store the same shape as a migrated one', async () => {
    seedV34();
    await SqliteSessionStore.open(path).close();
    const freshPath = join(dir, 'fresh.sqlite');
    SqliteSessionStore.open(freshPath).close();

    expect(shapeOf(freshPath)).toEqual(shapeOf(path));
  });

  it('round-trips the three new fields through the store', async () => {
    const store = SqliteSessionStore.open(path);
    await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
    await store.putTrainingBlock({
      id: 'blk',
      programId: 'prog',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 4,
    });
    await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0 });
    await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Upper', orderIndex: 0 });
    const base = { workoutTemplateId: 'tpl', exerciseId: 'bench-press', targetSets: 3 };

    await store.putPlannedExercise({
      ...base,
      id: 'loss',
      orderIndex: 0,
      goalKind: 'velocity_loss',
      targetVelocityLossPct: 20,
      restLearning: false,
      restSec: 180,
    });
    await store.putPlannedExercise({ ...base, id: 'default', orderIndex: 1 });
    const loss = await store.getPlannedExercise('loss');
    const byDefault = await store.getPlannedExercise('default');
    await store.close();

    expect(loss).toMatchObject({
      goalKind: 'velocity_loss',
      targetVelocityLossPct: 20,
      restLearning: false,
    });
    // Absent on a write means the default, on; and a read always states it.
    expect(byDefault?.goalKind).toBeUndefined();
    expect(byDefault?.restLearning).toBe(true);
  });
});

/** The columns a reader depends on, in a form two files can be compared by. */
function shapeOf(file: string): { planned: string[]; learnedRest: string[] } {
  const db = new DatabaseSync(file);
  try {
    const names = (table: string): string[] =>
      (
        db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY name`).all(table) as unknown as {
          name: string;
        }[]
      ).map((column) => column.name);
    return { planned: names('planned_exercises'), learnedRest: names('learned_rest') };
  } finally {
    db.close();
  }
}
