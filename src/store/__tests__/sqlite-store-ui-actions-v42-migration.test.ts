// The agent-audit migration (VW-890, S1 of VW-849): `ui_actions` gains the `mcp` surface and
// three nullable columns (`reason`, `summary_json`, `session_id`). SQLite cannot alter a CHECK,
// so the step rebuilds the table; this file runs it against a genuinely v41 table holding rows.
//
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportStore } from '../portable/export.js';
import { importStore } from '../portable/import.js';
import { verifyStore } from '../portable/verify.js';
import type { SqliteSessionStore } from '../sqlite-store.js';
import { openSqliteTestStore } from './open-test-store.js';

const CURRENT_VERSION = 44;
const PRIOR_VERSION = 41;

/** `ui_actions` as it stood at v41: no `mcp`, no reason, summary or session. */
const V41_SCHEMA_SQL = `
  CREATE TABLE ui_actions (
    action_id TEXT PRIMARY KEY,
    action_name TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','coach','tick')),
    surface TEXT NOT NULL CHECK (surface IN ('wall','phone','voice','telegram')),
    device_id TEXT,
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
  CREATE INDEX idx_ui_actions_device ON ui_actions(device_id, created_at DESC);
  CREATE TRIGGER ui_actions_complete_once
    BEFORE UPDATE ON ui_actions
    WHEN NOT (
      OLD.result_status = 'pending'
      AND NEW.result_status IN ('ok','error')
      AND NEW.action_id = OLD.action_id
      AND NEW.action_name = OLD.action_name
      AND NEW.actor = OLD.actor
      AND NEW.surface = OLD.surface
      AND NEW.device_id IS OLD.device_id
      AND NEW.input_hash = OLD.input_hash
      AND NEW.created_at = OLD.created_at
    )
    BEGIN SELECT RAISE(ABORT, 'ui_actions rows complete once: pending -> ok or error'); END;
  CREATE TRIGGER ui_actions_no_delete
    BEFORE DELETE ON ui_actions
    BEGIN SELECT RAISE(ABORT, 'ui_actions is an audit trail: rows are never deleted'); END;
`;

const V41_COLUMNS =
  'action_id, action_name, actor, surface, device_id, flow_id, flow_step, input_hash, ' +
  'result_status, result_code, result_json, created_at, completed_at';

const AT = '2026-10-01T09:00:00.000Z';
const DONE_AT = '2026-10-01T09:00:01.000Z';
const LATER = '2026-10-02T09:00:00.000Z';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-ui-actions-v42-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A v41 file holding a completed row, a pending row and a flow row. */
function v41Store(name = 'v41.sqlite'): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec(V41_SCHEMA_SQL);
  db.exec(
    `INSERT INTO ui_actions (action_id, action_name, actor, surface, device_id, flow_id,
       flow_step, input_hash, result_status, result_code, result_json, created_at, completed_at)
     VALUES
       ('act-ok', 'profile.log_bodyweight', 'user', 'wall', 'wall-a', NULL, NULL, 'h1',
        'ok', NULL, '{"logged":true}', '${AT}', '${DONE_AT}'),
       ('act-pending', 'session.checkin', 'coach', 'phone', NULL, NULL, NULL, 'h2',
        'pending', NULL, NULL, '${AT}', NULL),
       ('act-flow', 'plan.accept', 'user', 'voice', NULL, 'flow-1', 'step-2', 'h3',
        'error', 'REFUSED', 'null', '${AT}', '${DONE_AT}')`,
  );
  db.exec(`PRAGMA user_version = ${PRIOR_VERSION}`);
  db.close();
  return path;
}

function oldRows(path: string): unknown[] {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(`SELECT ${V41_COLUMNS} FROM ui_actions ORDER BY action_id`)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function withRawDb<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function shapeOf(file: string): { columns: string[]; indexes: string[]; triggers: string[] } {
  return withRawDb(file, (db) => {
    const columns = (
      db.prepare(`SELECT name FROM pragma_table_info('ui_actions')`).all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    const objects = db
      .prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'ui_actions'`)
      .all() as unknown as { type: string; name: string }[];
    const names = (type: string): string[] =>
      objects
        .filter((row) => row.type === type)
        .map((row) => row.name)
        .sort();
    return { columns: columns.sort(), indexes: names('index'), triggers: names('trigger') };
  });
}

async function claimMcp(store: SqliteSessionStore, actionId: string, at = LATER): Promise<void> {
  await store.claimUiAction({
    actionId,
    actionName: 'device.connect',
    actor: 'coach',
    surface: 'mcp',
    reason: 'warm-up',
    summaryJson: '{"target":"device"}',
    sessionId: 'sess-1',
    inputHash: 'h-mcp',
    createdAt: at,
  });
}

describe('the ui_actions v42 migration, from a v41 store with rows', () => {
  it('opens at 42 and keeps every old row byte-identical', async () => {
    const path = v41Store();
    const before = oldRows(path);

    await openSqliteTestStore({ path: path }).close();

    expect(withRawDb(path, (db) => db.prepare('PRAGMA user_version').get())).toEqual({
      user_version: CURRENT_VERSION,
    });
    expect(oldRows(path)).toEqual(before);
    expect(before).toHaveLength(3);
  });

  it('reads the old rows as naming no reason, summary or session', async () => {
    const path = v41Store();
    const store = openSqliteTestStore({ path: path });

    const rows = await store.listUiActions();
    await store.close();

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.reason).toBeUndefined();
      expect(row.summaryJson).toBeUndefined();
      expect(row.sessionId).toBeUndefined();
    }
  });

  it('accepts the mcp surface with reason, summary and session', async () => {
    const path = v41Store();
    const store = openSqliteTestStore({ path: path });

    await claimMcp(store, 'act-mcp');
    const row = await store.getUiAction('act-mcp');
    await store.close();

    expect(row).toMatchObject({
      surface: 'mcp',
      actor: 'coach',
      reason: 'warm-up',
      summaryJson: '{"target":"device"}',
      sessionId: 'sess-1',
    });
  });

  it('still refuses a surface outside the list', () => {
    const path = v41Store();
    openSqliteTestStore({ path: path }).close();

    expect(() =>
      withRawDb(path, (db) =>
        db.exec(
          `INSERT INTO ui_actions (action_id, action_name, actor, surface, input_hash,
             result_status, created_at)
           VALUES ('x', 'a', 'user', 'carrier-pigeon', 'h', 'pending', '${AT}')`,
        ),
      ),
    ).toThrow(/CHECK/);
  });

  it('still refuses DELETE, of an old row and of a new one', async () => {
    const path = v41Store();
    const store = openSqliteTestStore({ path: path });
    await claimMcp(store, 'act-mcp');
    await store.close();

    for (const id of ['act-ok', 'act-mcp']) {
      expect(() =>
        withRawDb(path, (db) => db.exec(`DELETE FROM ui_actions WHERE action_id = '${id}'`)),
      ).toThrow(/never deleted/);
    }
    expect(oldRows(path)).toHaveLength(4);
  });

  it('refuses a REPLACE over an old row once the ladder reaches v43 (VW-903)', async () => {
    const path = v41Store();
    await openSqliteTestStore({ path: path }).close();
    const before = oldRows(path);

    expect(() =>
      withRawDb(path, (db) =>
        db.exec(
          `REPLACE INTO ui_actions (action_id, action_name, actor, surface, input_hash,
             result_status, created_at)
           VALUES ('act-ok', 'forged', 'coach', 'phone', 'h', 'ok', '${LATER}')`,
        ),
      ),
    ).toThrow(/never replaced/);
    expect(oldRows(path)).toEqual(before);
  });

  it.each(['reason', 'summary_json', 'session_id'])(
    'complete-once refuses an edit to %s',
    async (column) => {
      const path = v41Store();
      const store = openSqliteTestStore({ path: path });
      await claimMcp(store, 'act-mcp');
      await store.close();

      expect(() =>
        withRawDb(path, (db) =>
          db.exec(
            `UPDATE ui_actions SET ${column} = 'edited', result_status = 'ok'
              WHERE action_id = 'act-mcp'`,
          ),
        ),
      ).toThrow(/complete once/);
    },
  );

  it('completes an mcp row without disturbing its new columns', async () => {
    const path = v41Store();
    const store = openSqliteTestStore({ path: path });
    await claimMcp(store, 'act-mcp');

    const done = await store.completeUiAction({
      actionId: 'act-mcp',
      resultStatus: 'ok',
      result: null,
      completedAt: DONE_AT,
    });
    await store.close();

    expect(done).toMatchObject({ resultStatus: 'ok', reason: 'warm-up', sessionId: 'sess-1' });
  });

  it('indexes the session lookup', async () => {
    const path = v41Store();
    await openSqliteTestStore({ path: path }).close();

    expect(shapeOf(path).indexes).toContain('idx_ui_actions_session');
  });

  it('changes nothing on a second open', async () => {
    const path = v41Store();
    await openSqliteTestStore({ path: path }).close();
    const shape = shapeOf(path);
    const rows = oldRows(path);

    await openSqliteTestStore({ path: path }).close();

    expect(shapeOf(path)).toEqual(shape);
    expect(oldRows(path)).toEqual(rows);
  });

  it('gives a fresh store the same shape as the migrated one', async () => {
    const path = v41Store();
    await openSqliteTestStore({ path: path }).close();
    const freshPath = join(dir, 'fresh.sqlite');

    await openSqliteTestStore({ path: freshPath }).close();

    expect(shapeOf(freshPath)).toEqual(shapeOf(path));
    expect(withRawDb(freshPath, (db) => db.prepare('PRAGMA user_version').get())).toEqual({
      user_version: CURRENT_VERSION,
    });
  });

  it('rolls back and leaves the v41 shape when the rebuild fails', () => {
    const path = v41Store();
    // A pre-existing scratch table makes the rebuild's CREATE a no-op that then copies into the
    // wrong shape and fails the INSERT, which is a failure after the first statement ran.
    withRawDb(path, (db) => db.exec(`CREATE TABLE ui_actions_v42 (action_id TEXT)`));

    expect(() => openSqliteTestStore({ path: path })).toThrow();

    const columns = shapeOf(path).columns;
    expect(columns).not.toContain('reason');
    expect(oldRows(path)).toHaveLength(3);
  });
});

describe('a v42 store through the portable export', () => {
  it('round-trips the new columns and verifies equal', async () => {
    const path = v41Store();
    const store = openSqliteTestStore({ path: path });
    await claimMcp(store, 'act-mcp');
    await store.close();
    const outDir = join(dir, 'out');
    const restored = join(dir, 'restored.sqlite');

    exportStore(path, outDir);
    await importStore(outDir, restored);

    expect(verifyStore(path, restored)).toEqual({ equal: true, differences: [] });
    const reopened = openSqliteTestStore({ path: restored });
    const row = await reopened.getUiAction('act-mcp');
    await reopened.close();
    expect(row).toMatchObject({ surface: 'mcp', reason: 'warm-up', sessionId: 'sess-1' });
  });
});
