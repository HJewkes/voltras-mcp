// Regression test for VW-288: `checkSchemaVersion` used to refuse a v17
// database — a hand-maintained `found !== N` chain omitted 17 — even though
// `migrateV17ToV18` exists and is idempotent. The fix replaces the chain
// with a range check, so every version from 0 through SCHEMA_VERSION must
// open, and anything above SCHEMA_VERSION must still be refused.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-schema-range-'));
  path = join(dir, 'db.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function currentSchemaVersion(): number {
  const store = SqliteSessionStore.open(path);
  store.close();
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

describe('checkSchemaVersion range check', () => {
  it('migrates a real v17 database forward instead of refusing it', () => {
    const schemaVersion = currentSchemaVersion();

    // Downgrade a freshly-created (fully-shaped) database's stamp to 17. The
    // migration bodies are additive and gated by user_version, so re-running
    // migrateV17ToV18 against a table that already has every v18 column is a
    // documented no-op — this fixture is equivalent to a real v17 database.
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 17');
    db.close();

    let reopened: SqliteSessionStore | undefined;
    expect(() => {
      reopened = SqliteSessionStore.open(path);
    }).not.toThrow();

    const versionDb = new DatabaseSync(path);
    try {
      const row = versionDb.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(row.user_version).toBe(schemaVersion);
    } finally {
      versionDb.close();
      reopened?.close();
    }
  });

  it('still refuses a version above SCHEMA_VERSION', () => {
    const schemaVersion = currentSchemaVersion();

    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${schemaVersion + 1}`);
    db.close();

    try {
      SqliteSessionStore.open(path);
      expect.fail('expected SqliteSessionStore.open to throw for a future schema version');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('SCHEMA_INCOMPATIBLE');
    }
  });
});
