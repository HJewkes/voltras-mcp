// The audit trail refuses a REPLACE (VW-903). SQLite's REPLACE removes the conflicting row
// without firing a DELETE trigger, so `ui_actions_no_delete` alone let `REPLACE INTO` rewrite
// any row. The v43 step adds a BEFORE INSERT trigger that refuses an insert over a taken id.
// This file proves the refusal on a current store and on a store created at v42, and that
// every legal write still works.
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

const CURRENT_VERSION = 43;
const PRIOR_VERSION = 42;

const AT = '2026-10-01T09:00:00.000Z';
const DONE_AT = '2026-10-01T09:00:01.000Z';
const LATER = '2026-10-02T09:00:00.000Z';

const REFUSED = /rows are never replaced/;

const ROW_COLUMNS =
  'action_id, action_name, actor, surface, input_hash, result_status, result_json, ' +
  'created_at, completed_at';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-ui-actions-replace-'));
  path = join(dir, 'store.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withRawDb<T>(file: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function claim(store: SqliteSessionStore, actionId: string, inputHash = 'h-1'): Promise<unknown> {
  return store.claimUiAction({
    actionId,
    actionName: 'profile.log_bodyweight',
    actor: 'user',
    surface: 'wall',
    inputHash,
    createdAt: AT,
  });
}

/** A current store holding one completed row (`act-ok`) and one pending row (`act-pending`). */
async function seededStore(file: string): Promise<void> {
  const store = openSqliteTestStore({ path: file });
  await claim(store, 'act-ok');
  await store.completeUiAction({
    actionId: 'act-ok',
    resultStatus: 'ok',
    result: { logged: true },
    completedAt: DONE_AT,
  });
  await claim(store, 'act-pending', 'h-2');
  await store.close();
}

function rows(file: string): unknown[] {
  return withRawDb(file, (db) =>
    db
      .prepare(`SELECT ${ROW_COLUMNS} FROM ui_actions ORDER BY action_id`)
      .all()
      .map((row) => ({ ...row })),
  );
}

function replaceRow(file: string, verb: string, actionId: string): void {
  withRawDb(file, (db) =>
    db.exec(
      `${verb} INTO ui_actions (action_id, action_name, actor, surface, input_hash,
         result_status, created_at)
       VALUES ('${actionId}', 'forged.action', 'coach', 'phone', 'h-forged', 'ok', '${LATER}')`,
    ),
  );
}

function userVersion(file: string): number {
  return withRawDb(file, (db) => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  });
}

/** A store as v42 left it: today's shape with no replace trigger, stamped 42. */
async function v42Store(file: string): Promise<void> {
  await seededStore(file);
  withRawDb(file, (db) => {
    db.exec('DROP TRIGGER ui_actions_no_replace');
    db.exec(`PRAGMA user_version = ${PRIOR_VERSION}`);
  });
}

describe('a REPLACE on the ui_actions audit trail, on a current store', () => {
  it.each([
    ['REPLACE', 'act-ok'],
    ['REPLACE', 'act-pending'],
    ['INSERT OR REPLACE', 'act-ok'],
    ['INSERT OR REPLACE', 'act-pending'],
  ])('refuses %s over %s and leaves every row as it was', async (verb, actionId) => {
    await seededStore(path);
    const before = rows(path);

    expect(() => replaceRow(path, verb, actionId)).toThrow(REFUSED);

    expect(rows(path)).toEqual(before);
  });

  it('refuses an UPDATE OR REPLACE that moves one row onto another id', async () => {
    await seededStore(path);
    const before = rows(path);

    expect(() =>
      withRawDb(path, (db) =>
        db.exec(
          `UPDATE OR REPLACE ui_actions SET action_id = 'act-ok', result_status = 'ok'
            WHERE action_id = 'act-pending'`,
        ),
      ),
    ).toThrow(/complete once/);

    expect(rows(path)).toEqual(before);
  });

  it('still accepts an ordinary insert of a new id', async () => {
    await seededStore(path);

    replaceRow(path, 'INSERT', 'act-new');

    expect(rows(path)).toHaveLength(3);
  });
});

describe('claimUiAction and completeUiAction under the replace guard', () => {
  it('claims a new id, then reports the existing row on a replay of it', async () => {
    const store = openSqliteTestStore({ path });

    const first = await claim(store, 'act-1');
    const replay = await claim(store, 'act-1', 'h-other');
    await store.close();

    expect(first).toEqual({ kind: 'claimed' });
    expect(replay).toMatchObject({
      kind: 'taken',
      existing: { actionId: 'act-1', inputHash: 'h-1', resultStatus: 'pending' },
    });
  });

  it('reports a completed row on a replay of its id', async () => {
    await seededStore(path);
    const store = openSqliteTestStore({ path });

    const replay = await claim(store, 'act-ok');
    await store.close();

    expect(replay).toMatchObject({ kind: 'taken', existing: { resultStatus: 'ok' } });
  });

  it('still rejects a claim the table refuses for another reason', async () => {
    const store = openSqliteTestStore({ path });

    const bogus = store.claimUiAction({
      actionId: 'act-bogus',
      actionName: 'profile.log_bodyweight',
      actor: 'user',
      surface: 'billboard' as never,
      inputHash: 'h-1',
      createdAt: AT,
    });

    await expect(bogus).rejects.toThrow(/CHECK constraint/);
    await store.close();
  });

  it('completes a pending row once and refuses a second completion', async () => {
    const store = openSqliteTestStore({ path });
    await claim(store, 'act-1');

    const done = await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'ok',
      completedAt: DONE_AT,
    });
    const again = store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'error',
      completedAt: LATER,
    });

    await expect(again).rejects.toThrow(/no pending action/);
    await store.close();
    expect(done).toMatchObject({ resultStatus: 'ok', completedAt: DONE_AT });
  });
});

describe('the v43 step, from a store created at v42', () => {
  it('lets a REPLACE through before the step runs, which is the hole it closes', async () => {
    await v42Store(path);

    replaceRow(path, 'REPLACE', 'act-ok');

    expect(rows(path)).toContainEqual(
      expect.objectContaining({ action_id: 'act-ok', action_name: 'forged.action' }),
    );
  });

  it('opens at 43 with every row intact and then refuses a REPLACE', async () => {
    await v42Store(path);
    const before = rows(path);

    await openSqliteTestStore({ path }).close();

    expect(userVersion(path)).toBe(CURRENT_VERSION);
    expect(rows(path)).toEqual(before);
    expect(() => replaceRow(path, 'REPLACE', 'act-ok')).toThrow(REFUSED);
    expect(() => replaceRow(path, 'INSERT OR REPLACE', 'act-pending')).toThrow(REFUSED);
    expect(rows(path)).toEqual(before);
  });

  it('keeps the idempotent replay working on the upgraded store', async () => {
    await v42Store(path);
    const store = openSqliteTestStore({ path });

    const replay = await claim(store, 'act-pending');
    await store.close();

    expect(replay).toMatchObject({ kind: 'taken', existing: { inputHash: 'h-2' } });
  });
});

describe('portable export and import under the replace guard', () => {
  it('round-trips every row, and the restored store refuses a REPLACE too', async () => {
    await seededStore(path);
    const outDir = join(dir, 'export');
    const restored = join(dir, 'restored.sqlite');

    exportStore(path, outDir);
    await importStore(outDir, restored);

    expect(verifyStore(path, restored)).toEqual({ equal: true, differences: [] });
    expect(rows(restored)).toEqual(rows(path));
    expect(() => replaceRow(restored, 'REPLACE', 'act-ok')).toThrow(REFUSED);
  });
});
