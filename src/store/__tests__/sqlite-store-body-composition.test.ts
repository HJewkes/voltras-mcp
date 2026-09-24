// Tests for the v28 leanness columns on `body_metrics` (VW-364) against a
// FRESH database — the migration path has its own file. What is pinned here:
//
//   * every new column round-trips, alone and together
//   * a fresh DB's CHECK lists are exactly `LEANNESS_BANDS` and
//     `BODY_FAT_SOURCES`, so the SQL transcription cannot drift from the const
//   * both CHECKs reject a value outside their enum
//   * a re-log at the same instant REPLACES the optional fields

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BODY_FAT_SOURCES } from '../../analytics/body-fat-sources.js';
import { LEANNESS_BANDS } from '../leanness-band.js';
import type { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';
import { openSqliteTestStore } from './open-test-store.js';

let dir: string;
let path: string;
let store: SqliteSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-bodycomp-'));
  path = join(dir, 'db.sqlite');
  store = openSqliteTestStore({ path });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The `body_metrics` DDL as SQLite itself stored it. */
function tableSql(): string {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'body_metrics'`)
      .get() as unknown as { sql: string };
    return row.sql;
  } finally {
    db.close();
  }
}

/** The quoted values inside the named column's `IN (...)` list, in order. */
function checkValues(sql: string, column: string): string[] {
  const clause = new RegExp(`${column} IN \\(([^)]*)\\)`).exec(sql);
  if (clause === null) throw new Error(`no CHECK list for ${column}`);
  return [...(clause[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

describe('body_metrics leanness columns (VW-364)', () => {
  it('round-trips every new column together', async () => {
    const entry = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-13T09:00:00.000Z',
      bodyweightLbs: 330.5,
      note: 'weekly weigh-in',
      leannessBand: 'moderate',
      waistIn: 47.25,
      bodyFatPct: 29.8,
      bodyFatSource: 'dexa',
      measurementProtocol: 'two-scan, head then trunk and limbs; fasted',
    });
    expect(entry).toEqual({
      id: expect.any(String) as unknown as string,
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-13T09:00:00.000Z',
      bodyweightLbs: 330.5,
      note: 'weekly weigh-in',
      leannessBand: 'moderate',
      waistIn: 47.25,
      bodyFatPct: 29.8,
      bodyFatSource: 'dexa',
      measurementProtocol: 'two-scan, head then trunk and limbs; fasted',
    });
    expect(await store.listBodyMetrics(LOCAL_USER_ID)).toEqual([entry]);
  });

  it('round-trips each new column on its own, leaving the others absent', async () => {
    const band = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-13T09:00:00.000Z',
      bodyweightLbs: 330,
      leannessBand: 'very-lean',
    });
    expect(band.leannessBand).toBe('very-lean');
    expect(band.waistIn).toBeUndefined();
    expect(band.bodyFatPct).toBeUndefined();
    expect(band.bodyFatSource).toBeUndefined();
    expect(band.measurementProtocol).toBeUndefined();

    const waist = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-14T09:00:00.000Z',
      bodyweightLbs: 329,
      waistIn: 46,
    });
    expect(waist.waistIn).toBe(46);
    expect(waist.leannessBand).toBeUndefined();

    const protocol = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-15T09:00:00.000Z',
      bodyweightLbs: 328,
      measurementProtocol: 'stitched combined-ROI scan',
    });
    expect(protocol.measurementProtocol).toBe('stitched combined-ROI scan');
    expect(protocol.bodyFatPct).toBeUndefined();
  });

  it('keeps the fresh-DB CHECK lists identical to the code consts', () => {
    const sql = tableSql();
    expect(checkValues(sql, 'leanness_band')).toEqual([...LEANNESS_BANDS]);
    expect(checkValues(sql, 'body_fat_source')).toEqual([...BODY_FAT_SOURCES]);
  });

  it('rejects a leanness band outside the four', () => {
    const db = new DatabaseSync(path);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs, leanness_band)
             VALUES ('bm-bad', ?, '2026-09-13T09:00:00.000Z', 330, 'skinny')`,
          )
          .run(LOCAL_USER_ID),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rejects a body-fat source outside the tabulated set', () => {
    const db = new DatabaseSync(path);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO body_metrics
               (id, user_id, recorded_at, bodyweight_lbs, body_fat_pct, body_fat_source)
             VALUES ('bm-bad', ?, '2026-09-13T09:00:00.000Z', 330, 30, 'mirror')`,
          )
          .run(LOCAL_USER_ID),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('replaces the optional fields on a re-log at the same instant', async () => {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-13T09:00:00.000Z',
      bodyweightLbs: 330,
      leannessBand: 'high',
      waistIn: 48,
    });
    const corrected = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-09-13T09:00:00.000Z',
      bodyweightLbs: 331,
      leannessBand: 'moderate',
    });
    expect(corrected.bodyweightLbs).toBe(331);
    expect(corrected.leannessBand).toBe('moderate');
    expect(corrected.waistIn).toBeUndefined();
    expect(await store.listBodyMetrics(LOCAL_USER_ID)).toHaveLength(1);
  });

  it('reads back a band or source this build does not recognise as absent', async () => {
    // A value a NEWER schema allowed and this one does not. The CHECK is
    // suppressed to plant it, which is what a downgrade looks like from here.
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA ignore_check_constraints = ON');
      db.prepare(
        `INSERT INTO body_metrics
           (id, user_id, recorded_at, bodyweight_lbs, leanness_band, body_fat_pct, body_fat_source)
         VALUES ('bm-future', ?, '2026-09-13T09:00:00.000Z', 330, 'stage-lean', 30, 'four_c')`,
      ).run(LOCAL_USER_ID);
    } finally {
      db.close();
    }
    const [row] = await store.listBodyMetrics(LOCAL_USER_ID);
    expect(row?.leannessBand).toBeUndefined();
    expect(row?.bodyFatSource).toBeUndefined();
    expect(row?.bodyFatPct).toBe(30);
  });
});
