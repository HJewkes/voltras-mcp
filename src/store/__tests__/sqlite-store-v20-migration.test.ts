// Tests for the v19 -> v20 migration: the `accountability_state` table
// (VW-286), exercised against a genuinely v19-shaped database rather than a
// fresh current-shape DB with its `user_version` stamp turned back — VW-288
// found that stamping a current DB backwards proves nothing, because the table
// under test is already there.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';

/**
 * `users`, `exercise_setups` (carrying the four setup-card columns v19 added)
 * and one planning table, exactly as v19 shipped them, and NO
 * `accountability_state`. Spelled out literally rather than derived from the
 * current `SCHEMA_SQL` so the fixture cannot drift forward with the code under
 * test.
 */
const V19_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE exercise_setups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    label TEXT,
    detected_at TEXT NOT NULL,
    confirmed_at TEXT,
    cluster_version TEXT,
    retired_at TEXT,
    setup_anchor TEXT CHECK (setup_anchor IN ('low','mid','chest','high')),
    mount_hole INTEGER,
    cable_length_setting_json TEXT,
    mode TEXT
  );
  CREATE TABLE training_programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
`;

let dir: string;
let path: string;

function seedV19Database(): void {
  const db = new DatabaseSync(path);
  db.exec(V19_SCHEMA_SQL);
  db.exec(`
    INSERT INTO users (id, created_at) VALUES ('local', '2026-09-01T00:00:00.000Z');
    INSERT INTO exercise_setups (id, user_id, exercise_id, detected_at, setup_anchor, mount_hole)
      VALUES ('setup-1', 'local', 'seated-row', '2026-09-01T00:00:00.000Z', 'chest', 4);
    INSERT INTO training_programs (id, name, created_at)
      VALUES ('prog-1', 'Base Strength', '2026-09-01T00:00:00.000Z');
  `);
  db.exec('PRAGMA user_version = 19');
  db.close();
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v20-'));
  path = join(dir, 'v19.sqlite');
  seedV19Database();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v19 -> v20 migration', () => {
  it('creates accountability_state on a genuinely v19-shaped database', async () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        expect(columns(db, 'accountability_state')).toEqual(
          new Set([
            'user_id',
            'state',
            'entered_at',
            'consecutive_misses',
            'ghost_sends_json',
            'last_inbound_at',
            'last_proactive_sends_json',
            'holding_until',
          ]),
        );
      } finally {
        db.close();
      }

      // Nothing is back-filled: a pre-v20 user has never been through the
      // protocol, which is not the same as having come out `planned`.
      expect(await store.getAccountabilityState('local')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('stamps user_version at SCHEMA_VERSION and keeps the pre-existing rows', () => {
    const store = SqliteSessionStore.open(path);
    try {
      const db = new DatabaseSync(path);
      try {
        const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(version.user_version).toBe(31);
        const program = db.prepare('SELECT name FROM training_programs').get() as { name: string };
        expect(program.name).toBe('Base Strength');
        const setup = db.prepare('SELECT setup_anchor, mount_hole FROM exercise_setups').get() as {
          setup_anchor: string;
          mount_hole: number;
        };
        expect(setup).toEqual({ setup_anchor: 'chest', mount_hole: 4 });
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });
});
