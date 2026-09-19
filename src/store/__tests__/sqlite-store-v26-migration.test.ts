// Tests for the v25 -> v26 migration: a unique index on
// `body_metrics(user_id, recorded_at)` (VW-327), exercised against a
// genuinely v25-shaped database rather than a fresh current-shape DB with its
// `user_version` stamp turned back — VW-288 found that stamping a current DB
// backwards proves nothing, because the table under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users` and `body_metrics` exactly as they stood after v25 — `body_metrics`
 * present since v6 with no unique index. Spelled out literally rather than
 * derived from the current `SCHEMA_SQL` so the fixture cannot drift forward
 * with the code under test.
 */
const V25_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE body_metrics (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL,
    bodyweight_lbs REAL,
    height_in REAL,
    notes TEXT
  );
`;

let dir: string;
let path: string;

function seedV25Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V25_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.prepare(
    `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs, notes)
     VALUES ('bm-old', ?, '2026-09-01T10:00:00.000Z', 182.5, 'pre-existing reading')`,
  ).run(LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 25');
  db.close();
}

function indexNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function indexColumns(db: DatabaseSync, indexName: string): string[] {
  const rows = db.prepare(`PRAGMA index_info(${indexName})`).all() as unknown as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v26-'));
  path = join(dir, 'v25.sqlite');
  seedV25Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v25 -> v26 migration', () => {
  it('adds a unique index on body_metrics(user_id, recorded_at) on a genuinely v25-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const names = indexNames(db, 'body_metrics');
        const target = [...names].find((name) => name === 'idx_body_metrics_user_recorded');
        expect(target).not.toBeUndefined();
        expect(indexColumns(db, target ?? '')).toEqual(['user_id', 'recorded_at']);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('enforces the new unique constraint against a second insert at the same key', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs)
               VALUES ('bm-dup', ?, '2026-09-01T10:00:00.000Z', 999)`,
            )
            .run(LOCAL_USER_ID),
        ).toThrow(/UNIQUE constraint failed/);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the pre-existing row untouched', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const rows = await store.listBodyMetrics(LOCAL_USER_ID);
      expect(rows).toEqual([
        {
          id: 'bm-old',
          userId: LOCAL_USER_ID,
          measuredAt: '2026-09-01T10:00:00.000Z',
          bodyweightLbs: 182.5,
          note: 'pre-existing reading',
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and is idempotent on re-open', () => {
    SqliteSessionStore.open(path).close();
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(34);
        const row = db.prepare('SELECT COUNT(*) AS n FROM body_metrics').get() as { n: number };
        expect(row.n).toBe(1);
        expect(indexNames(db, 'body_metrics').has('idx_body_metrics_user_recorded')).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });
});
