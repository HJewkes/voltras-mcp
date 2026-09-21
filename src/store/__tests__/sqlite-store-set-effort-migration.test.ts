// The set effort-storage migration (VW-539): `sets.effort_context_json` and
// `sets.cue_record_json`, both nullable JSON, exercised against a genuinely pre-migration
// `sets` table holding a row (VW-288).
//
// Run from the version before this step (39) and on the chain from 37, the version the
// owner's live store was on when the step landed; plus a fresh store.
//
// Named for what it migrates rather than for a version number, so a re-number is
// `CURRENT_VERSION` and the `FROM_VERSIONS` list alone.
//
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import type { StoredSet } from '../types.js';

const CURRENT_VERSION = 40;
const FROM_VERSIONS = [37, 39] as const;

/** What v38 and v39 added elsewhere, taken back off so a v37 file is genuinely v37. */
const UNDO_V38_AND_V39_SQL = `
  DROP INDEX idx_ui_actions_device;
  DROP TRIGGER ui_actions_complete_once;
  ALTER TABLE ui_actions DROP COLUMN device_id;
  ALTER TABLE planned_exercises DROP COLUMN goal_kind;
  ALTER TABLE planned_exercises DROP COLUMN target_velocity_loss_pct;
  ALTER TABLE planned_exercises DROP COLUMN rest_learning;
  DROP TABLE learned_rest;
`;

const OLD_SET_SQL = `
  INSERT INTO sets (id, session_id, user_id, started_at, ended_at, partial,
    training_mode, weight_lbs, settings_hash)
  VALUES ('set-old', 'sess-old', 'local', '2026-09-20T18:00:00.000Z',
    '2026-09-20T18:00:40.000Z', 0, 'WeightTraining', 100, 'v1:synthetic')`;

const CONTEXT = { goal: { kind: 'rep_range', low: 8, high: 10 }, guard: null, lossPct: 20 };
const CUE = { fired: false, reasons: ['calibrating'] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-set-effort-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A pre-migration file at `version`: a fully-shaped store with this step's columns (and,
 * for 37, the two later steps) taken back off. Dropping is how the shape is reached, never
 * how it is tested.
 */
function priorStore(version: number): string {
  const path = join(dir, `store-${version}.sqlite`);
  SqliteSessionStore.open(path).close();
  const db = new DatabaseSync(path);
  db.exec(`
    ALTER TABLE sets DROP COLUMN effort_context_json;
    ALTER TABLE sets DROP COLUMN cue_record_json;
  `);
  if (version < 38) db.exec(UNDO_V38_AND_V39_SQL);
  db.exec(OLD_SET_SQL);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return path;
}

function effortSet(overrides: Partial<StoredSet> = {}): StoredSet {
  return {
    id: 'set-new',
    sessionId: 'sess-new',
    startedAt: '2026-09-21T18:00:00.000Z',
    endedAt: '2026-09-21T18:00:40.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 100,
    reps: [],
    ...overrides,
  };
}

describe.each(FROM_VERSIONS)('the set effort-storage migration, from v%i', (from) => {
  it('keeps the pre-existing set and reads it with neither field', async () => {
    const store = SqliteSessionStore.open(priorStore(from));

    const set = await store.getSet('set-old');
    await store.close();

    expect(set?.settingsHash).toBe('v1:synthetic');
    expect(set).not.toHaveProperty('effortContext');
    expect(set).not.toHaveProperty('cueRecord');
  });

  it('stamps the version and changes nothing on a second open', async () => {
    const path = priorStore(from);
    await SqliteSessionStore.open(path).close();
    const once = shapeOf(path);
    await SqliteSessionStore.open(path).close();

    expect(userVersion(path)).toBe(CURRENT_VERSION);
    expect(shapeOf(path)).toEqual(once);
  });

  it('gives a fresh store the same columns as the migrated one', async () => {
    const path = priorStore(from);
    await SqliteSessionStore.open(path).close();
    const freshPath = join(dir, `fresh-${from}.sqlite`);
    await SqliteSessionStore.open(freshPath).close();

    expect(shapeOf(freshPath).columns).toEqual(shapeOf(path).columns);
  });

  it('refuses a string that is not JSON in either column, as a fresh store does', async () => {
    const path = priorStore(from);
    await SqliteSessionStore.open(path).close();

    for (const column of ['effort_context_json', 'cue_record_json']) {
      expect(() =>
        rawExec(path, `UPDATE sets SET ${column} = '{not json' WHERE id = 'set-old'`),
      ).toThrow(/CHECK constraint failed/);
    }
  });
});

describe('the set effort-storage columns on a fresh store', () => {
  it('round-trips a context and a cue record through the port', async () => {
    const store = SqliteSessionStore.open(join(dir, 'fresh.sqlite'));

    await store.putSet(effortSet({ effortContext: CONTEXT, cueRecord: CUE }));
    const set = await store.getSet('set-new');
    await store.close();

    expect(set?.effortContext).toEqual(CONTEXT);
    expect(set?.cueRecord).toEqual(CUE);
  });

  // `putSet` is an upsert; a column missing from its DO UPDATE list never updates on a re-put.
  it('replaces both on a re-put of the same set', async () => {
    const store = SqliteSessionStore.open(join(dir, 'fresh.sqlite'));

    await store.putSet(effortSet({ effortContext: CONTEXT, cueRecord: CUE }));
    await store.putSet(effortSet({ effortContext: { goal: null }, cueRecord: { fired: true } }));
    const set = await store.getSet('set-new');
    await store.close();

    expect(set?.effortContext).toEqual({ goal: null });
    expect(set?.cueRecord).toEqual({ fired: true });
  });

  it('writes NULL, and reads neither field, for a set that has neither', async () => {
    const path = join(dir, 'fresh.sqlite');
    const store = SqliteSessionStore.open(path);

    await store.putSet(effortSet());
    const set = await store.getSet('set-new');
    await store.close();

    expect(set).toEqual({ ...effortSet(), source: 'local' });
    const db = new DatabaseSync(path);
    const row = db
      .prepare(`SELECT effort_context_json, cue_record_json FROM sets WHERE id = 'set-new'`)
      .get();
    db.close();
    expect(row).toEqual({ effort_context_json: null, cue_record_json: null });
  });

  it('refuses a string that is not JSON', async () => {
    const path = join(dir, 'fresh.sqlite');
    const store = SqliteSessionStore.open(path);
    await store.putSet(effortSet());
    await store.close();

    expect(() =>
      rawExec(path, `UPDATE sets SET cue_record_json = 'fired' WHERE id = 'set-new'`),
    ).toThrow(/CHECK constraint failed/);
  });
});

function rawExec(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return row.user_version;
}

/** The `sets` columns and the row count, in a comparable form. */
function shapeOf(path: string): { columns: string[]; rows: number } {
  const db = new DatabaseSync(path);
  const columns = (
    db.prepare(`SELECT name FROM pragma_table_info('sets')`).all() as unknown as {
      name: string;
    }[]
  ).map((row) => row.name);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM sets').get() as { n: number };
  db.close();
  return { columns: columns.sort(), rows: rows.n };
}
