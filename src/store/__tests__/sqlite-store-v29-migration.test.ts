// Tests for the v28 -> v29 migration: the `exercise_chapters` table (VW-361),
// exercised against a genuinely v28-shaped database rather than a fresh
// current-shape DB with its `user_version` stamp turned back — VW-288 found
// that stamping a current DB backwards proves nothing, because the table under
// test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users` and `sessions` exactly as they stood at v28, with NO
 * `exercise_chapters`. Spelled out literally rather than derived from the
 * current `SCHEMA_SQL` so the fixture cannot drift forward with the code under
 * test.
 */
const V28_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT,
    user_id TEXT REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'local'
  );
`;

let dir: string;
let path: string;

function seedV28Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V28_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO users (id, created_at, is_default) VALUES (?, '2026-09-01T00:00:00.000Z', 1)`,
  ).run(LOCAL_USER_ID);
  db.prepare(
    `INSERT INTO sessions (id, started_at, exercise_id, user_id)
     VALUES ('s-old', '2026-09-01T10:00:00.000Z', 'back-squat', ?)`,
  ).run(LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 28');
  db.close();
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v29-'));
  path = join(dir, 'v28.sqlite');
  seedV28Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v28 -> v29 migration', () => {
  it('creates exercise_chapters on a genuinely v28-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db)).toContain('exercise_chapters');
        expect(columnNames(db, 'exercise_chapters')).toEqual([
          'id',
          'user_id',
          'exercise_id',
          'started_at',
          'ended_at',
          'declared_at',
          'reason',
          'retired_at',
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('back-fills nothing: a migrated database has declared no chapter', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listExerciseChapters(LOCAL_USER_ID)).toEqual([]);
      expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('leaves the pre-existing session untouched', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const session = await store.getSession('s-old');
      expect(session?.startedAt).toBe('2026-09-01T10:00:00.000Z');
      expect(session?.exerciseId).toBe('back-squat');
    } finally {
      await store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and is idempotent on re-open', async () => {
    const first = SqliteSessionStore.open(path);
    const chapter = await first.markExerciseChapter({
      userId: LOCAL_USER_ID,
      exerciseId: 'back-squat',
      startedAt: '2026-09-05T00:00:00.000Z',
      declaredAt: '2026-09-06T00:00:00.000Z',
      reason: 'reformed depth',
    });
    await first.close();

    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listExerciseChapters(LOCAL_USER_ID)).toEqual([
        {
          id: chapter.id,
          userId: LOCAL_USER_ID,
          exerciseId: 'back-squat',
          startedAt: '2026-09-05T00:00:00.000Z',
          declaredAt: '2026-09-06T00:00:00.000Z',
          reason: 'reformed depth',
        },
      ]);
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as unknown as {
          user_version: number;
        };
        expect(version.user_version).toBe(29);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});
