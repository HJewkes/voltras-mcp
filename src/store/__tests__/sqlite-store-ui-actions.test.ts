// The `ui_actions` audit table against a real SQLite file (VW-502).
//
// The claim race and the triggers are the two things an in-memory fake cannot
// prove, so they are tested here against the actual database: the primary key
// is what makes an action run once, and the triggers are what make the trail
// an audit trail rather than a mutable log.
//
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteSessionStore } from '../sqlite-store.js';
import { openSqliteTestStore } from './open-test-store.js';

const AT = '2026-09-19T12:00:00.000Z';
const DONE_AT = '2026-09-19T12:00:01.000Z';

let dir: string;
let path: string;
let store: SqliteSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-ui-actions-'));
  path = join(dir, 'store.sqlite');
  store = openSqliteTestStore({ path });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function claim(actionId: string, inputHash = 'hash-1'): Promise<unknown> {
  return store.claimUiAction({
    actionId,
    actionName: 'profile.log_bodyweight',
    actor: 'user',
    surface: 'wall',
    inputHash,
    createdAt: AT,
  });
}

/** Reach past the store to the file, for the trigger tests. */
function withRawDb<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe('claimUiAction', () => {
  it('claims a new id', async () => {
    expect(await claim('act-1')).toEqual({ kind: 'claimed' });
  });

  it('reports the existing row for an id already held, without a second insert', async () => {
    await claim('act-1');
    const second = (await claim('act-1')) as { kind: string; existing: { resultStatus: string } };
    expect(second.kind).toBe('taken');
    expect(second.existing.resultStatus).toBe('pending');
    expect((await store.listUiActions()).length).toBe(1);
  });

  it('carries the input hash into the row, so a reused id can be refused', async () => {
    await claim('act-1', 'hash-A');
    const second = (await claim('act-1', 'hash-B')) as { existing: { inputHash: string } };
    expect(second.existing.inputHash).toBe('hash-A');
  });

  it('tells two walls apart: one surface, two device ids, two rows', async () => {
    // The whole point of the column (VW-521). `surface` says `wall` for both, so without
    // a device id the trail cannot say which display the lifter was standing at.
    for (const [id, deviceId] of [
      ['act-garage', 'wall-garage'],
      ['act-spare', 'wall-spare-room'],
    ]) {
      await store.claimUiAction({
        actionId: id as string,
        actionName: 'session.checkin',
        actor: 'user',
        surface: 'wall',
        deviceId,
        inputHash: `hash-${id}`,
        createdAt: AT,
      });
    }

    const garage = await store.listUiActions({ deviceId: 'wall-garage' });
    const spare = await store.listUiActions({ deviceId: 'wall-spare-room' });

    expect(garage.map((row) => row.actionId)).toEqual(['act-garage']);
    expect(spare.map((row) => row.actionId)).toEqual(['act-spare']);
    expect((await store.listUiActions()).every((row) => row.surface === 'wall')).toBe(true);
  });

  it('accepts an action that names no display, and reads it back as none', async () => {
    await claim('act-1');

    const row = await store.getUiAction('act-1');

    expect(row?.deviceId).toBeUndefined();
    expect(await store.listUiActions({ deviceId: 'wall-garage' })).toEqual([]);
  });

  it('records the flow a row belongs to', async () => {
    await store.claimUiAction({
      actionId: 'act-flow',
      actionName: 'goal.accept_target',
      actor: 'coach',
      surface: 'telegram',
      flowId: 'sunday-1',
      flowStep: 'accept',
      inputHash: 'hash-1',
      createdAt: AT,
    });
    const rows = await store.listUiActions({ flowId: 'sunday-1' });
    expect(rows[0]).toMatchObject({ flowId: 'sunday-1', flowStep: 'accept', actor: 'coach' });
  });
});

describe('completeUiAction', () => {
  it('moves a pending row to ok and stores its result', async () => {
    await claim('act-1');
    const done = await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'ok',
      result: { logged: true },
      completedAt: DONE_AT,
    });
    expect(done).toMatchObject({ resultStatus: 'ok', completedAt: DONE_AT });
    expect(done.result).toEqual({ logged: true });
  });

  it("keeps the tool's own error code", async () => {
    await claim('act-1');
    const done = await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'error',
      resultCode: 'GOAL_TARGET_FIXED',
      result: { code: 'GOAL_TARGET_FIXED' },
      completedAt: DONE_AT,
    });
    expect(done.resultCode).toBe('GOAL_TARGET_FIXED');
  });

  it('refuses to complete a row twice', async () => {
    await claim('act-1');
    await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'ok',
      result: {},
      completedAt: DONE_AT,
    });
    await expect(
      store.completeUiAction({
        actionId: 'act-1',
        resultStatus: 'ok',
        result: {},
        completedAt: DONE_AT,
      }),
    ).rejects.toThrow(/no pending action/);
  });

  it('refuses to complete an id that was never claimed', async () => {
    await expect(
      store.completeUiAction({
        actionId: 'ghost',
        resultStatus: 'ok',
        result: {},
        completedAt: DONE_AT,
      }),
    ).rejects.toThrow(/no pending action/);
  });
});

describe('the audit triggers', () => {
  it('refuses an update that is not a completion', async () => {
    await claim('act-1');
    expect(() =>
      withRawDb((db) =>
        db.prepare(`UPDATE ui_actions SET action_name = 'other' WHERE action_id = ?`).run('act-1'),
      ),
    ).toThrow(/complete once/);
  });

  it('refuses re-opening a completed row', async () => {
    await claim('act-1');
    await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'ok',
      result: {},
      completedAt: DONE_AT,
    });
    expect(() =>
      withRawDb((db) =>
        db
          .prepare(`UPDATE ui_actions SET result_status = 'pending' WHERE action_id = ?`)
          .run('act-1'),
      ),
    ).toThrow(/complete once/);
  });

  it('refuses rewriting the result of a completed row', async () => {
    await claim('act-1');
    await store.completeUiAction({
      actionId: 'act-1',
      resultStatus: 'ok',
      result: { logged: true },
      completedAt: DONE_AT,
    });
    expect(() =>
      withRawDb((db) =>
        db
          .prepare(`UPDATE ui_actions SET result_json = '{"logged":false}' WHERE action_id = ?`)
          .run('act-1'),
      ),
    ).toThrow(/complete once/);
  });

  it('refuses changing which display submitted an action', async () => {
    await store.claimUiAction({
      actionId: 'act-1',
      actionName: 'session.checkin',
      actor: 'user',
      surface: 'wall',
      deviceId: 'wall-garage',
      inputHash: 'hash-1',
      createdAt: AT,
    });
    expect(() =>
      withRawDb((db) =>
        db
          .prepare(`UPDATE ui_actions SET device_id = 'wall-spare-room' WHERE action_id = ?`)
          .run('act-1'),
      ),
    ).toThrow(/complete once/);
  });

  it('refuses changing who submitted an action', async () => {
    await claim('act-1');
    expect(() =>
      withRawDb((db) =>
        db.prepare(`UPDATE ui_actions SET actor = 'coach' WHERE action_id = ?`).run('act-1'),
      ),
    ).toThrow(/complete once/);
  });

  it('refuses a delete', async () => {
    await claim('act-1');
    expect(() =>
      withRawDb((db) => db.prepare(`DELETE FROM ui_actions WHERE action_id = ?`).run('act-1')),
    ).toThrow(/never deleted/);
  });

  it('refuses an actor or surface outside the vocabulary', async () => {
    expect(() =>
      withRawDb((db) =>
        db
          .prepare(
            `INSERT INTO ui_actions (action_id, action_name, actor, surface, input_hash,
               result_status, created_at) VALUES ('x','n','hacker','wall','h','pending',?)`,
          )
          .run(AT),
      ),
    ).toThrow();
  });
});

describe('reading the trail', () => {
  it('lists newest first and honours the limit', async () => {
    for (const [index, id] of ['act-1', 'act-2', 'act-3'].entries()) {
      await store.claimUiAction({
        actionId: id,
        actionName: 'profile.log_bodyweight',
        actor: 'user',
        surface: 'wall',
        inputHash: `hash-${index}`,
        createdAt: `2026-09-19T12:00:0${index}.000Z`,
      });
    }
    const rows = await store.listUiActions({ limit: 2 });
    expect(rows.map((r) => r.actionId)).toEqual(['act-3', 'act-2']);
  });

  it('finds the rows a crashed run left pending, and never sweeps them', async () => {
    // The read a later surface uses to show what is unresolved. Nothing in the
    // store rewrites these: `error` would assert an outcome nobody knows.
    await claim('act-crashed');
    await claim('act-done', 'hash-2');
    await store.completeUiAction({
      actionId: 'act-done',
      resultStatus: 'ok',
      result: {},
      completedAt: DONE_AT,
    });
    await store.close();
    store = openSqliteTestStore({ path });
    const pending = await store.listUiActions({ status: 'pending' });
    expect(pending.map((r) => r.actionId)).toEqual(['act-crashed']);
  });

  it('reads one action back by its id', async () => {
    await claim('act-1');
    expect((await store.getUiAction('act-1'))?.actionName).toBe('profile.log_bodyweight');
    expect(await store.getUiAction('nope')).toBeUndefined();
  });
});
