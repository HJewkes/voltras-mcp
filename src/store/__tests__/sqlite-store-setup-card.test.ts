// Round-trip and migration tests for the declared setup card (VW-275) —
// `exercise_setups.setup_anchor` / `.mount_hole` / `.cable_length_setting_json`
// / `.mode`, added in the v18 -> v19 migration.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredExerciseSetup } from '../types.js';

function open(): SqliteSessionStore {
  return SqliteSessionStore.open(':memory:');
}

function detectedSetup(overrides: Partial<StoredExerciseSetup> = {}): StoredExerciseSetup {
  return {
    id: 'setup@1.0.0:local/bench-press/both#0',
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    label: 'setup 1',
    detectedAt: '2026-09-01T00:00:00.000Z',
    clusterVersion: 'setup@1.0.0',
    ...overrides,
  };
}

describe('exercise_setups — setup card round-trip', () => {
  it('round-trips a full card, including a numeric cable-length setting', async () => {
    const store = open();
    const setup = detectedSetup({
      confirmedAt: '2026-09-02T00:00:00.000Z',
      card: { anchor: 'mid', mountHole: 3, cableLengthSetting: 36, mode: 'Normal' },
    });

    await store.putExerciseSetup(setup);
    const read = await store.getExerciseSetup(setup.id);

    expect(read?.card).toEqual({
      anchor: 'mid',
      mountHole: 3,
      cableLengthSetting: 36,
      mode: 'Normal',
    });
    // Numeric in, numeric out — the JSON round trip must not stringify it.
    expect(typeof read?.card?.cableLengthSetting).toBe('number');
  });

  it('round-trips a string cable-length setting distinctly from a number', async () => {
    const store = open();
    const setup = detectedSetup({ card: { anchor: 'low', cableLengthSetting: '36 in' } });

    await store.putExerciseSetup(setup);
    const read = await store.getExerciseSetup(setup.id);

    expect(read?.card?.cableLengthSetting).toBe('36 in');
    expect(typeof read?.card?.cableLengthSetting).toBe('string');
  });

  it('omits card entirely for a setup nobody has confirmed', async () => {
    const store = open();
    await store.putExerciseSetup(detectedSetup());

    const read = await store.getExerciseSetup(detectedSetup().id);

    expect(read?.card).toBeUndefined();
  });

  it('lists a card through listExerciseSetups the same as a single get', async () => {
    const store = open();
    await store.putExerciseSetup(detectedSetup({ card: { anchor: 'high' } }));

    const [listed] = await store.listExerciseSetups({
      userId: LOCAL_USER_ID,
      exerciseId: 'bench-press',
    });

    expect(listed.card).toEqual({ anchor: 'high' });
  });

  it('clears a partial card back to anchor-only on re-confirm', async () => {
    const store = open();
    await store.putExerciseSetup(detectedSetup({ card: { anchor: 'mid', mountHole: 3 } }));
    await store.putExerciseSetup(detectedSetup({ card: { anchor: 'mid' } }));

    const read = await store.getExerciseSetup(detectedSetup().id);

    expect(read?.card).toEqual({ anchor: 'mid' });
  });
});

describe('v18 -> v19 migration', () => {
  let workdir: string;
  let dbPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-store-v19-'));
    dbPath = join(workdir, 'v18-migrate.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        created_at TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (id, display_name, created_at, is_default)
        VALUES ('${LOCAL_USER_ID}', 'Local', '2026-01-01T00:00:00.000Z', 1);
      CREATE TABLE exercise_setups (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        exercise_id TEXT NOT NULL,
        label TEXT,
        detected_at TEXT NOT NULL,
        confirmed_at TEXT,
        cluster_version TEXT,
        retired_at TEXT
      );
      INSERT INTO exercise_setups (id, user_id, exercise_id, label, detected_at)
        VALUES ('pre-v19', '${LOCAL_USER_ID}', 'bench-press', 'setup 1', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 18;
    `);
    seed.close();
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('adds the setup-card columns and stamps user_version 19, leaving the pre-existing row cardless', async () => {
    const store = SqliteSessionStore.open(dbPath);

    const preExisting = await store.getExerciseSetup('pre-v19');
    expect(preExisting?.card).toBeUndefined();

    const raw = new DatabaseSync(dbPath);
    const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(34);
    raw.close();
  });

  it('can write a card to the migrated table', async () => {
    const store = SqliteSessionStore.open(dbPath);
    await store.putExerciseSetup({
      id: 'pre-v19',
      userId: LOCAL_USER_ID,
      exerciseId: 'bench-press',
      label: 'setup 1',
      detectedAt: '2026-01-01T00:00:00.000Z',
      card: { anchor: 'low', mode: 'Sports' },
    });

    const read = await store.getExerciseSetup('pre-v19');
    expect(read?.card).toEqual({ anchor: 'low', mode: 'Sports' });
  });
});
