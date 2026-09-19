// Tests for the v33 -> v34 migration: `training_profile.last_break_months`, exercised against a
// genuinely v33-shaped `training_profile` (VW-288). Additive and back-fills nothing: a profile
// answered before v34 reads as never asked, so the tier signal's returner path stays shut.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

/** `users` and `training_profile` as they stood at v33, with NO `last_break_months`. */
const V33_SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE training_profile (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    declared_tier TEXT,
    declared_at TEXT,
    years_training REAL,
    history_consistent INTEGER,
    ever_plateaued INTEGER,
    reported_sets_per_muscle REAL,
    goal TEXT,
    goal_set_at TEXT,
    days_available INTEGER,
    days_reliable INTEGER,
    onboarded_at TEXT,
    current_baseline TEXT,
    effort_tolerance TEXT,
    target TEXT,
    injuries_json TEXT,
    named_program_history TEXT,
    provenance_json TEXT,
    updated_at TEXT NOT NULL
  );
`;

const AT = '2026-09-19T00:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v34-'));
  path = join(dir, 'store.sqlite');
  const db = new DatabaseSync(path);
  db.exec(V33_SCHEMA_SQL);
  db.exec(`INSERT INTO users (id, created_at, is_default) VALUES ('${LOCAL_USER_ID}', '${AT}', 1)`);
  db.exec(
    `INSERT INTO training_profile (user_id, declared_tier, years_training, ever_plateaued, updated_at)
     VALUES ('${LOCAL_USER_ID}', 'intermediate', 3, 1, '${AT}')`,
  );
  db.exec('PRAGMA user_version = 33');
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v33 -> v34 migration', () => {
  it('adds last_break_months, leaves it unanswered, and keeps the rest of the profile', async () => {
    const store = SqliteSessionStore.open(path);

    const profile = await store.getTrainingProfile(LOCAL_USER_ID);

    expect(profile).toMatchObject({ declaredTier: 'intermediate', yearsTraining: 3 });
    expect(profile?.lastBreakMonths).toBeUndefined();
    await store.close();
  });

  it('stamps v34, is idempotent on re-open, and round-trips an answer', async () => {
    const first = SqliteSessionStore.open(path);
    const profile = await first.getTrainingProfile(LOCAL_USER_ID);
    await first.putTrainingProfile({ ...profile!, lastBreakMonths: 4 });
    await first.close();

    const second = SqliteSessionStore.open(path);
    const reread = await second.getTrainingProfile(LOCAL_USER_ID);
    await second.close();
    const db = new DatabaseSync(path);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();

    expect(reread?.lastBreakMonths).toBe(4);
    expect(version.user_version).toBe(35);
  });
});
