// Tests for the v26 -> v27 migration: the `priorities` and `goal_targets`
// tables (VW-349), exercised against a genuinely v26-shaped database rather
// than a fresh current-shape DB with its `user_version` stamp turned back —
// VW-288 found that stamping a current DB backwards proves nothing, because
// the tables under test are already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/**
 * `users` and `body_metrics` exactly as they stood after v26 — the v26 unique
 * index on `body_metrics` is PRESENT, and there is no `priorities` and no
 * `goal_targets`. Spelled out literally rather than derived from the
 * current `SCHEMA_SQL` so the fixture cannot drift forward with the code under
 * test.
 */
const V26_SCHEMA_SQL = `
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

function seedV26Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V26_SCHEMA_SQL);
  db.prepare(`INSERT INTO users (id, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')`).run(
    LOCAL_USER_ID,
  );
  db.prepare(
    `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs, notes)
     VALUES ('bm-old', ?, '2026-09-01T10:00:00.000Z', 182.5, 'pre-existing reading')`,
  ).run(LOCAL_USER_ID);
  db.exec('PRAGMA user_version = 26');
  db.close();
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v27-'));
  path = join(dir, 'v26.sqlite');
  seedV26Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v26 -> v27 migration', () => {
  it('creates priorities and goal_targets on a genuinely v26-shaped database', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const tables = tableNames(db);
        expect(tables.has('priorities')).toBe(true);
        expect(tables.has('goal_targets')).toBe(true);
        expect(columnNames(db, 'priorities')).toEqual([
          'id',
          'user_id',
          'block_id',
          'horizon_weeks',
          'kind',
          'ref',
          'level',
          'declared_at',
          'retired_at',
          'mesos_held',
        ]);
        expect(columnNames(db, 'goal_targets')).toEqual([
          'id',
          'priority_id',
          'metric',
          'exercise_id',
          'anchor_reps',
          'anchor_load',
          'block_id',
          'start_value',
          'start_measured_at',
          'band_low_pct_per_week',
          'band_high_pct_per_week',
          'committed_value',
          'stretch_value',
          'basis',
          'info_level',
          'tier_used',
          'tier_provisional',
          'diet_phase_at_derivation',
          'accepted_by',
          'acknowledged_stretch',
          'derived_at',
          'ends_at',
          'retired_at',
          'outcome',
          'new_chapter_at',
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it('reads zero priorities — no backfill, no manufactured default', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listPriorities(LOCAL_USER_ID)).toEqual([]);
      expect(await store.listPriorities(LOCAL_USER_ID, { includeRetired: true })).toEqual([]);
      expect(await store.listGoalTargets({ userId: LOCAL_USER_ID })).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('leaves the pre-existing row in another table untouched', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      expect(await store.listBodyMetrics(LOCAL_USER_ID)).toEqual([
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

  it('enforces the enum CHECK constraints the new tables declare', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(() =>
          db
            .prepare(
              `INSERT INTO priorities (id, user_id, horizon_weeks, kind, ref, level, declared_at)
               VALUES ('p-bad', ?, 12, 'tendon', 'biceps', 'specialize', '2026-09-13T00:00:00.000Z')`,
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
    await first.putPriority({
      id: 'p-1',
      userId: LOCAL_USER_ID,
      horizonWeeks: 12,
      kind: 'lift',
      ref: 'ex-bench-press',
      level: 'specialize',
      declaredAt: '2026-09-13T18:00:00.000Z',
      mesosHeld: 0,
    });
    await first.close();

    const store = SqliteSessionStore.open(path);
    try {
      expect((await store.listPriorities(LOCAL_USER_ID)).map((p) => p.id)).toEqual(['p-1']);
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(37);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });
});
