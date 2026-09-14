// Tests for the v29 -> v30 migration: `diet_phases.recomp_mode` (VW-378),
// exercised against a genuinely v29-shaped database rather than a fresh
// current-shape DB with its `user_version` stamp turned back — VW-288 found
// that stamping a current DB backwards proves nothing, because the column
// under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users` and `diet_phases` exactly as they stood at v29, with NO
 * `recomp_mode`. Spelled out literally rather than derived from the current
 * `SCHEMA_SQL` so the fixture cannot drift forward with the code under test.
 */
const V29_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE diet_phases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    declared_at TEXT NOT NULL
  );
`;

let dir: string;
let path: string;

function seedV29Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V29_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO users (id, created_at, is_default) VALUES (?, '2026-09-01T00:00:00.000Z', 1)`,
  ).run(LOCAL_USER_ID);
  db.prepare(
    `INSERT INTO diet_phases (id, user_id, phase, started_at, declared_at)
     VALUES ('dp-old', ?, 'recomposition', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  ).run(LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 29');
  db.close();
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v30-'));
  path = join(dir, 'v29.sqlite');
  seedV29Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v29 -> v30 migration', () => {
  it('adds recomp_mode to a genuinely v29-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(columnNames(db, 'diet_phases')).toEqual([
          'id',
          'user_id',
          'phase',
          'started_at',
          'ended_at',
          'declared_at',
          'recomp_mode',
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('back-fills nothing: a pre-v30 recomposition has declared no mode', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listDietPhases(LOCAL_USER_ID)).toEqual([
        {
          id: 'dp-old',
          userId: LOCAL_USER_ID,
          phase: 'recomposition',
          startedAt: '2026-09-01T00:00:00.000Z',
          declaredAt: '2026-09-01T00:00:00.000Z',
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('enforces the recomp_mode CHECK the migration declares', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO diet_phases (id, user_id, phase, started_at, declared_at, recomp_mode)
               VALUES ('dp-bad', ?, 'recomposition', '2026-09-08T00:00:00.000Z',
                       '2026-09-08T00:00:00.000Z', 'fast-loss')`,
            )
            .run(LOCAL_USER_ID),
        ).toThrow(/CHECK constraint failed/);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and is idempotent on re-open', async () => {
    const first = SqliteSessionStore.open(path);
    const declared = await first.declareDietPhase({
      userId: LOCAL_USER_ID,
      phase: 'recomposition',
      startedAt: '2026-09-08T00:00:00.000Z',
      declaredAt: '2026-09-08T00:00:00.000Z',
      recompMode: 'slow-loss',
    });
    await first.close();

    const store = SqliteSessionStore.open(path);
    try {
      const timeline = await store.listDietPhases(LOCAL_USER_ID);
      expect(timeline[timeline.length - 1]).toEqual({
        id: declared.id,
        userId: LOCAL_USER_ID,
        phase: 'recomposition',
        startedAt: '2026-09-08T00:00:00.000Z',
        declaredAt: '2026-09-08T00:00:00.000Z',
        recompMode: 'slow-loss',
      });
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as unknown as {
          user_version: number;
        };
        expect(version.user_version).toBe(30);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});
