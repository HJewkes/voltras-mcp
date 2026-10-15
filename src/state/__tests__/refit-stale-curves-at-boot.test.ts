// A curve fitted under an older rule is refitted when the server starts (VW-538).

import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { bootstrapState } from '../server-state.js';
import { openSqliteTestStore } from '../../store/__tests__/open-test-store.js';

const savedEnv = { ...process.env };
let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-refit-'));
  dbPath = join(dbDir, 'store.sqlite');
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = dbPath;
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

describe('bootstrapState', () => {
  it('refits a curve stored under an older model version, which removes one with no sets', async () => {
    // Arrange: a curve from an earlier release, and no sets left to back it.
    const seed = openSqliteTestStore({ path: dbPath });
    (seed as unknown as { db: DatabaseSync }).db
      .prepare(
        `INSERT INTO rir_velocity_models
          (user_id, exercise_id, model_json, fitted_at, sample_size, fit_quality)
         VALUES (?, 'row', ?, '2026-08-01T00:00:00.000Z', 12, 0.9)`,
      )
      .run(LOCAL_USER_ID, JSON.stringify({ form: 'linear', version: 'rir-velocity@1.0.0' }));
    await seed.close();

    // Act
    const state = await bootstrapState(loadConfig());

    // Assert
    try {
      expect(await state.store.getRirVelocityModel(LOCAL_USER_ID, 'row')).toBeUndefined();
    } finally {
      await state.store.close();
    }
  });
});
