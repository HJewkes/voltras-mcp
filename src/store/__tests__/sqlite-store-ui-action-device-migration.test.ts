// The device-id migration (VW-521): one nullable column and one index on `ui_actions`,
// exercised against a genuinely pre-migration table holding rows (VW-288).
//
// Run against BOTH shapes a real file can have — the version the table was born at (36)
// and the version before this step (38) — because the rung reads `current <= 38` and both
// fall into it. The prior DDL is the same for the two: nothing between 36 and 38 touched
// this table.
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

const CURRENT_VERSION = 39;
const FROM_VERSIONS = [36, 38] as const;

/** `ui_actions` as it stood from v36 through v38: no `device_id`, no device index. */
const PRIOR_SCHEMA_SQL = `
  CREATE TABLE ui_actions (
    action_id TEXT PRIMARY KEY,
    action_name TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','coach','tick')),
    surface TEXT NOT NULL CHECK (surface IN ('wall','phone','voice','telegram')),
    flow_id TEXT,
    flow_step TEXT,
    input_hash TEXT NOT NULL,
    result_status TEXT NOT NULL CHECK (result_status IN ('pending','ok','error')),
    result_code TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_ui_actions_created ON ui_actions(created_at DESC);
  CREATE INDEX idx_ui_actions_flow ON ui_actions(flow_id, created_at DESC);
  CREATE TRIGGER ui_actions_complete_once
    BEFORE UPDATE ON ui_actions
    WHEN NOT (
      OLD.result_status = 'pending'
      AND NEW.result_status IN ('ok','error')
      AND NEW.action_id = OLD.action_id
      AND NEW.action_name = OLD.action_name
      AND NEW.actor = OLD.actor
      AND NEW.surface = OLD.surface
      AND NEW.input_hash = OLD.input_hash
      AND NEW.created_at = OLD.created_at
    )
    BEGIN SELECT RAISE(ABORT, 'ui_actions rows complete once: pending -> ok or error'); END;
  CREATE TRIGGER ui_actions_no_delete
    BEFORE DELETE ON ui_actions
    BEGIN SELECT RAISE(ABORT, 'ui_actions is an audit trail: rows are never deleted'); END;
`;

const AT = '2026-09-20T18:00:00.000Z';
const DONE_AT = '2026-09-20T18:00:01.000Z';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-ui-action-device-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pre-migration file at `version`, holding one completed row nobody can attribute. */
function priorStore(version: number): string {
  const path = join(dir, `store-${version}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec(PRIOR_SCHEMA_SQL);
  db.exec(
    `INSERT INTO ui_actions (action_id, action_name, actor, surface, input_hash,
       result_status, result_json, created_at, completed_at)
     VALUES ('act-old', 'profile.log_bodyweight', 'user', 'wall', 'hash-old',
       'ok', '{"logged":true}', '${AT}', '${DONE_AT}')`,
  );
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return path;
}

describe.each(FROM_VERSIONS)('the device-id migration, from v%i', (from) => {
  it('keeps the pre-existing row and reads it as naming no display', async () => {
    const path = priorStore(from);
    const store = SqliteSessionStore.open(path);

    const rows = await store.listUiActions();
    await store.close();

    expect(rows.map((row) => row.actionId)).toEqual(['act-old']);
    expect(rows[0]?.deviceId).toBeUndefined();
  });

  it('stamps the version and changes nothing on a second open', async () => {
    const path = priorStore(from);
    await SqliteSessionStore.open(path).close();
    const once = shapeOf(path);
    await SqliteSessionStore.open(path).close();

    const db = new DatabaseSync(path);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const count = db.prepare('SELECT COUNT(*) AS n FROM ui_actions').get() as { n: number };
    db.close();

    expect(version.user_version).toBe(CURRENT_VERSION);
    expect(count.n).toBe(1);
    expect(shapeOf(path)).toEqual(once);
  });

  it('gives a fresh store the same shape as the migrated one', async () => {
    const path = priorStore(from);
    await SqliteSessionStore.open(path).close();
    const freshPath = join(dir, `fresh-${from}.sqlite`);
    await SqliteSessionStore.open(freshPath).close();

    expect(shapeOf(freshPath)).toEqual(shapeOf(path));
  });

  it('records a display on a row written after the migration', async () => {
    const path = priorStore(from);
    const store = SqliteSessionStore.open(path);

    await store.claimUiAction({
      actionId: 'act-new',
      actionName: 'session.checkin',
      actor: 'user',
      surface: 'wall',
      deviceId: 'wall-garage',
      inputHash: 'hash-new',
      createdAt: DONE_AT,
    });
    const rows = await store.listUiActions({ deviceId: 'wall-garage' });
    await store.close();

    expect(rows.map((row) => row.actionId)).toEqual(['act-new']);
  });

  // The trigger is recreated by the step rather than left as it was, so a migrated store
  // refuses a rewritten device id exactly as a fresh one does.
  it('pins the device id against a later edit', async () => {
    const path = priorStore(from);
    const store = SqliteSessionStore.open(path);
    await store.claimUiAction({
      actionId: 'act-new',
      actionName: 'session.checkin',
      actor: 'user',
      surface: 'wall',
      deviceId: 'wall-garage',
      inputHash: 'hash-new',
      createdAt: DONE_AT,
    });
    await store.close();

    const db = new DatabaseSync(path);
    try {
      expect(() =>
        db.exec(`UPDATE ui_actions SET device_id = 'wall-kitchen' WHERE action_id = 'act-new'`),
      ).toThrow(/complete once/);
    } finally {
      db.close();
    }
  });
});

/** The columns, indexes and triggers a reader depends on, in a comparable form. */
function shapeOf(file: string): { columns: string[]; indexes: string[]; triggers: string[] } {
  const db = new DatabaseSync(file);
  const columns = (
    db.prepare(`SELECT name FROM pragma_table_info('ui_actions')`).all() as unknown as {
      name: string;
    }[]
  ).map((row) => row.name);
  const objects = db
    .prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'ui_actions'`)
    .all() as unknown as { type: string; name: string }[];
  db.close();
  return {
    columns: columns.sort(),
    indexes: objects
      .filter((row) => row.type === 'index')
      .map((row) => row.name)
      .sort(),
    triggers: objects
      .filter((row) => row.type === 'trigger')
      .map((row) => row.name)
      .sort(),
  };
}
