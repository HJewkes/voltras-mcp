// Tests for the v27 -> v28 migration: the five leanness columns on
// `body_metrics` (VW-364), exercised against a genuinely v27-shaped database
// rather than a fresh current-shape DB with its `user_version` stamp turned
// back — VW-288 found that stamping a current DB backwards proves nothing,
// because the columns under test are already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users` and `body_metrics` exactly as they stood after v27 — the v26 unique
 * index is PRESENT and none of the five v28 columns is. Spelled out literally
 * rather than derived from the current `SCHEMA_SQL` so the fixture cannot
 * drift forward with the code under test.
 */
const V27_SCHEMA_SQL = `
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
  CREATE UNIQUE INDEX idx_body_metrics_user_recorded
    ON body_metrics(user_id, recorded_at);
`;

let dir: string;
let path: string;

function seedV27Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V27_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.prepare(
    `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs, notes)
     VALUES ('bm-old', ?, '2026-09-01T10:00:00.000Z', 330.0, 'pre-existing weigh-in')`,
  ).run(LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 27');
  db.close();
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v28-'));
  path = join(dir, 'v27.sqlite');
  seedV27Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v27 -> v28 migration', () => {
  it('adds the five leanness columns to a genuinely v27-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(columnNames(db, 'body_metrics')).toEqual([
          'id',
          'user_id',
          'recorded_at',
          'bodyweight_lbs',
          'height_in',
          'notes',
          'leanness_band',
          'waist_in',
          'body_fat_pct',
          'body_fat_source',
          'measurement_protocol',
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('leaves the pre-existing weigh-in untouched and back-fills nothing', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listBodyMetrics(LOCAL_USER_ID)).toEqual([
        {
          id: 'bm-old',
          userId: LOCAL_USER_ID,
          measuredAt: '2026-09-01T10:00:00.000Z',
          bodyweightLbs: 330.0,
          note: 'pre-existing weigh-in',
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it('enforces the leanness_band CHECK the migration declares', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs, leanness_band)
               VALUES ('bm-bad', ?, '2026-09-02T10:00:00.000Z', 330.0, 'shredded')`,
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

  it('enforces the body_fat_source CHECK the migration declares', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO body_metrics
                 (id, user_id, recorded_at, bodyweight_lbs, body_fat_pct, body_fat_source)
               VALUES ('bm-bad', ?, '2026-09-02T10:00:00.000Z', 330.0, 31.2, 'eyeballed')`,
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
    await first.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-08T10:00:00.000Z',
      bodyweightLbs: 327.5,
      leannessBand: 'high',
      waistIn: 48.5,
      bodyFatPct: 34.0,
      bodyFatSource: 'consumer_bia',
      measurementProtocol: 'morning, fasted, same scale',
    });
    await first.close();

    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listBodyMetrics(LOCAL_USER_ID)).toEqual([
        {
          id: expect.any(String) as unknown as string,
          userId: LOCAL_USER_ID,
          measuredAt: '2026-09-08T10:00:00.000Z',
          bodyweightLbs: 327.5,
          leannessBand: 'high',
          waistIn: 48.5,
          bodyFatPct: 34.0,
          bodyFatSource: 'consumer_bia',
          measurementProtocol: 'morning, fasted, same scale',
        },
        {
          id: 'bm-old',
          userId: LOCAL_USER_ID,
          measuredAt: '2026-09-01T10:00:00.000Z',
          bodyweightLbs: 330.0,
          note: 'pre-existing weigh-in',
        },
      ]);
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as unknown as {
          user_version: number;
        };
        expect(version.user_version).toBe(37);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});
