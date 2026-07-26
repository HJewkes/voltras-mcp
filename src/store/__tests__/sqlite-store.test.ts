// Tests for SqliteSessionStore — Wave 2A (Task 07).
//
// Covers R8 (DB lock detection), R17 (schema versioning + cleanup),
// R18-R19 (set + session persistence), AC-19 (default sort), and the
// `getSet(id)` lookup added per critic FIX #2. Most cases use a `:memory:`
// DB; the schema-mismatch and lock-detection cases use real temp files
// from `os.tmpdir()` and clean themselves up.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';
import { SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSession, StoredSet } from '../types.js';

const EMPTY_PHASE: Phase = {
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
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.5 + index * 0.01 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.3 + index * 0.01 },
  };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    exerciseId: 'squat',
    exerciseName: 'Back Squat',
    ...overrides,
  };
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
    reps: [makeRep(setId, 0), makeRep(setId, 1), makeRep(setId, 2)],
    ...overrides,
  };
}

describe('SqliteSessionStore', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  describe('CRUD: sessions', () => {
    it('round-trips a session through putSession/getSession', async () => {
      const session = makeSession({ notes: 'felt strong' });
      await store.putSession(session);

      const fetched = await store.getSession(session.id);
      expect(fetched).toEqual(session);
    });

    it('returns undefined when session id does not exist', async () => {
      expect(await store.getSession('nope')).toBeUndefined();
    });

    it('upserts on duplicate id (R18 putSession contract)', async () => {
      const initial = makeSession();
      await store.putSession(initial);
      const ended: StoredSession = { ...initial, endedAt: '2025-01-01T01:00:00.000Z' };
      await expect(store.putSession(ended)).resolves.toBeUndefined();
      const fetched = await store.getSession(initial.id);
      expect(fetched?.endedAt).toBe('2025-01-01T01:00:00.000Z');
    });

    it('preserves omitted optional fields as undefined', async () => {
      const session: StoredSession = {
        id: 'sess-min',
        startedAt: '2025-01-01T00:00:00.000Z',
      };
      await store.putSession(session);
      const fetched = await store.getSession('sess-min');
      expect(fetched).toEqual(session);
      expect(fetched?.endedAt).toBeUndefined();
      expect(fetched?.exerciseId).toBeUndefined();
    });
  });

  describe('CRUD: sets and reps', () => {
    beforeEach(async () => {
      await store.putSession(makeSession());
    });

    it('round-trips a set with reps via getSet(id)', async () => {
      const set = makeSet();
      await store.putSet(set);
      const fetched = await store.getSet(set.id);
      expect(fetched).toEqual(set);
    });

    it('returns undefined from getSet when id is missing', async () => {
      expect(await store.getSet('missing-set')).toBeUndefined();
    });

    it('round-trips the isWarmup flag; a working set reads back without the key', async () => {
      await store.putSet(makeSet({ id: 'set-warm', isWarmup: true }));
      await store.putSet(makeSet({ id: 'set-work' }));
      expect((await store.getSet('set-warm'))?.isWarmup).toBe(true);
      // Default (working) sets keep the pre-flag shape: no isWarmup key.
      expect(await store.getSet('set-work')).not.toHaveProperty('isWarmup');
    });

    it('coerces non-finite rep numbers to 0 rather than storing null (VMCP-01.41)', async () => {
      // Simulate bad upstream data: non-finite numeric fields on a rep. Plain
      // JSON.stringify renders NaN/Infinity as `null`, which reads back as
      // `null` in a numeric field (→ NaN downstream). The store's serializer
      // must coerce them to a finite, round-trippable value instead.
      const rep = makeRep('set-nf', 0);
      rep.concentric = { ...rep.concentric, peakForce: NaN };
      rep.eccentric = { ...rep.eccentric, peakVelocity: Infinity };
      await store.putSet(makeSet({ id: 'set-nf', reps: [rep] }));

      const fetched = await store.getSet('set-nf');
      expect(fetched).toBeDefined();
      const got = fetched!.reps[0];
      // Would be `null` on the pre-fix code path; the guard keeps it finite.
      expect(got.concentric.peakForce).toBe(0);
      expect(got.eccentric.peakVelocity).toBe(0);
      expect(Number.isFinite(got.concentric.peakForce)).toBe(true);
      expect(Number.isFinite(got.eccentric.peakVelocity)).toBe(true);
    });

    it('getSetsForSession returns all sets oldest-first', async () => {
      await store.putSet(
        makeSet({
          id: 'set-b',
          startedAt: '2025-01-01T00:01:00.000Z',
          reps: [makeRep('set-b', 0)],
        }),
      );
      await store.putSet(
        makeSet({
          id: 'set-a',
          startedAt: '2025-01-01T00:00:30.000Z',
          reps: [makeRep('set-a', 0)],
        }),
      );

      const sets = await store.getSetsForSession('sess-1');
      expect(sets.map((s) => s.id)).toEqual(['set-a', 'set-b']);
      expect(sets[0]?.reps).toHaveLength(1);
    });

    it('round-trips slot and deviceId; a set stored without them reads back with neither key', async () => {
      await store.putSet(makeSet({ id: 'set-left', slot: 'left', deviceId: 'AA:BB:CC:01' }));
      await store.putSet(makeSet({ id: 'set-right', slot: 'right', deviceId: 'AA:BB:CC:02' }));
      await store.putSet(makeSet({ id: 'set-unknown' }));

      const left = await store.getSet('set-left');
      expect(left?.slot).toBe('left');
      expect(left?.deviceId).toBe('AA:BB:CC:01');
      expect((await store.getSet('set-right'))?.slot).toBe('right');

      // Unstamped writes stay unstamped — no implicit 'primary' default.
      const unknown = await store.getSet('set-unknown');
      expect(unknown).not.toHaveProperty('slot');
      expect(unknown).not.toHaveProperty('deviceId');
    });

    it('records slot without deviceId when the slot has no connected device', async () => {
      await store.putSet(makeSet({ id: 'set-mock', slot: 'primary' }));
      const fetched = await store.getSet('set-mock');
      expect(fetched?.slot).toBe('primary');
      expect(fetched).not.toHaveProperty('deviceId');
    });

    it('round-trips side independently of slot, and omits it when unresolved', async () => {
      // slot and side deliberately disagree: the set ran on the 'primary' slot
      // key, performed by a device bound to the left limb. `side` is the
      // durable answer; `slot` is a position at a moment in time.
      await store.putSet(
        makeSet({ id: 'set-sided', slot: 'primary', deviceId: 'AA:BB:CC:01', side: 'left' }),
      );
      const sided = await store.getSet('set-sided');
      expect(sided?.side).toBe('left');
      expect(sided?.slot).toBe('primary');
      expect(sided?.deviceId).toBe('AA:BB:CC:01');

      // Known unit, unknown limb — an unbound device. A gap, not a guess.
      await store.putSet(makeSet({ id: 'set-sideless', slot: 'left', deviceId: 'AA:BB:CC:02' }));
      const sideless = await store.getSet('set-sideless');
      expect(sideless?.deviceId).toBe('AA:BB:CC:02');
      expect(sideless).not.toHaveProperty('side');
    });

    it('reads an out-of-range side value back as side-unknown', async () => {
      // `side` is a bare TEXT column, so nothing at the SQLite level stops a
      // future writer (or a hand-edited DB) putting a slot id in it. Reading
      // such a row back as absent keeps a bogus value from being mistaken for
      // a measured limb.
      await store.putSet(makeSet({ id: 'set-bogus', slot: 'primary' }));
      const raw = (store as unknown as { db: DatabaseSync }).db;
      raw.prepare(`UPDATE sets SET side = ? WHERE id = ?`).run('primary', 'set-bogus');
      expect(await store.getSet('set-bogus')).not.toHaveProperty('side');
    });

    it('getSetsForSession keeps each set attributed to its own slot', async () => {
      await store.putSet(
        makeSet({ id: 'l1', startedAt: '2025-01-01T00:00:30.000Z', slot: 'left' }),
      );
      await store.putSet(
        makeSet({ id: 'r1', startedAt: '2025-01-01T00:00:31.000Z', slot: 'right' }),
      );
      const sets = await store.getSetsForSession('sess-1');
      expect(sets.map((s) => [s.id, s.slot])).toEqual([
        ['l1', 'left'],
        ['r1', 'right'],
      ]);
    });

    it('upserts a set on duplicate id and replaces its rep array atomically', async () => {
      const initial = makeSet();
      await store.putSet(initial);

      const replaced: StoredSet = {
        ...initial,
        partial: true,
        partialReason: 'disconnect',
        reps: [makeRep(initial.id, 0)],
      };
      await store.putSet(replaced);

      const fetched = await store.getSet(initial.id);
      expect(fetched?.partial).toBe(true);
      expect(fetched?.partialReason).toBe('disconnect');
      expect(fetched?.reps).toHaveLength(1);
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      await store.putSession(
        makeSession({ id: 's1', startedAt: '2025-01-01T00:00:00.000Z', exerciseId: 'squat' }),
      );
      await store.putSession(
        makeSession({ id: 's2', startedAt: '2025-01-02T00:00:00.000Z', exerciseId: 'bench' }),
      );
      await store.putSession(
        makeSession({ id: 's3', startedAt: '2025-01-03T00:00:00.000Z', exerciseId: 'squat' }),
      );
    });

    it('defaults to startedAt:desc when no sort given (AC-19)', async () => {
      const rows = await store.listSessions({});
      expect(rows.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
    });

    it('honours startedAt:asc sort', async () => {
      const rows = await store.listSessions({ sort: 'startedAt:asc' });
      expect(rows.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    });

    it('filters by from (inclusive)', async () => {
      const rows = await store.listSessions({ from: '2025-01-02T00:00:00.000Z' });
      expect(rows.map((s) => s.id)).toEqual(['s3', 's2']);
    });

    it('filters by to (inclusive)', async () => {
      const rows = await store.listSessions({ to: '2025-01-02T00:00:00.000Z' });
      expect(rows.map((s) => s.id)).toEqual(['s2', 's1']);
    });

    it('filters by exerciseId', async () => {
      const rows = await store.listSessions({ exerciseId: 'squat' });
      expect(rows.map((s) => s.id)).toEqual(['s3', 's1']);
    });

    it('combines filters', async () => {
      const rows = await store.listSessions({
        exerciseId: 'squat',
        from: '2025-01-02T00:00:00.000Z',
        sort: 'startedAt:asc',
      });
      expect(rows.map((s) => s.id)).toEqual(['s3']);
    });

    it('respects limit and offset', async () => {
      const page1 = await store.listSessions({ limit: 2 });
      expect(page1.map((s) => s.id)).toEqual(['s3', 's2']);
      const page2 = await store.listSessions({ limit: 2, offset: 2 });
      expect(page2.map((s) => s.id)).toEqual(['s1']);
    });
  });
});

describe('SqliteSessionStore.open() error paths', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-store-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('throws SCHEMA_INCOMPATIBLE on unknown user_version (R17)', () => {
    const dbPath = join(workdir, 'wrong-version.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('PRAGMA user_version = 99');
    seed.close();

    let caught: unknown;
    try {
      SqliteSessionStore.open(dbPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { code?: string };
    expect(e.code).toBe('SCHEMA_INCOMPATIBLE');
    expect(e.message).toContain(dbPath);
    // Report BOTH the version found on disk and the version we require. Assert
    // the full `expected <n>` phrase rather than a bare digit: a bare digit
    // matches anywhere in the message — including the random temp path inside
    // `dbPath` — so `toContain('3')` passed by accident on macOS (long
    // `/var/folders/...` paths nearly always contain a '3') while failing on
    // CI's short `/tmp/...`. It had also gone stale: SCHEMA_VERSION is 5.
    expect(e.message).toContain('user_version=99');
    expect(e.message).toMatch(/expected 5\b/);
  });

  it('migrates a v1 DB forward by dropping chains_lbs and eccentric_percent columns', async () => {
    const dbPath = join(workdir, 'v1-migrate.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE sets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        partial INTEGER NOT NULL,
        partial_reason TEXT,
        training_mode TEXT NOT NULL,
        weight_lbs REAL NOT NULL,
        chains_lbs REAL,
        eccentric_percent REAL
      );
      PRAGMA user_version = 1;
    `);
    seed.close();

    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const cols = raw.prepare('PRAGMA table_info(sets)').all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).not.toContain('chains_lbs');
      expect(names).not.toContain('eccentric_percent');
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as {
        user_version?: number;
      };
      expect(version.user_version).toBe(5);
    } finally {
      await store.close();
    }
  });

  it('migrates a v3 DB forward by adding is_warmup, backfilling existing rows to 0', async () => {
    const dbPath = join(workdir, 'v3-migrate.sqlite');
    const seed = new DatabaseSync(dbPath);
    // v3 `sets` shape: no is_warmup column yet.
    seed.exec(`
      CREATE TABLE sets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        partial INTEGER NOT NULL,
        partial_reason TEXT,
        training_mode TEXT NOT NULL,
        weight_lbs REAL NOT NULL
      );
      INSERT INTO sets (id, session_id, started_at, ended_at, partial, training_mode, weight_lbs)
        VALUES ('legacy', 'sess-1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:01:00.000Z', 0, 'WeightTraining', 135);
      PRAGMA user_version = 3;
    `);
    seed.close();

    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const names = (raw.prepare('PRAGMA table_info(sets)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(names).toContain('is_warmup');
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as { user_version?: number };
      expect(version.user_version).toBe(5);
      // The pre-flag row backfills as a working set (no isWarmup key on read).
      expect(await store.getSet('legacy')).not.toHaveProperty('isWarmup');
    } finally {
      await store.close();
    }
  });

  it('a brand-new DB is created at the current schema version with no obsolete columns', async () => {
    const dbPath = join(workdir, 'fresh.sqlite');
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const cols = raw.prepare('PRAGMA table_info(sets)').all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).not.toContain('chains_lbs');
      expect(names).not.toContain('eccentric_percent');
    } finally {
      await store.close();
    }
  });

  it('throws lock error mentioning VMCP_DB_PATH and "already in use" (R8)', () => {
    const dbPath = join(workdir, 'lockme.sqlite');
    const first = SqliteSessionStore.open(dbPath);
    try {
      // Hold an exclusive lock while a second open attempts the same path.
      // node:sqlite uses BEGIN EXCLUSIVE / write-lock semantics; an open
      // concurrent writer should be detected.
      const raw = (first as unknown as { db: DatabaseSync }).db;
      raw.exec('BEGIN EXCLUSIVE');
      try {
        let caught: unknown;
        try {
          SqliteSessionStore.open(dbPath);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const e = caught as Error;
        expect(e.message).toContain('VMCP_DB_PATH');
        expect(e.message).toContain('already in use');
        expect(e.message).toContain(dbPath);
      } finally {
        raw.exec('ROLLBACK');
      }
    } finally {
      void first.close();
    }
  });

  it('opens an existing DB with matching user_version', async () => {
    const dbPath = join(workdir, 'reopen.sqlite');
    const a = SqliteSessionStore.open(dbPath);
    await a.putSession({ id: 'sess-r', startedAt: '2025-01-01T00:00:00.000Z' });
    await a.close();

    const b = SqliteSessionStore.open(dbPath);
    try {
      const fetched = await b.getSession('sess-r');
      expect(fetched?.id).toBe('sess-r');
    } finally {
      await b.close();
    }
  });
});

// ── v4 → v5 upgrade path (VMCP-04.08) ─────────────────────────────────────
//
// The risk this migration carries is not "does a fresh DB get the columns" —
// it is "does the user's existing history survive the upgrade". These tests
// therefore build a real v4-shaped file with representative rows across the
// FK graph (session → sets → reps, plus a program_assignment child of
// sessions), run the upgrade by opening the store, and assert every pre-v5
// row is still there and still readable.

/**
 * The `sets` DDL exactly as v4 shipped it: `is_warmup` present, no `slot` /
 * `device_id`. Spelled out literally rather than derived from the current
 * SCHEMA_SQL so the fixture cannot drift forward with the code under test.
 */
const V4_SCHEMA_SQL = `
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
    is_warmup INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE reps (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    rep_index INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE program_assignments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    planned_exercise_id TEXT,
    workout_template_id TEXT,
    assigned_at TEXT NOT NULL
  );
`;

/** Seed a v4 DB at `dbPath` with two sessions, three sets and their reps. */
function seedV4Database(dbPath: string): void {
  const seed = new DatabaseSync(dbPath);
  seed.exec(V4_SCHEMA_SQL);
  seed.exec(`
    INSERT INTO sessions (id, started_at, ended_at, exercise_id, exercise_name, notes) VALUES
      ('old-sess-1', '2025-06-01T10:00:00.000Z', '2025-06-01T10:45:00.000Z', 'squat', 'Back Squat', 'legacy'),
      ('old-sess-2', '2025-06-02T10:00:00.000Z', NULL, NULL, NULL, NULL);
    INSERT INTO sets (id, session_id, started_at, ended_at, partial, partial_reason, training_mode, weight_lbs, is_warmup) VALUES
      ('old-set-1', 'old-sess-1', '2025-06-01T10:01:00.000Z', '2025-06-01T10:02:00.000Z', 0, NULL, 'WeightTraining', 45, 1),
      ('old-set-2', 'old-sess-1', '2025-06-01T10:05:00.000Z', '2025-06-01T10:06:30.000Z', 1, 'disconnect', 'WeightTraining', 135, 0),
      ('old-set-3', 'old-sess-2', '2025-06-02T10:01:00.000Z', '2025-06-02T10:02:00.000Z', 0, NULL, 'Rowing', 0, 0);
    INSERT INTO program_assignments (id, session_id, planned_exercise_id, workout_template_id, assigned_at) VALUES
      ('old-assign-1', 'old-sess-1', NULL, NULL, '2025-06-01T09:59:00.000Z');
  `);
  const insertRep = seed.prepare(
    `INSERT INTO reps (id, set_id, rep_index, payload) VALUES (?, ?, ?, ?)`,
  );
  for (const setId of ['old-set-1', 'old-set-2', 'old-set-3']) {
    for (let i = 0; i < 3; i++) {
      insertRep.run(`${setId}-rep-${i}`, setId, i, JSON.stringify(makeRep(setId, i)));
    }
  }
  seed.exec('PRAGMA user_version = 4');
  seed.close();
}

describe('v4 → v5 migration: device / side / slot identity on sets', () => {
  let workdir: string;
  let dbPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-store-v5-'));
    dbPath = join(workdir, 'v4-migrate.sqlite');
    seedV4Database(dbPath);
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('adds slot and device_id to sets and stamps user_version = 5', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const names = (raw.prepare('PRAGMA table_info(sets)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(names).toContain('slot');
      expect(names).toContain('device_id');
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as { user_version?: number };
      expect(version.user_version).toBe(5);
    } finally {
      await store.close();
    }
  });

  it('adds the nullable side column alongside slot and device_id', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const columns = raw.prepare('PRAGMA table_info(sets)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const side = columns.find((c) => c.name === 'side');
      expect(side).toBeDefined();
      expect(side?.type).toBe('TEXT');
      // Nullable with no default: an unresolvable side must stay a gap.
      expect(side?.notnull).toBe(0);
      expect(side?.dflt_value).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('leaves every pre-v5 row side-unknown — no inference backfill', async () => {
    // `device_id` was discarded at write time on these rows, so there is
    // nothing left to resolve a side from. Inferring one (e.g. from set
    // ordering or alternation) would manufacture data that looks measured.
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const n = (
        raw.prepare('SELECT COUNT(*) AS n FROM sets WHERE side IS NOT NULL').get() as { n: number }
      ).n;
      expect(n).toBe(0);
      for (const id of ['old-set-1', 'old-set-2', 'old-set-3']) {
        expect(await store.getSet(id)).not.toHaveProperty('side');
      }
    } finally {
      await store.close();
    }
  });

  it('accepts side-bearing writes into the migrated DB', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const base = {
        sessionId: 'old-sess-1',
        startedAt: '2025-07-03T10:00:00.000Z',
        endedAt: '2025-07-03T10:01:00.000Z',
        partial: false,
        trainingMode: 'WeightTraining',
        weightLbs: 95,
        slot: 'primary',
      };
      await store.putSet({
        ...base,
        id: 'new-sided',
        deviceId: 'AA:BB:CC:01',
        side: 'right' as const,
        reps: [makeRep('new-sided', 0)],
      });
      // Same slot key, different unit, no binding — side stays absent.
      await store.putSet({
        ...base,
        id: 'new-sideless',
        deviceId: 'AA:BB:CC:02',
        reps: [makeRep('new-sideless', 0)],
      });

      expect((await store.getSet('new-sided'))?.side).toBe('right');
      expect(await store.getSet('new-sideless')).not.toHaveProperty('side');
      // The legacy rows are undisturbed by the new writes.
      expect(await store.getSet('old-set-1')).not.toHaveProperty('side');
    } finally {
      await store.close();
    }
  });

  it('leaves every pre-v5 row intact and readable, with no slot attribution', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const count = (table: string) =>
        (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('sessions')).toBe(2);
      expect(count('sets')).toBe(3);
      expect(count('reps')).toBe(9);
      // The FK child of `sessions` must still be there — the #79 cascade class
      // of bug is exactly what a careless migration would reintroduce.
      expect(count('program_assignments')).toBe(1);

      // Field-level survival, not just row counts.
      const session = await store.getSession('old-sess-1');
      expect(session).toEqual({
        id: 'old-sess-1',
        startedAt: '2025-06-01T10:00:00.000Z',
        endedAt: '2025-06-01T10:45:00.000Z',
        exerciseId: 'squat',
        exerciseName: 'Back Squat',
        notes: 'legacy',
      });

      const warmup = await store.getSet('old-set-1');
      expect(warmup?.isWarmup).toBe(true);
      expect(warmup?.weightLbs).toBe(45);
      expect(warmup?.reps).toHaveLength(3);

      const partial = await store.getSet('old-set-2');
      expect(partial?.partial).toBe(true);
      expect(partial?.partialReason).toBe('disconnect');
      expect(partial?.reps.map((r) => r.index)).toEqual([0, 1, 2]);

      // Historical rows are unattributable by arm and must READ that way —
      // absent, not backfilled to 'primary'.
      for (const id of ['old-set-1', 'old-set-2', 'old-set-3']) {
        const set = await store.getSet(id);
        expect(set).not.toHaveProperty('slot');
        expect(set).not.toHaveProperty('deviceId');
      }

      expect((await store.getSetsForSession('old-sess-1')).map((s) => s.id)).toEqual([
        'old-set-1',
        'old-set-2',
      ]);
    } finally {
      await store.close();
    }
  });

  it('accepts slot-bearing writes into the migrated DB alongside the legacy rows', async () => {
    const store = SqliteSessionStore.open(dbPath);
    try {
      await store.putSet({
        id: 'new-set-left',
        sessionId: 'old-sess-1',
        startedAt: '2025-07-01T10:00:00.000Z',
        endedAt: '2025-07-01T10:01:00.000Z',
        partial: false,
        trainingMode: 'WeightTraining',
        weightLbs: 95,
        slot: 'left',
        deviceId: 'AA:BB:CC:01',
        reps: [makeRep('new-set-left', 0)],
      });

      const fetched = await store.getSet('new-set-left');
      expect(fetched?.slot).toBe('left');
      expect(fetched?.deviceId).toBe('AA:BB:CC:01');
      // The legacy rows are undisturbed by the new write.
      expect(await store.getSet('old-set-1')).not.toHaveProperty('slot');
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const n = (raw.prepare('SELECT COUNT(*) AS n FROM sets').get() as { n: number }).n;
      expect(n).toBe(4);
    } finally {
      await store.close();
    }
  });

  it('re-putting a set updates in place instead of cascading its reps away', async () => {
    // Regression guard for the `INSERT OR REPLACE` class of bug (#79): the
    // force-end-then-re-end path re-puts the same set id, and a
    // delete-then-insert on the `reps` parent would drop the rep array.
    const store = SqliteSessionStore.open(dbPath);
    try {
      const base = {
        id: 'retried',
        sessionId: 'old-sess-1',
        startedAt: '2025-07-02T10:00:00.000Z',
        endedAt: '2025-07-02T10:01:00.000Z',
        partial: true,
        partialReason: 'inactivity_timeout',
        trainingMode: 'WeightTraining',
        weightLbs: 95,
        slot: 'right',
        deviceId: 'AA:BB:CC:02',
        reps: [makeRep('retried', 0), makeRep('retried', 1)],
      };
      await store.putSet(base);
      await store.putSet({ ...base, partial: false, partialReason: undefined, slot: 'left' });

      const fetched = await store.getSet('retried');
      expect(fetched?.partial).toBe(false);
      expect(fetched?.slot).toBe('left');
      expect(fetched?.reps).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it('is idempotent — reopening an already-migrated DB is a no-op', async () => {
    const first = SqliteSessionStore.open(dbPath);
    await first.close();

    const second = SqliteSessionStore.open(dbPath);
    try {
      const raw = (second as unknown as { db: DatabaseSync }).db;
      const slotCols = (
        raw.prepare('PRAGMA table_info(sets)').all() as Array<{ name: string }>
      ).filter((c) => c.name === 'slot' || c.name === 'device_id');
      expect(slotCols).toHaveLength(2);
      const n = (raw.prepare('SELECT COUNT(*) AS n FROM reps').get() as { n: number }).n;
      expect(n).toBe(9);
    } finally {
      await second.close();
    }
  });
});
