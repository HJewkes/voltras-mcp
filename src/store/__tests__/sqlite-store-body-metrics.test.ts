// Tests for the `body_metrics` writer and reader (VW-327).
//
// `body_metrics` has existed as inert DDL since v6 (schema-only, no writer —
// see `sqlite-store.ts`). This is its first write call site, plus the v26
// unique index that gives it a natural key to upsert on.
//
// Coverage shape:
//   * Round-trips a reading through putBodyMetric / listBodyMetrics.
//   * A second putBodyMetric at the same measuredAt UPDATES the row rather
//     than duplicating it, and keeps the original id.
//   * listBodyMetrics returns newest-first.
//   * sinceDays filters the returned series.
//   * SCHEMA_VERSION lands at 28 on a fresh DB.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';

function open(): SqliteSessionStore {
  return SqliteSessionStore.open(':memory:');
}

describe('putBodyMetric / listBodyMetrics', () => {
  it('round-trips a reading', async () => {
    const store = open();
    const entry = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-01T00:00:00.000Z',
      bodyweightLbs: 180.5,
      note: 'after breakfast',
    });

    expect(entry.bodyweightLbs).toBe(180.5);
    expect(entry.note).toBe('after breakfast');
    expect(entry.measuredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.userId).toBe(LOCAL_USER_ID);
    expect(typeof entry.id).toBe('string');

    const series = await store.listBodyMetrics(LOCAL_USER_ID);
    expect(series).toEqual([entry]);
  });

  it('upserts on measuredAt: a second call updates rather than duplicates', async () => {
    const store = open();
    const first = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-01T00:00:00.000Z',
      bodyweightLbs: 180,
    });
    const second = await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-01T00:00:00.000Z',
      bodyweightLbs: 181,
      note: 'corrected — read the scale wrong',
    });

    // Same natural key, same row: the id carries across the correction.
    expect(second.id).toBe(first.id);
    expect(second.bodyweightLbs).toBe(181);
    expect(second.note).toBe('corrected — read the scale wrong');

    const series = await store.listBodyMetrics(LOCAL_USER_ID);
    expect(series).toHaveLength(1);
    expect(series[0]?.bodyweightLbs).toBe(181);
  });

  it('returns the series newest-first', async () => {
    const store = open();
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-01T00:00:00.000Z',
      bodyweightLbs: 180,
    });
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-03T00:00:00.000Z',
      bodyweightLbs: 179,
    });
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-02T00:00:00.000Z',
      bodyweightLbs: 179.5,
    });

    const series = await store.listBodyMetrics(LOCAL_USER_ID);
    expect(series.map((m) => m.measuredAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('filters the series by sinceDays', async () => {
    const store = open();
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: tenDaysAgo,
      bodyweightLbs: 182,
    });
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: twoDaysAgo,
      bodyweightLbs: 180,
    });

    const recent = await store.listBodyMetrics(LOCAL_USER_ID, { sinceDays: 7 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.measuredAt).toBe(twoDaysAgo);

    const everything = await store.listBodyMetrics(LOCAL_USER_ID);
    expect(everything).toHaveLength(2);
  });

  it('returns an empty series when nothing has been logged', async () => {
    const store = open();
    expect(await store.listBodyMetrics(LOCAL_USER_ID)).toEqual([]);
  });
});

describe('migrateV25ToV26', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vmcp-body-metrics-'));
    path = join(dir, 'vmcp.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lands a fresh DB at SCHEMA_VERSION 29 and enforces the natural key', async () => {
    const store = SqliteSessionStore.open(path);
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-01-01T00:00:00.000Z',
      bodyweightLbs: 180,
    });
    store.close();

    const db = new DatabaseSync(path);
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(row.user_version).toBe(40);
      expect(() =>
        db
          .prepare(
            `INSERT INTO body_metrics (id, user_id, recorded_at, bodyweight_lbs)
             VALUES ('dup', ?, '2026-01-01T00:00:00.000Z', 999)`,
          )
          .run(LOCAL_USER_ID),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });
});
