// SqliteSessionStore — the only built-in implementation of `SessionStore`.
//
// Backed by Node 22's built-in `node:sqlite`. Schema is embedded as a
// constant and versioned via `PRAGMA user_version`; mismatched DBs are
// rejected with `SCHEMA_INCOMPATIBLE` (R17, no automatic migration in v1).
// On open, a small write probe (`BEGIN IMMEDIATE` / `COMMIT`) acquires and
// releases a transient write lock so that concurrent processes contesting
// the same `VMCP_DB_PATH` are detected up-front (R8); the resulting error
// surfaces the env-var name and "already in use" hint expected by the
// README's concurrency note.
//
// The `Rep` type from `@voltras/workout-analytics` carries nested `Phase`
// objects with sample arrays, so each rep is persisted as a JSON-serialised
// payload rather than a wide flat row. The `id`/`setId`/`index` columns
// (StoredRep's own additions) remain queryable.
//
// Set persistence is atomic: `putSet` runs a transaction that upserts the
// set row and replaces the entire rep array, so retries (e.g. force-end on
// disconnect followed by an explicit re-end) never leave stale reps behind.

import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import type {
  SessionListFilter,
  SessionStore,
  StoredRep,
  StoredSession,
  StoredSet,
} from './types.js';

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

  CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    partial INTEGER NOT NULL,
    partial_reason TEXT,
    training_mode TEXT NOT NULL,
    weight_lbs REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sets_session_id ON sets(session_id, started_at);

  CREATE TABLE IF NOT EXISTS reps (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    rep_index INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reps_set_id ON reps(set_id, rep_index);
`;

/**
 * Drops the obsolete `chains_lbs` and `eccentric_percent` columns from the
 * `sets` table. Phase 0.5.1 cleanup — those fields were never read by any
 * consumer (per `inventory-bridge.md`) and the in-memory `DeviceSnapshot`
 * never carried them. Idempotent: pre-v2 schemas have the columns and need
 * the drop; v2 schemas already lack them and the `IF EXISTS`-equivalent
 * `pragma_table_info` guard skips the work.
 */
const MIGRATE_V1_TO_V2_SQL = `
  ALTER TABLE sets DROP COLUMN chains_lbs;
  ALTER TABLE sets DROP COLUMN eccentric_percent;
`;

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  exercise_id: string | null;
  exercise_name: string | null;
  notes: string | null;
}

interface SetRow {
  id: string;
  session_id: string;
  started_at: string;
  ended_at: string;
  partial: number;
  partial_reason: string | null;
  training_mode: string;
  weight_lbs: number;
}

interface RepRow {
  id: string;
  set_id: string;
  rep_index: number;
  payload: string;
}

/** SQLite-backed implementation of `SessionStore`. */
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open (or create) the SQLite database at `path`. Detects schema version
   * mismatch and concurrent-writer lock contention before returning a
   * usable store. On any failure, the underlying handle is closed before
   * the error is rethrown so partial-init cleanup in `bootstrapState()`
   * does not have to track a half-open DB.
   */
  static open(path: string): SqliteSessionStore {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (err) {
      if (isSqliteBusy(err)) {
        throw createLockedError(path, err);
      }
      throw err;
    }
    try {
      checkSchemaVersion(db, path);
      probeWriteLock(db, path);
      db.exec(SCHEMA_SQL);
      applyMigrations(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return new SqliteSessionStore(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // ignore — original error is what we want to surface.
      }
      // Schema-version reads can themselves hit SQLITE_BUSY when another
      // process holds an exclusive lock. Convert those to the friendly
      // lock error so callers see the VMCP_DB_PATH guidance once, not a
      // raw "database is locked" surprise.
      const e = err as Error & { code?: string };
      if (e.code !== 'SCHEMA_INCOMPATIBLE' && isSqliteBusy(err)) {
        throw createLockedError(path, err);
      }
      throw err;
    }
  }

  async putSession(s: StoredSession): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
           (id, started_at, ended_at, exercise_id, exercise_name, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.startedAt,
        s.endedAt ?? null,
        s.exerciseId ?? null,
        s.exerciseName ?? null,
        s.notes ?? null,
      );
    return Promise.resolve();
  }

  async putSet(s: StoredSet): Promise<void> {
    const upsertSet = this.db.prepare(
      `INSERT OR REPLACE INTO sets
         (id, session_id, started_at, ended_at, partial, partial_reason,
          training_mode, weight_lbs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteReps = this.db.prepare(`DELETE FROM reps WHERE set_id = ?`);
    const insertRep = this.db.prepare(
      `INSERT INTO reps (id, set_id, rep_index, payload) VALUES (?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      upsertSet.run(
        s.id,
        s.sessionId,
        s.startedAt,
        s.endedAt,
        s.partial ? 1 : 0,
        s.partialReason ?? null,
        s.trainingMode,
        s.weightLbs,
      );
      deleteReps.run(s.id);
      for (const rep of s.reps) {
        insertRep.run(rep.id, rep.setId, rep.index, JSON.stringify(rep));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return Promise.resolve(row ? rowToSession(row) : undefined);
  }

  async getSet(id: string): Promise<StoredSet | undefined> {
    const row = this.db.prepare(`SELECT * FROM sets WHERE id = ?`).get(id) as SetRow | undefined;
    if (!row) return Promise.resolve(undefined);
    const reps = this.loadRepsForSet(row.id);
    return Promise.resolve(rowToSet(row, reps));
  }

  async listSessions(filter: SessionListFilter): Promise<StoredSession[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.from !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    if (filter.exerciseId !== undefined) {
      where.push('exercise_id = ?');
      params.push(filter.exerciseId);
    }
    const direction = filter.sort === 'startedAt:asc' ? 'ASC' : 'DESC';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const sql =
      `SELECT * FROM sessions` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY started_at ${direction} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as unknown as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  async getSetsForSession(sessionId: string): Promise<StoredSet[]> {
    const rows = this.db
      .prepare(`SELECT * FROM sets WHERE session_id = ? ORDER BY started_at ASC`)
      .all(sessionId) as unknown as SetRow[];
    const sets = rows.map((row) => rowToSet(row, this.loadRepsForSet(row.id)));
    return Promise.resolve(sets);
  }

  async close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      log.warn('SqliteSessionStore.close() failed', err);
    }
    return Promise.resolve();
  }

  private loadRepsForSet(setId: string): StoredRep[] {
    const rows = this.db
      .prepare(`SELECT * FROM reps WHERE set_id = ? ORDER BY rep_index ASC`)
      .all(setId) as unknown as RepRow[];
    return rows.map((row) => JSON.parse(row.payload) as StoredRep);
  }
}

function checkSchemaVersion(db: DatabaseSync, path: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const found = row?.user_version ?? 0;
  // 0 = brand-new DB (CREATE TABLE IF NOT EXISTS will populate it).
  // 1 = pre-Phase-0.5.1 schema (migrated forward in `applyMigrations`).
  // SCHEMA_VERSION = current. Anything else is an unknown future version
  // and we refuse to touch it.
  if (found !== 0 && found !== 1 && found !== SCHEMA_VERSION) {
    throw createSchemaIncompatibleError(path, found);
  }
}

/**
 * Apply forward migrations on an open `db`. Idempotent: each migration is
 * gated by the user_version it targets, so running on a fresh v2 DB is a
 * no-op. Runs after `SCHEMA_SQL` so brand-new DBs already have the v2 table
 * shape and skip every migration body.
 */
function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current === 1) {
    db.exec(MIGRATE_V1_TO_V2_SQL);
  }
}

function probeWriteLock(db: DatabaseSync, path: string): void {
  // BEGIN IMMEDIATE acquires (and we immediately release) a RESERVED lock,
  // which fails with SQLITE_BUSY if another connection holds an exclusive
  // or pending write lock on the same database file. This converts the
  // lock contention into a clear startup error before any user data is
  // written.
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (err) {
    if (isSqliteBusy(err)) {
      throw createLockedError(path, err);
    }
    throw err;
  }
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errAny = err as Error & { code?: string; errcode?: number };
  if (
    typeof errAny.code === 'string' &&
    (errAny.code === 'SQLITE_BUSY' || errAny.code === 'EBUSY')
  ) {
    return true;
  }
  // node:sqlite reports SQLite error codes via `errcode` (numeric); 5 is
  // SQLITE_BUSY and 6 is SQLITE_LOCKED. The wrapping `code` is the generic
  // `ERR_SQLITE_ERROR`, so fall back to the numeric code or the message.
  if (errAny.errcode === 5 || errAny.errcode === 6) return true;
  return /SQLITE_BUSY|database is locked|EBUSY/i.test(err.message);
}

function createSchemaIncompatibleError(path: string, found: number): Error {
  const message =
    `SQLite schema at ${path} has user_version=${found}; ` +
    `expected ${SCHEMA_VERSION}. Automatic migration is not supported in v1. ` +
    `Move or delete the file and let voltras-mcp recreate it.`;
  const err = new Error(message);
  (err as Error & { code: string }).code = 'SCHEMA_INCOMPATIBLE';
  return err;
}

function createLockedError(path: string, cause: unknown): Error {
  const message =
    `VMCP_DB_PATH ${path} is already in use by another process. ` +
    `Stdio MCP servers are single-writer by design — close the other ` +
    `voltras-mcp process or set VMCP_DB_PATH to a different file.`;
  const err = new Error(message, { cause });
  (err as Error & { code: string }).code = 'DB_LOCKED';
  return err;
}

function rowToSession(row: SessionRow): StoredSession {
  const out: StoredSession = { id: row.id, startedAt: row.started_at };
  if (row.ended_at !== null) out.endedAt = row.ended_at;
  if (row.exercise_id !== null) out.exerciseId = row.exercise_id;
  if (row.exercise_name !== null) out.exerciseName = row.exercise_name;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToSet(row: SetRow, reps: StoredRep[]): StoredSet {
  const out: StoredSet = {
    id: row.id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    partial: row.partial !== 0,
    trainingMode: row.training_mode,
    weightLbs: row.weight_lbs,
    reps,
  };
  if (row.partial_reason !== null) out.partialReason = row.partial_reason;
  return out;
}
