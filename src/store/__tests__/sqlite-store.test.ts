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
    expect(e.message).toContain('99');
    expect(e.message).toContain('3');
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
      expect(version.user_version).toBe(4);
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
      expect(version.user_version).toBe(4);
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
