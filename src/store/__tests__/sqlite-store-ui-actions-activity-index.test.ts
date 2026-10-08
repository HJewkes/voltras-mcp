// The activity feed's keyset order has an index (VW-910). `listActivity` sorts on
// `created_at DESC, action_id DESC` and pages from a cursor over that pair; the v44 step adds
// the index that serves both, so the page needs no temp B-tree and a deep cursor is a seek.
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportStore } from '../portable/export.js';
import { importStore } from '../portable/import.js';
import { verifyStore } from '../portable/verify.js';
import { SCHEMA_VERSION } from '../sqlite-store.js';
import { openSqliteTestStore } from './open-test-store.js';

const PRIOR_VERSION = 43;
const INDEX = 'idx_ui_actions_activity';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-ui-actions-activity-'));
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

function userVersion(file: string): number {
  return withRawDb(file, (db) => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  });
}

function indexNames(file: string): string[] {
  return withRawDb(file, (db) =>
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ui_actions'`)
        .all() as unknown as { name: string }[]
    ).map((row) => row.name),
  );
}

function triggerNames(file: string): string[] {
  return withRawDb(file, (db) =>
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ui_actions'`,
        )
        .all() as unknown as { name: string }[]
    )
      .map((row) => row.name)
      .sort(),
  );
}

function rows(file: string): unknown[] {
  return withRawDb(file, (db) =>
    db
      .prepare('SELECT rowid AS rid, * FROM ui_actions ORDER BY rowid')
      .all()
      .map((row) => ({ ...row })),
  );
}

/** Ten rows over four instants, so the action id breaks ties. */
async function seededStore(file: string): Promise<void> {
  const store = openSqliteTestStore({ path: file });
  for (let i = 0; i < 10; i += 1) {
    await store.claimUiAction({
      actionId: `act-${String(i).padStart(2, '0')}`,
      actionName: 'profile.log_bodyweight',
      actor: 'user',
      surface: 'wall',
      inputHash: `h-${i}`,
      createdAt: `2026-10-0${1 + Math.floor(i / 3)}T09:00:00.000Z`,
    });
  }
  await store.close();
}

/** A store as v43 left it: today's rows and triggers, no activity index, stamped 43. */
async function v43Store(file: string): Promise<void> {
  await seededStore(file);
  withRawDb(file, (db) => {
    db.exec(`DROP INDEX ${INDEX}`);
    db.exec(`PRAGMA user_version = ${PRIOR_VERSION}`);
  });
}

/** The SQL `listActivity` runs, captured by spying on `prepare` while it pages. */
async function activitySql(withCursor: boolean): Promise<string> {
  const seen: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    seen.push(sql);
    return prepare.call(this, sql);
  });
  const store = openSqliteTestStore({ path });
  try {
    seen.length = 0;
    await store.listActivity({
      limit: 3,
      ...(withCursor
        ? { after: { createdAt: '2026-10-02T09:00:00.000Z', actionId: 'act-04' } }
        : {}),
    });
  } finally {
    spy.mockRestore();
    await store.close();
  }
  const sql = seen.find((text) => text.includes('FROM ui_actions'));
  if (sql === undefined) throw new Error('listActivity prepared no ui_actions query');
  return sql;
}

function planOf(file: string, sql: string, bindings: (string | number)[]): string {
  return withRawDb(file, (db) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...bindings)
      .map((row) => String(row.detail))
      .join(' | '),
  );
}

describe('the activity page plan', () => {
  it('uses the index and no temp B-tree for the first page', async () => {
    await seededStore(path);
    const sql = await activitySql(false);

    const plan = planOf(path, sql, [3]);

    expect(plan).toContain(INDEX);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('seeks into the index for a cursor page and uses no temp B-tree', async () => {
    await seededStore(path);
    const sql = await activitySql(true);

    const plan = planOf(path, sql, ['2026-10-02T09:00:00.000Z', 'act-04', 3]);

    expect(plan).toContain(`SEARCH ui_actions USING INDEX ${INDEX}`);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('pages ties on the instant by action id, newest first, with no row twice or missed', async () => {
    await seededStore(path);
    const store = openSqliteTestStore({ path });
    const seen: string[] = [];
    let after: { createdAt: string; actionId: string } | undefined;

    for (;;) {
      const page = await store.listActivity({ limit: 4, ...(after ? { after } : {}) });
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.actionId));
      const last = page[page.length - 1]!;
      after = { createdAt: last.createdAt, actionId: last.actionId };
    }
    await store.close();

    expect(seen).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => `act-0${i}`));
  });
});

describe('the v44 step, from a store created at v43', () => {
  it('starts without the index, which is what the step adds', async () => {
    await v43Store(path);

    expect(indexNames(path)).not.toContain(INDEX);
  });

  it('opens at the current version with the index and every row byte-identical', async () => {
    await v43Store(path);
    const before = rows(path);

    await openSqliteTestStore({ path }).close();

    expect(SCHEMA_VERSION).toBe(44);
    expect(userVersion(path)).toBe(44);
    expect(indexNames(path)).toContain(INDEX);
    expect(rows(path)).toEqual(before);
  });

  it('keeps the audit trail triggers, including no-replace and the rowid pin', async () => {
    await seededStore(path);
    const current = triggerNames(path);
    await v43Store(path);

    await openSqliteTestStore({ path }).close();

    expect(triggerNames(path)).toEqual(current);
    expect(current).toEqual(
      expect.arrayContaining(['ui_actions_no_replace', 'ui_actions_positive_rowid']),
    );
  });

  it('leaves a file stamped 43 with no index when it stops before its stamp', async () => {
    await v43Store(path);
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === 'PRAGMA user_version = 44') throw new Error('killed');
      exec.call(this, sql);
    });

    try {
      expect(() => openSqliteTestStore({ path })).toThrow('killed');
    } finally {
      spy.mockRestore();
    }

    expect(userVersion(path)).toBe(PRIOR_VERSION);
    expect(indexNames(path)).not.toContain(INDEX);
  });

  it('refuses a file stamped above the current version, as a v43 binary refuses this one', async () => {
    await seededStore(path);
    withRawDb(path, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));

    expect(() => openSqliteTestStore({ path })).toThrow();
  });
});

describe('portable export and import with the activity index', () => {
  it('round-trips every row and the restored store carries the index', async () => {
    await seededStore(path);
    const outDir = join(dir, 'export');
    const restored = join(dir, 'restored.sqlite');

    exportStore(path, outDir);
    await importStore(outDir, restored);

    expect(verifyStore(path, restored)).toEqual({ equal: true, differences: [] });
    expect(indexNames(restored)).toContain(INDEX);
  });
});
