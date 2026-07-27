// Tests for the v6 → v7 data-layer migration: the `sets` table rebuild
// (nullability fix + the capture columns), the user dimension, the state
// tables, and the backfills.
//
// The load-bearing case in this file is `putSet` vs the new FK children.
// `sets` gained its first three children in v7 (`failure_anchors`,
// `advisory_decisions`, `self_reports`), and a set is genuinely re-put in
// production — force-end on disconnect followed by an explicit re-end. A
// delete-then-insert upsert would silently cascade those children away on
// every retry, which is the #79 regression on a new table. It is tested
// directly rather than inferred from the SQL, because the SQL is one word away
// from being wrong again.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSet } from '../types.js';

const EMPTY_PHASE = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.5 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.3 },
  } as StoredRep;
}

function makeSet(overrides: Partial<StoredSet> = {}): StoredSet {
  const setId = overrides.id ?? 'set-1';
  return {
    id: setId,
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:10.000Z',
    endedAt: '2025-01-01T00:00:40.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 135,
    reps: [makeRep(setId, 0), makeRep(setId, 1)],
    ...overrides,
  };
}

/**
 * The `sets` and `sessions` DDL exactly as v6 shipped it. Spelled out
 * literally rather than derived from the current SCHEMA_SQL so the fixture
 * cannot drift forward with the code under test.
 */
const V6_SCHEMA_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT
  );
  CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    partial INTEGER NOT NULL,
    partial_reason TEXT,
    training_mode TEXT NOT NULL,
    weight_lbs REAL NOT NULL,
    is_warmup INTEGER NOT NULL DEFAULT 0,
    slot TEXT,
    device_id TEXT,
    side TEXT
  );
  CREATE TABLE reps (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    rep_index INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE training_blocks (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    focus TEXT,
    weeks_count INTEGER NOT NULL,
    notes TEXT
  );
  CREATE TABLE training_weeks (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    name TEXT
  );
  CREATE TABLE workout_templates (
    id TEXT PRIMARY KEY,
    week_id TEXT NOT NULL,
    day_label TEXT,
    name TEXT NOT NULL,
    notes TEXT,
    order_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE planned_exercises (
    id TEXT PRIMARY KEY,
    workout_template_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    target_sets INTEGER NOT NULL,
    target_reps_low INTEGER,
    target_reps_high INTEGER,
    target_weight_lbs REAL,
    target_rpe REAL,
    rest_sec INTEGER,
    notes TEXT
  );
  CREATE TABLE program_assignments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    planned_exercise_id TEXT,
    workout_template_id TEXT,
    assigned_at TEXT NOT NULL
  );
`;

/**
 * Seed a v6 DB carrying exactly the shapes the backfills have to handle: a
 * warm-up set, a sentinel-weight set, a sentinel-mode set, a set whose parent
 * session names an exercise, and a set whose parent does not.
 */
function seedV6Database(dbPath: string): void {
  const seed = new DatabaseSync(dbPath);
  seed.exec(V6_SCHEMA_SQL);
  seed.exec(`
    INSERT INTO sessions (id, started_at, ended_at, exercise_id, exercise_name, notes) VALUES
      ('s1', '2025-06-01T10:00:00.000Z', '2025-06-01T10:45:00.000Z', 'squat', 'Back Squat', NULL),
      ('s2', '2025-06-02T10:00:00.000Z', NULL, NULL, NULL, NULL);
    INSERT INTO sets
      (id, session_id, started_at, ended_at, partial, partial_reason,
       training_mode, weight_lbs, is_warmup, slot, device_id, side) VALUES
      ('a1', 's1', '2025-06-01T10:01:00.000Z', '2025-06-01T10:02:00.000Z', 0, NULL,
       'WeightTraining', 45, 1, 'primary', 'V-1', 'left'),
      ('a2', 's1', '2025-06-01T10:05:00.000Z', '2025-06-01T10:06:00.000Z', 1, 'disconnect',
       'WeightTraining', 135, 0, 'primary', 'V-1', NULL),
      ('a3', 's1', '2025-06-01T10:09:00.000Z', '2025-06-01T10:10:00.000Z', 0, NULL,
       'Unknown', 0, 0, NULL, NULL, NULL),
      ('b1', 's2', '2025-06-02T10:01:00.000Z', '2025-06-02T10:02:00.000Z', 0, NULL,
       'Rowing', 95, 0, NULL, NULL, NULL);
    INSERT INTO reps (id, set_id, rep_index, payload) VALUES
      ('a1-r0', 'a1', 0, '{"id":"a1-r0"}'),
      ('a2-r0', 'a2', 0, '{"id":"a2-r0"}'),
      ('a3-r0', 'a3', 0, '{"id":"a3-r0"}'),
      ('b1-r0', 'b1', 0, '{"id":"b1-r0"}');
    INSERT INTO training_blocks (id, program_id, order_index, name, weeks_count)
      VALUES ('blk-1', 'prog-1', 0, 'Block 1', 4);
    INSERT INTO training_weeks (id, block_id, order_index, name)
      VALUES ('wk-1', 'blk-1', 0, 'Week 1'), ('wk-2', 'blk-1', 3, 'Week 4');
    PRAGMA user_version = 6;
  `);
  seed.close();
}

function rawDb(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe('v6 → v7 migration: identity, capture and state', () => {
  let workdir: string;
  let dbPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-store-v7-'));
    dbPath = join(workdir, 'v6-migrate.sqlite');
    seedV6Database(dbPath);
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('preserves every pre-migration row and stamps user_version = 6', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = rawDb(store);
      const count = (table: string): number =>
        (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('sessions')).toBe(2);
      expect(count('sets')).toBe(4);
      expect(count('reps')).toBe(4);
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as {
        user_version?: number;
      };
      expect(version.user_version).toBe(8);
      // The rebuild drops and recreates `sets`. `reps` has no REFERENCES
      // clause, so the drop must not have cascaded into it.
      const repIds = (raw.prepare('SELECT id FROM reps ORDER BY id').all() as { id: string }[]).map(
        (r) => r.id,
      );
      expect(repIds).toEqual(['a1-r0', 'a2-r0', 'a3-r0', 'b1-r0']);
    } finally {
      await store.close();
    }
  });

  it('leaves no foreign-key violations behind', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      expect(rawDb(store).prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('de-sentinels training_mode and weight_lbs to NULL', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      // 'Unknown' was never a real training mode and 0 was the missing-snapshot
      // weight. Both now read as absent rather than as measurements.
      const desentineled = await store.getSet('a3');
      expect(desentineled).not.toHaveProperty('trainingMode');
      expect(desentineled).not.toHaveProperty('weightLbs');
      // Genuine values are untouched.
      const real = await store.getSet('a2');
      expect(real?.trainingMode).toBe('WeightTraining');
      expect(real?.weightLbs).toBe(135);
    } finally {
      await store.close();
    }
  });

  it('backfills user_id, set_purpose, set_index_in_session, position_units and source', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = rawDb(store);
      const rows = raw
        .prepare(
          `SELECT id, user_id, set_purpose, is_warmup, set_index_in_session,
                  position_units, source, exercise_id
             FROM sets ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;

      expect(rows.map((r) => r.user_id)).toEqual(['local', 'local', 'local', 'local']);
      expect(rows.map((r) => r.source)).toEqual(['local', 'local', 'local', 'local']);
      // Every pre-v7 row is device-native by definition: no conversion has run.
      expect(rows.map((r) => r.position_units)).toEqual([
        'device_native',
        'device_native',
        'device_native',
        'device_native',
      ]);
      // The warm-up flag carries over into set_purpose, and the generated
      // is_warmup column reproduces it.
      expect(rows.map((r) => [r.id, r.set_purpose, r.is_warmup])).toEqual([
        ['a1', 'warmup', 1],
        ['a2', 'working', 0],
        ['a3', 'working', 0],
        ['b1', 'working', 0],
      ]);
      // Ordinal within the session, ordered by start time.
      expect(rows.map((r) => [r.id, r.set_index_in_session])).toEqual([
        ['a1', 1],
        ['a2', 2],
        ['a3', 3],
        ['b1', 1],
      ]);
      // exercise_id is inherited from the parent session where it had one.
      expect(rows.map((r) => [r.id, r.exercise_id])).toEqual([
        ['a1', 'squat'],
        ['a2', 'squat'],
        ['a3', 'squat'],
        ['b1', null],
      ]);
    } finally {
      await store.close();
    }
  });

  it('preserves the v5 identity triple through the rebuild', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const withIdentity = await store.getSet('a1');
      expect(withIdentity?.deviceId).toBe('V-1');
      expect(withIdentity?.side).toBe('left');
      expect(withIdentity?.slot).toBe('primary');
      // No inference: a row that never recorded identity stays unattributed.
      const without = await store.getSet('b1');
      expect(without).not.toHaveProperty('deviceId');
      expect(without).not.toHaveProperty('side');
    } finally {
      await store.close();
    }
  });

  it('seeds exactly one default user and attributes every session to it', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = rawDb(store);
      const users = raw.prepare('SELECT id, is_default FROM users').all() as Array<{
        id: string;
        is_default: number;
      }>;
      expect(users).toEqual([{ id: 'local', is_default: 1 }]);
      const unattributed = raw
        .prepare(`SELECT count(*) AS n FROM sessions WHERE user_id IS NULL`)
        .get() as { n: number };
      expect(unattributed.n).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('adds the planning columns and backfills week_index from order_index', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = rawDb(store);
      const weeks = raw
        .prepare('SELECT id, week_index, is_deload, phase_type FROM training_weeks ORDER BY id')
        .all() as Array<Record<string, unknown>>;
      expect(weeks).toEqual([
        { id: 'wk-1', week_index: 0, is_deload: 0, phase_type: null },
        { id: 'wk-2', week_index: 3, is_deload: 0, phase_type: null },
      ]);
      const plannedCols = (
        raw.prepare('PRAGMA table_xinfo(planned_exercises)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(plannedCols).toContain('target_tempo_json');
      expect(plannedCols).toContain('target_rom_m');
      expect(plannedCols).toContain('target_rir');
    } finally {
      await store.close();
    }
  });

  it('is idempotent: re-opening a migrated DB changes nothing', async () => {
    const first = SqliteSessionStore.open(dbPath);
    await first.close();
    const second = SqliteSessionStore.open(dbPath);
    try {
      const raw = rawDb(second);
      const sets = (raw.prepare('SELECT count(*) AS n FROM sets').get() as { n: number }).n;
      const reps = (raw.prepare('SELECT count(*) AS n FROM reps').get() as { n: number }).n;
      const users = (raw.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
      expect([sets, reps, users]).toEqual([4, 4, 1]);
    } finally {
      await second.close();
    }
  });
});

describe('putSet upsert vs the v7 FK children of `sets`', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: '2025-01-01T00:00:00.000Z' });
  });

  afterEach(async () => {
    await store.close();
  });

  /** Attach one row to each of the three tables that reference `sets`. */
  function attachChildren(setId: string): void {
    const raw = rawDb(store);
    raw
      .prepare(
        `INSERT INTO failure_anchors
           (id, user_id, set_id, exercise_id, observed_at, source,
            filter_inputs_json, filter_verdict, filter_version)
         VALUES (?, 'local', ?, 'squat', '2025-01-01T00:00:00.000Z', 'harvested',
                 '{}', 'failure', 'f@1.0.0')`,
      )
      .run('anchor-1', setId);
    raw
      .prepare(
        `INSERT INTO advisory_decisions
           (id, user_id, set_id, code, issued_at, inputs_json, thresholds_json,
            algorithm_version, verdict)
         VALUES (?, 'local', ?, 'stop_set', '2025-01-01T00:00:00.000Z', '{}', '{}',
                 'a@1.0.0', 'advise')`,
      )
      .run('advisory-1', setId);
    raw
      .prepare(
        `INSERT INTO self_reports (id, user_id, set_id, kind, recorded_at)
         VALUES (?, 'local', ?, 'rir', '2025-01-01T00:00:00.000Z')`,
      )
      .run('report-1', setId);
  }

  /**
   * The `set_id` each child still points at.
   *
   * Counting rows is NOT sufficient and it matters why: all three children use
   * `ON DELETE SET NULL`, not `ON DELETE CASCADE`. A delete-then-insert upsert
   * therefore does not remove them — it NULLs their `set_id`, orphaning a
   * failure anchor from the set it was harvested from while leaving the row
   * count reassuringly unchanged. The link is the thing that gets lost, so the
   * link is the thing asserted.
   */
  function childLinks(): (string | null)[] {
    const raw = rawDb(store);
    return ['failure_anchors', 'advisory_decisions', 'self_reports'].map(
      (t) => (raw.prepare(`SELECT set_id FROM ${t}`).get() as { set_id: string | null }).set_id,
    );
  }

  function childCounts(): number[] {
    const raw = rawDb(store);
    return ['failure_anchors', 'advisory_decisions', 'self_reports'].map(
      (t) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    );
  }

  it('re-putting a set does NOT wipe its failure anchors, advisories or self-reports', async () => {
    // The production shape of this: a force-end on disconnect persists the set,
    // then an explicit re-end persists it again. With `INSERT OR REPLACE` the
    // second write is a delete-then-insert and every child row above cascades
    // away silently — the #79 regression, on a table that only gained children
    // in v7. This is why the upsert must stay `ON CONFLICT DO UPDATE`.
    await store.putSet(makeSet({ id: 'set-1', weightLbs: 135 }));
    // `users` is seeded but sets carry no user yet in Wave 0; the child rows
    // reference the seeded local user directly.
    attachChildren('set-1');
    expect(childCounts()).toEqual([1, 1, 1]);
    expect(childLinks()).toEqual(['set-1', 'set-1', 'set-1']);

    await store.putSet(makeSet({ id: 'set-1', weightLbs: 145 }));

    expect(childCounts()).toEqual([1, 1, 1]);
    expect(childLinks()).toEqual(['set-1', 'set-1', 'set-1']);
    expect((await store.getSet('set-1'))?.weightLbs).toBe(145);
  });

  it('re-putting a set still replaces its rep array', async () => {
    // `reps` is deliberately delete-and-reinsert: the rep array is owned by the
    // set and a retry must not leave stale reps behind. Asserted alongside the
    // case above so the two behaviours cannot be conflated.
    await store.putSet(makeSet({ id: 'set-2' }));
    const replaced = makeSet({ id: 'set-2' });
    replaced.reps = [makeRep('set-2', 0)];
    await store.putSet(replaced);
    expect((await store.getSet('set-2'))?.reps).toHaveLength(1);
  });
});

describe('v7 nullability and set_purpose round-trip', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: '2025-01-01T00:00:00.000Z' });
  });

  afterEach(async () => {
    await store.close();
  });

  it('round-trips a set with no weight and no training mode as absent, not 0/Unknown', async () => {
    const gapped = makeSet({ id: 'gap-1' });
    delete gapped.weightLbs;
    delete gapped.trainingMode;
    await store.putSet(gapped);

    const read = await store.getSet('gap-1');
    expect(read).not.toHaveProperty('weightLbs');
    expect(read).not.toHaveProperty('trainingMode');
    // And specifically NOT the old sentinels, which would read as measurements.
    expect(read?.weightLbs).not.toBe(0);
    expect(read?.trainingMode).not.toBe('Unknown');
  });

  it('keeps a genuine zero weight distinguishable from a gap on new writes', async () => {
    // The migration's NULLIF collapses historical 0s, and that loss is
    // documented. Going forward the two are distinct, which is the point.
    await store.putSet(makeSet({ id: 'zero-1', weightLbs: 0 }));
    expect((await store.getSet('zero-1'))?.weightLbs).toBe(0);
  });

  it('derives is_warmup from set_purpose so the two cannot drift', async () => {
    await store.putSet(makeSet({ id: 'warm-1', isWarmup: true }));
    await store.putSet(makeSet({ id: 'work-1' }));
    const raw = rawDb(store);
    const rows = raw
      .prepare('SELECT id, set_purpose, is_warmup FROM sets ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: 'warm-1', set_purpose: 'warmup', is_warmup: 1 },
      { id: 'work-1', set_purpose: 'working', is_warmup: 0 },
    ]);
    expect((await store.getSet('warm-1'))?.isWarmup).toBe(true);
    expect(await store.getSet('work-1')).not.toHaveProperty('isWarmup');
  });

  it('refuses a set_purpose outside the four legal values', () => {
    const raw = rawDb(store);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO sets (id, session_id, started_at, ended_at, partial, set_purpose)
           VALUES ('bad-1', 'sess-1', 'a', 'b', 0, 'wibble')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('v7 → v8: firmware duration column rename', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  it('exposes the provenance-named column and not the old per-rep name', () => {
    // v7 named this from the SDK's "duration of the final rep" label, which the
    // captures refute — the value scales with rep count, so it is a set-level
    // aggregate. Renamed while still empty, which is why it cost nothing.
    const names = columnNames(rawDb(store), 'sets');
    expect(names).toContain('firmware_summary_duration_ms');
    expect(names).not.toContain('firmware_rep_duration_ms');
  });

  it('round-trips the summary duration', async () => {
    await store.putSession({ id: 'sess-1', startedAt: '2025-01-01T00:00:00.000Z' });
    await store.putSet(makeSet({ id: 'dur-1', firmwareSummaryDurationMs: 11_240 }));
    expect((await store.getSet('dur-1'))?.firmwareSummaryDurationMs).toBe(11_240);
  });

  it('renames the column on a real v7 DB, through open(), without touching rows', () => {
    // Exercised through SqliteSessionStore.open so the PRODUCTION migrateV7ToV8
    // runs — a test that reimplements the migration would pass even if the real
    // one were deleted.
    const dir = mkdtempSync(join(tmpdir(), 'vmcp-v8-'));
    const path = join(dir, 'v7.sqlite');
    try {
      const seed = new DatabaseSync(path);
      seed.exec(V6_SCHEMA_SQL);
      seed.exec(`INSERT INTO sessions (id, started_at) VALUES ('s1', '2025-06-01T10:00:00.000Z')`);
      seed.exec(`INSERT INTO sets
        (id, session_id, started_at, ended_at, partial, training_mode, weight_lbs, is_warmup)
        VALUES ('pre-v8', 's1', 'a', 'b', 0, 'WeightTraining', 100, 0)`);
      seed.exec('PRAGMA user_version = 6');
      seed.close();

      const opened = SqliteSessionStore.open(path);
      try {
        const raw = rawDb(opened);
        const names = columnNames(raw, 'sets');
        expect(names).toContain('firmware_summary_duration_ms');
        expect(names).not.toContain('firmware_rep_duration_ms');
        const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as {
          user_version?: number;
        };
        expect(version.user_version).toBe(8);
        // The row survived the v6→v7 rebuild AND the v7→v8 rename.
        const rows = raw.prepare(`SELECT id FROM sets`).all() as { id: string }[];
        expect(rows.map((r) => r.id)).toEqual(['pre-v8']);
      } finally {
        void opened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-opening a migrated DB is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vmcp-v8-idem-'));
    const path = join(dir, 'again.sqlite');
    try {
      const first = SqliteSessionStore.open(path);
      void first.close();
      const second = SqliteSessionStore.open(path);
      try {
        expect(columnNames(rawDb(second), 'sets')).toContain('firmware_summary_duration_ms');
      } finally {
        void second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Column names including generated ones (`table_info` omits those). */
function columnNames(db: DatabaseSync, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}
