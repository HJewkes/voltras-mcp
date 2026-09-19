// Tests for the v30 -> v31 migration: `goal_targets.anchor_load` (VW-399),
// exercised against a genuinely v30-shaped `goal_targets` table rather than a
// current DB with its `user_version` stamped back (VW-288).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/** `users`, `priorities` and `goal_targets` as they stood at v30, with NO `anchor_load`. */
const V30_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
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

const AT = '2026-09-01T00:00:00.000Z';

let dir: string;
let path: string;

function seedV30Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V30_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at, is_default) VALUES (?, ?, 1)`).run(
    LOCAL_USER_ID,
    AT,
  );
  db.prepare(
    `INSERT INTO priorities (id, user_id, horizon_weeks, kind, ref, level, declared_at)
     VALUES ('pri-1', ?, 6, 'lift', 'bench-press', 'specialize', ?)`,
  ).run(LOCAL_USER_ID, AT);
  db.prepare(
    `INSERT INTO goal_targets (id, priority_id, metric, start_value, start_measured_at,
       band_low_pct_per_week, band_high_pct_per_week, committed_value, stretch_value, basis,
       info_level, tier_used, diet_phase_at_derivation, derived_at, ends_at)
     VALUES ('tgt-old', 'pri-1', 'reps_at_load', 8, ?, 5, 8, 12, 14, 'rp_ramp', 'ramp',
       'beginner', 'maintenance', ?, ?)`,
  ).run(AT, AT, AT);
  db.exec('PRAGMA user_version = 30');
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v31-'));
  path = join(dir, 'v30.sqlite');
  seedV30Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v30 -> v31 migration', () => {
  it('back-fills nothing: a pre-v31 reps_at_load target recorded no anchor load', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const [target] = await store.listGoalTargets({ userId: LOCAL_USER_ID });
      expect(target.id).toBe('tgt-old');
      expect(target).not.toHaveProperty('anchorLoad');
    } finally {
      await store.close();
    }
  });

  it('round-trips an anchor load and stamps user_version at 31', async () => {
    const first = SqliteSessionStore.open(path);
    const [target] = await first.listGoalTargets({ userId: LOCAL_USER_ID });
    await first.putGoalTarget({ ...target, anchorLoad: 185 });
    await first.close();

    const store = SqliteSessionStore.open(path);
    try {
      const [reread] = await store.listGoalTargets({ userId: LOCAL_USER_ID });
      expect(reread.anchorLoad).toBe(185);
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as unknown as {
          user_version: number;
        };
        expect(version.user_version).toBe(35);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});
