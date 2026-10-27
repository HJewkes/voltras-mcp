// A reader overlapping a writer's lock waits for it (busy_timeout) instead of
// failing with SQLITE_BUSY, while the startup write probe still rejects a live
// incumbent at once.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS } from '../busy-timeout.js';
import { digestStore, openReadOnly } from '../portable/snapshot.js';
import { openSqliteTestStore } from './open-test-store.js';

const HOLD_MS = 400;

// Holds an exclusive lock from a separate process: node:sqlite is synchronous,
// so a lock held in this process could never be released while a read waits.
const HOLDER_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${HOLD_MS});
`;

function holdExclusiveLock(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, path], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
}

describe('busy timeout', () => {
  let workdir: string;
  let dbPath: string;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-busy-'));
    dbPath = join(workdir, 'store.sqlite');
    await openSqliteTestStore({ path: dbPath }).close();
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('read-only snapshot connections carry the busy timeout', () => {
    const db = openReadOnly(dbPath);
    try {
      const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it('a snapshot read overlapping an exclusive lock waits and succeeds', async () => {
    await holdExclusiveLock(dbPath);

    const started = Date.now();
    const { schemaVersion } = digestStore(dbPath);

    expect(schemaVersion).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS / 4);
  });

  it('the open-time write probe still rejects a live incumbent immediately', () => {
    const incumbent = new DatabaseSync(dbPath);
    incumbent.exec('BEGIN EXCLUSIVE');
    try {
      const started = Date.now();
      expect(() => openSqliteTestStore({ path: dbPath })).toThrow(/already in use/);
      expect(Date.now() - started).toBeLessThan(BUSY_TIMEOUT_MS / 2);
    } finally {
      incumbent.exec('ROLLBACK');
      incumbent.close();
    }
  });

  it('an opened store connection carries the busy timeout', async () => {
    const store = openSqliteTestStore({ path: dbPath });
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const row = raw.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(BUSY_TIMEOUT_MS);
    } finally {
      await store.close();
    }
  });
});
