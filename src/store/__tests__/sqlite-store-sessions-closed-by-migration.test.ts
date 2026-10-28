// `sessions.closed_by` (VW-919). The v45 step adds the column and backfills it only where an
// ended row's notes end with the idle rule's own note, the closer VW-856 wrote there. The upsert
// keeps the first closer, so a later re-put cannot null it.
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportStore } from '../portable/export.js';
import { importStore } from '../portable/import.js';
import { verifyStore } from '../portable/verify.js';
import { LEGACY_IDLE_CLOSE_NOTE, SCHEMA_VERSION } from '../sqlite-store.js';
import { openSqliteTestStore } from './open-test-store.js';

const CURRENT_VERSION = 45;
const PRIOR_VERSION = 44;
const STARTED = '2026-10-01T09:00:00.000Z';
const ENDED = '2026-10-01T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-sessions-closed-by-'));
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

function sessionColumns(file: string): string[] {
  return withRawDb(file, (db) =>
    (db.prepare('PRAGMA table_xinfo(sessions)').all() as unknown as { name: string }[]).map(
      (row) => row.name,
    ),
  );
}

function closers(file: string): Record<string, string | null> {
  return withRawDb(file, (db) =>
    Object.fromEntries(
      (
        db.prepare('SELECT id, closed_by FROM sessions ORDER BY id').all() as unknown as {
          id: string;
          closed_by: string | null;
        }[]
      ).map((row) => [row.id, row.closed_by]),
    ),
  );
}

function notes(file: string): unknown[] {
  return withRawDb(file, (db) =>
    db
      .prepare('SELECT id, notes, ended_at FROM sessions ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
  );
}

/** One row per backfill case: the note alone, as the last line, quoted mid-text, and so on. */
const SEEDED: { id: string; notes?: string; ended: boolean }[] = [
  { id: 'alone', notes: LEGACY_IDLE_CLOSE_NOTE, ended: true },
  { id: 'last-line', notes: `bench test\n${LEGACY_IDLE_CLOSE_NOTE}`, ended: true },
  { id: 'mid-text', notes: `${LEGACY_IDLE_CLOSE_NOTE}\nthen resumed`, ended: true },
  { id: 'run-on', notes: `bench test ${LEGACY_IDLE_CLOSE_NOTE}`, ended: true },
  { id: 'open', notes: LEGACY_IDLE_CLOSE_NOTE, ended: false },
  { id: 'plain', ended: true },
];

async function seededStore(file: string): Promise<void> {
  const store = openSqliteTestStore({ path: file });
  for (const row of SEEDED) {
    await store.putSession({
      id: row.id,
      startedAt: STARTED,
      ...(row.ended ? { endedAt: ENDED } : {}),
      ...(row.notes === undefined ? {} : { notes: row.notes }),
    });
  }
  await store.close();
}

/**
 * Today's sessions DDL without the v45 column and the comment above it. Rebuilt by hand rather
 * than with DROP COLUMN, which the SQLite in CI's Node 22 refuses on this table.
 */
function v44SessionsSql(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`)
    .get() as { sql: string };
  const sql = row.sql.replace(/,\s*(--[^\n]*\n\s*)*closed_by TEXT/, '');
  if (sql === row.sql) throw new Error('sessions DDL holds no closed_by column to remove');
  return sql.replace(/CREATE TABLE sessions/, 'CREATE TABLE sessions_v44');
}

/** A store as v44 left it: today's rows, no closed_by column, stamped 44. */
async function v44Store(file: string): Promise<void> {
  await seededStore(file);
  withRawDb(file, (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(v44SessionsSql(db));
    const columns = sessionColumns(file).filter((name) => name !== 'closed_by');
    db.exec(`INSERT INTO sessions_v44 SELECT ${columns.join(', ')} FROM sessions`);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions_v44 RENAME TO sessions');
    db.exec(`PRAGMA user_version = ${PRIOR_VERSION}`);
  });
}

describe('a fresh store at v45', () => {
  it('has a nullable closed_by column and writes no closer for a session put without one', async () => {
    await seededStore(path);

    expect(userVersion(path)).toBe(CURRENT_VERSION);
    expect(sessionColumns(path)).toContain('closed_by');
    expect(closers(path)).toEqual(Object.fromEntries(SEEDED.map((row) => [row.id, null])));
  });
});

describe('the v45 step, from a store created at v44', () => {
  it('starts without the column, which is what the step adds', async () => {
    await v44Store(path);

    expect(sessionColumns(path)).not.toContain('closed_by');
  });

  it("backfills the idle rule only where an ended session's notes end with its note", async () => {
    await v44Store(path);
    const before = notes(path);

    await openSqliteTestStore({ path }).close();

    expect(SCHEMA_VERSION).toBe(CURRENT_VERSION);
    expect(userVersion(path)).toBe(CURRENT_VERSION);
    expect(closers(path)).toEqual({
      alone: 'rule:idle',
      'last-line': 'rule:idle',
      'mid-text': null,
      'run-on': null,
      open: null,
      plain: null,
    });
    expect(notes(path)).toEqual(before);
  });

  it('reads the backfilled closer through getSession', async () => {
    await v44Store(path);

    const store = openSqliteTestStore({ path });
    const alone = await store.getSession('alone');
    const plain = await store.getSession('plain');
    await store.close();

    expect(alone?.closedBy).toBe('rule:idle');
    expect(plain).not.toHaveProperty('closedBy');
  });

  it('leaves a file stamped 44 with no column when it stops before its stamp', async () => {
    await v44Store(path);
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === `PRAGMA user_version = ${CURRENT_VERSION}`) throw new Error('killed');
      exec.call(this, sql);
    });

    try {
      expect(() => openSqliteTestStore({ path })).toThrow('killed');
    } finally {
      spy.mockRestore();
    }

    expect(userVersion(path)).toBe(PRIOR_VERSION);
    expect(sessionColumns(path)).not.toContain('closed_by');
  });

  it('refuses a file stamped above the current version, as a v44 binary refuses this one', async () => {
    await seededStore(path);
    withRawDb(path, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));

    expect(() => openSqliteTestStore({ path })).toThrow();
  });
});

describe('the session upsert and closed_by', () => {
  it('keeps the closer through a re-put that carries none', async () => {
    const store = openSqliteTestStore({ path });
    await store.putSession({ id: 's1', startedAt: STARTED, endedAt: ENDED, closedBy: 'rule:idle' });

    await store.putSession({ id: 's1', startedAt: STARTED, endedAt: ENDED });

    expect((await store.getSession('s1'))?.closedBy).toBe('rule:idle');
    await store.close();
  });

  it('keeps the first closer when a later close names another', async () => {
    const store = openSqliteTestStore({ path });
    await store.putSession({ id: 's1', startedAt: STARTED, endedAt: ENDED, closedBy: 'rule:idle' });

    await store.putSession({ id: 's1', startedAt: STARTED, endedAt: ENDED, closedBy: 'manual' });

    expect((await store.getSession('s1'))?.closedBy).toBe('rule:idle');
    await store.close();
  });
});

describe('portable export and import with closed_by', () => {
  it('round-trips every session and its closer', async () => {
    const store = openSqliteTestStore({ path });
    await store.putSession({ id: 's1', startedAt: STARTED, endedAt: ENDED, closedBy: 'manual' });
    await store.close();
    const outDir = join(dir, 'export');
    const restored = join(dir, 'restored.sqlite');

    exportStore(path, outDir);
    await importStore(outDir, restored);

    expect(verifyStore(path, restored)).toEqual({ equal: true, differences: [] });
    expect(closers(restored)).toEqual({ s1: 'manual' });
  });
});
