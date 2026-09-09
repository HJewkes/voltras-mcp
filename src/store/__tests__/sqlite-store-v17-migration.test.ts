// Tests for the v16 → v17 migration: `injuries_json` /
// `named_program_history` on `training_profile` (VW-148).
//
// The fixture is a real v16 database opened from disk, not a fresh one stamped
// with an old `user_version` — the point is that the ALTER runs against a file
// that genuinely lacks the columns, and that a profile already in it comes
// back with `injuries` ABSENT rather than as an empty list. Those are two
// different answers: absent means nobody ever asked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * `users` and `training_profile` exactly as v16 shipped them. Spelled out
 * literally rather than derived from the current SCHEMA_SQL so the fixture
 * cannot drift forward with the code under test.
 */
const V16_PROFILE_SQL = `
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
    updated_at TEXT NOT NULL
  );
`;

let dir: string;
let path: string;

function seedV16Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V16_PROFILE_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO training_profile
      (user_id, declared_tier, goal, reported_sets_per_muscle, updated_at)
      VALUES ('local', 'intermediate', 'get back to a 225 bench', 10,
              '2026-09-01T00:00:00.000Z');
  `);
  db.exec('PRAGMA user_version = 16');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v17-'));
  path = join(dir, 'v16.sqlite');
  seedV16Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v16 -> v17 migration', () => {
  it('adds both intake columns and stamps the current user_version', () => {
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      const cols = columns(db, 'training_profile');
      expect(cols.has('injuries_json')).toBe(true);
      expect(cols.has('named_program_history')).toBe(true);
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(17);
    } finally {
      db.close();
      store.close();
    }
  });

  it('leaves the existing profile intact with both fields absent, not empty', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const profile = await store.getTrainingProfile('local');

      expect(profile?.goal).toBe('get back to a 225 bench');
      expect(profile?.reportedSetsPerMuscle).toBe(10);
      // Absent, NOT `[]` — a pre-v17 row was never asked about injuries, and
      // back-filling an empty list would manufacture an "I have none" answer.
      expect(profile?.injuries).toBeUndefined();
      expect(profile?.namedProgramHistory).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('round-trips an injury list and a named program once written', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const existing = await store.getTrainingProfile('local');
      await store.putTrainingProfile({
        ...existing,
        userId: 'local',
        injuries: [
          { area: 'left shoulder', kind: 'lingering_joint', note: 'aches on overhead press' },
          { area: 'chest', kind: 'other', cardioLimitation: true },
        ],
        namedProgramHistory: '5/3/1',
        updatedAt: '2026-09-08T00:00:00.000Z',
      });

      const reread = await store.getTrainingProfile('local');

      expect(reread?.namedProgramHistory).toBe('5/3/1');
      expect(reread?.injuries).toEqual([
        { area: 'left shoulder', kind: 'lingering_joint', note: 'aches on overhead press' },
        { area: 'chest', kind: 'other', cardioLimitation: true },
      ]);
      expect(reread?.goal).toBe('get back to a 225 bench');
    } finally {
      store.close();
    }
  });

  it('round-trips an empty injury list as an answer, distinct from absent', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const existing = await store.getTrainingProfile('local');
      await store.putTrainingProfile({
        ...existing,
        userId: 'local',
        injuries: [],
        updatedAt: '2026-09-08T00:00:00.000Z',
      });

      const reread = await store.getTrainingProfile('local');

      expect(reread?.injuries).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('is a no-op when re-opened', () => {
    SqliteSessionStore.open(path).close();
    const store = SqliteSessionStore.open(path);
    const db = new DatabaseSync(path);
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(17);
    } finally {
      db.close();
      store.close();
    }
  });
});
