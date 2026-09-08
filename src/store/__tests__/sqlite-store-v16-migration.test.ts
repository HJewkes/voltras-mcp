// Tests for the v15 → v16 migration: `current_baseline` / `effort_tolerance` /
// `target` on `training_profile` (VMCP-06.04).
//
// The fixture is a real v15 database opened from disk, not a fresh one stamped
// with an old `user_version` — the point is that the ALTER runs against a file
// that genuinely lacks the columns, and that a profile already in it survives
// with its `goal` untouched rather than being split across the new fields.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * `users` and `training_profile` exactly as v15 shipped them. Spelled out
 * literally rather than derived from the current SCHEMA_SQL so the fixture
 * cannot drift forward with the code under test.
 */
const V15_PROFILE_SQL = `
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
    provenance_json TEXT,
    updated_at TEXT NOT NULL
  );
`;

let dir: string;
let path: string;

function seedV15Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V15_PROFILE_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO training_profile
      (user_id, declared_tier, goal, days_reliable, updated_at)
      VALUES ('local', 'intermediate', 'get back to a 225 bench', 3,
              '2026-09-01T00:00:00.000Z');
  `);
  db.exec('PRAGMA user_version = 15');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v16-'));
  path = join(dir, 'v15.sqlite');
  seedV15Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v15 -> v16 migration', () => {
  it('adds the three intake columns and stamps the current user_version', () => {
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      const cols = columns(db, 'training_profile');
      expect(cols.has('current_baseline')).toBe(true);
      expect(cols.has('effort_tolerance')).toBe(true);
      expect(cols.has('target')).toBe(true);
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(16);
    } finally {
      db.close();
      store.close();
    }
  });

  it('leaves the existing profile intact with the three fields absent', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const profile = await store.getTrainingProfile('local');

      // `goal` is NOT split across the new fields: an existing free-text goal
      // may be any of the three, and guessing which manufactures a self-report.
      expect(profile?.goal).toBe('get back to a 225 bench');
      expect(profile?.declaredTier).toBe('intermediate');
      expect(profile?.currentBaseline).toBeUndefined();
      expect(profile?.effortTolerance).toBeUndefined();
      expect(profile?.target).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('round-trips the three new fields once written', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const existing = await store.getTrainingProfile('local');
      await store.putTrainingProfile({
        ...existing,
        userId: 'local',
        currentBaseline: 'benching 185 for 5',
        effortTolerance: 'moderate',
        target: '225 for 3 by spring',
        updatedAt: '2026-09-08T00:00:00.000Z',
      });

      const reread = await store.getTrainingProfile('local');

      expect(reread).toMatchObject({
        currentBaseline: 'benching 185 for 5',
        effortTolerance: 'moderate',
        target: '225 for 3 by spring',
        goal: 'get back to a 225 bench',
      });
    } finally {
      store.close();
    }
  });

  it('reads an out-of-enum effort tolerance back as absent', async () => {
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`UPDATE training_profile SET effort_tolerance = 'ferocious' WHERE user_id = 'local'`);

      const profile = await store.getTrainingProfile('local');

      expect(profile?.effortTolerance).toBeUndefined();
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
