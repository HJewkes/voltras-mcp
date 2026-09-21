// Tests for the v32 -> v33 migration: dated blocks (VW-473). Exercised against a genuinely
// v32-shaped file (VW-288) holding the owner's plan shape: 2 programs, 3 blocks, 4 week rows
// and one goal target, none of them dated. I9: the migration back-fills nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';

/** The plan and goal tables as they stood at v32: no `block_schedules`, no `goal_targets.block_id`. */
const V32_SCHEMA_SQL = `
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
  CREATE TABLE priorities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    block_id TEXT,
    horizon_weeks INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    level TEXT NOT NULL,
    declared_at TEXT NOT NULL,
    retired_at TEXT,
    mesos_held INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE goal_targets (
    id TEXT PRIMARY KEY,
    priority_id TEXT NOT NULL REFERENCES priorities(id) ON DELETE CASCADE,
    metric TEXT NOT NULL,
    exercise_id TEXT,
    anchor_reps INTEGER,
    anchor_load REAL,
    start_value REAL NOT NULL,
    start_measured_at TEXT NOT NULL,
    band_low_pct_per_week REAL NOT NULL,
    band_high_pct_per_week REAL NOT NULL,
    committed_value REAL NOT NULL,
    stretch_value REAL NOT NULL,
    basis TEXT NOT NULL,
    info_level TEXT NOT NULL,
    tier_used TEXT NOT NULL,
    tier_provisional INTEGER NOT NULL DEFAULT 0,
    diet_phase_at_derivation TEXT NOT NULL,
    accepted_by TEXT,
    acknowledged_stretch INTEGER NOT NULL DEFAULT 0,
    derived_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    retired_at TEXT,
    outcome TEXT,
    new_chapter_at TEXT
  );
`;

const AT = '2026-07-19T00:00:00.000Z';

/** The owner's shape, anonymised: two programs, three undated blocks, four week rows. */
const OWNER_SHAPED_ROWS = `
  INSERT INTO users (id, created_at, is_default) VALUES ('local', '${AT}', 1);
  INSERT INTO training_programs (id, name, created_at) VALUES
    ('prog-return', 'Return', '${AT}'), ('prog-test', 'Test', '${AT}');
  INSERT INTO training_blocks (id, program_id, order_index, name, weeks_count) VALUES
    ('blk-1', 'prog-return', 0, 'Block 1', 4),
    ('blk-2', 'prog-return', 1, 'Block 2', 2),
    ('blk-test', 'prog-test', 0, 'Discovery', 1);
  INSERT INTO training_weeks (id, block_id, order_index, name, week_index) VALUES
    ('wk-1', 'blk-1', 0, 'Week 1', 0),
    ('wk-test', 'blk-test', 0, 'Week 1', 0),
    ('wk-2a', 'blk-2', 0, 'Week 1', 0),
    ('wk-2b', 'blk-2', 1, 'Week 2', 1);
  INSERT INTO priorities (id, user_id, block_id, horizon_weeks, kind, ref, level, declared_at)
    VALUES ('pri-1', 'local', 'blk-2', 2, 'muscle', 'chest', 'grow', '${AT}');
  INSERT INTO goal_targets (id, priority_id, metric, start_value, start_measured_at,
    band_low_pct_per_week, band_high_pct_per_week, committed_value, stretch_value, basis,
    info_level, tier_used, diet_phase_at_derivation, derived_at, ends_at)
    VALUES ('tgt-1', 'pri-1', 'bodyweight', 190, '${AT}', 0, 0, 190, 190, 'rp_ramp', 'ramp',
      'intermediate', 'maintenance', '${AT}', '2026-08-02T00:00:00.000Z');
`;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v33-'));
  path = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedV32(): void {
  const db = new DatabaseSync(path);
  db.exec(V32_SCHEMA_SQL);
  db.exec(OWNER_SHAPED_ROWS);
  db.exec('PRAGMA user_version = 32');
  db.close();
}

function inspect<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

interface Shape {
  version: number;
  scheduleRows: number;
  boundTargets: number;
  trigger: boolean;
  blockIdColumn: boolean;
}

function shapeOf(db: DatabaseSync): Shape {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const columns = db.prepare(`PRAGMA table_info(goal_targets)`).all() as { name: string }[];
  return {
    version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    scheduleRows: count('SELECT COUNT(*) AS n FROM block_schedules'),
    boundTargets: count('SELECT COUNT(*) AS n FROM goal_targets WHERE block_id IS NOT NULL'),
    trigger:
      count(
        `SELECT COUNT(*) AS n FROM sqlite_master
           WHERE type = 'trigger' AND name = 'block_schedules_append_only'`,
      ) === 1,
    blockIdColumn: columns.some((column) => column.name === 'block_id'),
  };
}

const MIGRATED: Shape = {
  version: 40,
  scheduleRows: 0,
  boundTargets: 0,
  trigger: true,
  blockIdColumn: true,
};

describe('v32 -> v33 migration (VW-473)', () => {
  it('adds the table, trigger and column to an owner-shaped v32 store and back-fills nothing (I9)', async () => {
    seedV32();

    await SqliteSessionStore.open(path).close();

    expect(inspect(shapeOf)).toEqual(MIGRATED);
    expect(inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM training_blocks').get())).toEqual({
      n: 3,
    });
  });

  it('is idempotent: a second open changes nothing', async () => {
    seedV32();
    await SqliteSessionStore.open(path).close();

    await SqliteSessionStore.open(path).close();

    expect(inspect(shapeOf)).toEqual(MIGRATED);
  });

  it('gives a fresh store the same shape', async () => {
    await SqliteSessionStore.open(path).close();

    expect(inspect(shapeOf)).toEqual(MIGRATED);
  });

  it('leaves every block undated after migrating', async () => {
    seedV32();
    const store = SqliteSessionStore.open(path);

    const live = await store.listLiveBlockSchedules();
    const target = (await store.listGoalTargets({ priorityId: 'pri-1' }))[0];

    expect(live).toEqual([]);
    expect(target?.blockId).toBeUndefined();
    await store.close();
  });
});
