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
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredRep,
  StoredSession,
  StoredSet,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from './types.js';

const SCHEMA_VERSION = 3;

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

  -- v3: block-periodization workout planning. Six tables modelling a
  -- program → block → week → workout-template → planned-exercise tree,
  -- plus a program_assignments join that links completed sessions back
  -- to the prescribed exercise. ON DELETE CASCADE walks the planning
  -- tree; ON DELETE SET NULL on assignments preserves session history
  -- when a plan row is removed.

  CREATE TABLE IF NOT EXISTS training_programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS training_blocks (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    focus TEXT,
    weeks_count INTEGER NOT NULL,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_training_blocks_program
    ON training_blocks(program_id, order_index);

  CREATE TABLE IF NOT EXISTS training_weeks (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES training_blocks(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_training_weeks_block
    ON training_weeks(block_id, order_index);

  CREATE TABLE IF NOT EXISTS workout_templates (
    id TEXT PRIMARY KEY,
    week_id TEXT NOT NULL REFERENCES training_weeks(id) ON DELETE CASCADE,
    day_label TEXT,
    name TEXT NOT NULL,
    notes TEXT,
    order_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_workout_templates_week
    ON workout_templates(week_id, order_index);

  CREATE TABLE IF NOT EXISTS planned_exercises (
    id TEXT PRIMARY KEY,
    workout_template_id TEXT NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
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
  CREATE INDEX IF NOT EXISTS idx_planned_exercises_template
    ON planned_exercises(workout_template_id, order_index);

  CREATE TABLE IF NOT EXISTS program_assignments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    planned_exercise_id TEXT REFERENCES planned_exercises(id) ON DELETE SET NULL,
    workout_template_id TEXT REFERENCES workout_templates(id) ON DELETE SET NULL,
    assigned_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_program_assignments_session
    ON program_assignments(session_id);
  CREATE INDEX IF NOT EXISTS idx_program_assignments_planned
    ON program_assignments(planned_exercise_id);
  CREATE INDEX IF NOT EXISTS idx_program_assignments_template
    ON program_assignments(workout_template_id);
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

/**
 * v2→v3: introduce the block-periodization planning tables. All `CREATE TABLE`
 * statements live in `SCHEMA_SQL` with `IF NOT EXISTS` guards, so a v2 DB
 * picks them up the moment `db.exec(SCHEMA_SQL)` runs at open time. This
 * stub exists for symmetry and to make the version bump explicit; the actual
 * DDL is shared with fresh-DB creation to avoid drift.
 */
const MIGRATE_V2_TO_V3_SQL = `-- v2→v3 schema additions are folded into SCHEMA_SQL via CREATE IF NOT EXISTS.`;

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

interface TrainingProgramRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  archived_at: string | null;
}

interface TrainingBlockRow {
  id: string;
  program_id: string;
  order_index: number;
  name: string;
  focus: string | null;
  weeks_count: number;
  notes: string | null;
}

interface TrainingWeekRow {
  id: string;
  block_id: string;
  order_index: number;
  name: string | null;
}

interface WorkoutTemplateRow {
  id: string;
  week_id: string;
  day_label: string | null;
  name: string;
  notes: string | null;
  order_index: number;
}

interface PlannedExerciseRow {
  id: string;
  workout_template_id: string;
  exercise_id: string;
  order_index: number;
  target_sets: number;
  target_reps_low: number | null;
  target_reps_high: number | null;
  target_weight_lbs: number | null;
  target_rpe: number | null;
  rest_sec: number | null;
  notes: string | null;
}

interface ProgramAssignmentRow {
  id: string;
  session_id: string;
  planned_exercise_id: string | null;
  workout_template_id: string | null;
  assigned_at: string;
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
      // Foreign-key enforcement is off by default in SQLite. The v3 planning
      // tree relies on ON DELETE CASCADE / SET NULL, so it MUST be on for
      // every connection. Set before the schema runs so any seed inserts
      // also see the constraints.
      db.exec('PRAGMA foreign_keys = ON');
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

  // --- Block-periodization planning (v3 schema) ---

  async putTrainingProgram(p: StoredTrainingProgram): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO training_programs
           (id, name, description, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.description ?? null, p.createdAt, p.archivedAt ?? null);
    return Promise.resolve();
  }

  async getTrainingProgram(id: string): Promise<StoredTrainingProgram | undefined> {
    const row = this.db.prepare(`SELECT * FROM training_programs WHERE id = ?`).get(id) as
      | TrainingProgramRow
      | undefined;
    return Promise.resolve(row ? rowToTrainingProgram(row) : undefined);
  }

  async listTrainingPrograms(opts: {
    includeArchived?: boolean;
  } = {}): Promise<StoredTrainingProgram[]> {
    const sql = opts.includeArchived
      ? `SELECT * FROM training_programs ORDER BY created_at DESC`
      : `SELECT * FROM training_programs WHERE archived_at IS NULL ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all() as unknown as TrainingProgramRow[];
    return Promise.resolve(rows.map(rowToTrainingProgram));
  }

  async putTrainingBlock(b: StoredTrainingBlock): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO training_blocks
           (id, program_id, order_index, name, focus, weeks_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.programId, b.orderIndex, b.name, b.focus ?? null, b.weeksCount, b.notes ?? null);
    return Promise.resolve();
  }

  async getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]> {
    const rows = this.db
      .prepare(`SELECT * FROM training_blocks WHERE program_id = ? ORDER BY order_index ASC`)
      .all(programId) as unknown as TrainingBlockRow[];
    return Promise.resolve(rows.map(rowToTrainingBlock));
  }

  async putTrainingWeek(w: StoredTrainingWeek): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO training_weeks
           (id, block_id, order_index, name)
         VALUES (?, ?, ?, ?)`,
      )
      .run(w.id, w.blockId, w.orderIndex, w.name ?? null);
    return Promise.resolve();
  }

  async getTrainingWeeksForBlock(blockId: string): Promise<StoredTrainingWeek[]> {
    const rows = this.db
      .prepare(`SELECT * FROM training_weeks WHERE block_id = ? ORDER BY order_index ASC`)
      .all(blockId) as unknown as TrainingWeekRow[];
    return Promise.resolve(rows.map(rowToTrainingWeek));
  }

  async putWorkoutTemplate(t: StoredWorkoutTemplate): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workout_templates
           (id, week_id, day_label, name, notes, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.weekId, t.dayLabel ?? null, t.name, t.notes ?? null, t.orderIndex);
    return Promise.resolve();
  }

  async getWorkoutTemplate(id: string): Promise<StoredWorkoutTemplate | undefined> {
    const row = this.db.prepare(`SELECT * FROM workout_templates WHERE id = ?`).get(id) as
      | WorkoutTemplateRow
      | undefined;
    return Promise.resolve(row ? rowToWorkoutTemplate(row) : undefined);
  }

  async getWorkoutTemplatesForWeek(weekId: string): Promise<StoredWorkoutTemplate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM workout_templates WHERE week_id = ? ORDER BY order_index ASC`)
      .all(weekId) as unknown as WorkoutTemplateRow[];
    return Promise.resolve(rows.map(rowToWorkoutTemplate));
  }

  async putPlannedExercise(e: StoredPlannedExercise): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO planned_exercises
           (id, workout_template_id, exercise_id, order_index, target_sets,
            target_reps_low, target_reps_high, target_weight_lbs, target_rpe,
            rest_sec, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.workoutTemplateId,
        e.exerciseId,
        e.orderIndex,
        e.targetSets,
        e.targetRepsLow ?? null,
        e.targetRepsHigh ?? null,
        e.targetWeightLbs ?? null,
        e.targetRpe ?? null,
        e.restSec ?? null,
        e.notes ?? null,
      );
    return Promise.resolve();
  }

  async getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM planned_exercises WHERE workout_template_id = ? ORDER BY order_index ASC`,
      )
      .all(templateId) as unknown as PlannedExerciseRow[];
    return Promise.resolve(rows.map(rowToPlannedExercise));
  }

  async putProgramAssignment(a: StoredProgramAssignment): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO program_assignments
           (id, session_id, planned_exercise_id, workout_template_id, assigned_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.sessionId,
        a.plannedExerciseId ?? null,
        a.workoutTemplateId ?? null,
        a.assignedAt,
      );
    return Promise.resolve();
  }

  async getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM program_assignments WHERE session_id = ? ORDER BY assigned_at ASC`,
      )
      .all(sessionId) as unknown as ProgramAssignmentRow[];
    return Promise.resolve(rows.map(rowToProgramAssignment));
  }

  async getAssignmentsForTemplate(templateId: string): Promise<StoredProgramAssignment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM program_assignments WHERE workout_template_id = ? ORDER BY assigned_at ASC`,
      )
      .all(templateId) as unknown as ProgramAssignmentRow[];
    return Promise.resolve(rows.map(rowToProgramAssignment));
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
  // 2 = Phase 0.5.1 schema; v3 added the planning tables (additive only).
  // SCHEMA_VERSION = current. Anything else is an unknown future version
  // and we refuse to touch it.
  if (found !== 0 && found !== 1 && found !== 2 && found !== SCHEMA_VERSION) {
    throw createSchemaIncompatibleError(path, found);
  }
}

/**
 * Apply forward migrations on an open `db`. Idempotent: each migration is
 * gated by the user_version it targets, so running on a fresh v3 DB is a
 * no-op. Runs after `SCHEMA_SQL` so brand-new DBs already have the v3 table
 * shape and skip every migration body.
 */
function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current === 1) {
    db.exec(MIGRATE_V1_TO_V2_SQL);
  }
  if (current <= 2) {
    db.exec(MIGRATE_V2_TO_V3_SQL);
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

function rowToTrainingProgram(row: TrainingProgramRow): StoredTrainingProgram {
  const out: StoredTrainingProgram = {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
  if (row.description !== null) out.description = row.description;
  if (row.archived_at !== null) out.archivedAt = row.archived_at;
  return out;
}

function rowToTrainingBlock(row: TrainingBlockRow): StoredTrainingBlock {
  const out: StoredTrainingBlock = {
    id: row.id,
    programId: row.program_id,
    orderIndex: row.order_index,
    name: row.name,
    weeksCount: row.weeks_count,
  };
  if (row.focus !== null) out.focus = row.focus;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToTrainingWeek(row: TrainingWeekRow): StoredTrainingWeek {
  const out: StoredTrainingWeek = {
    id: row.id,
    blockId: row.block_id,
    orderIndex: row.order_index,
  };
  if (row.name !== null) out.name = row.name;
  return out;
}

function rowToWorkoutTemplate(row: WorkoutTemplateRow): StoredWorkoutTemplate {
  const out: StoredWorkoutTemplate = {
    id: row.id,
    weekId: row.week_id,
    name: row.name,
    orderIndex: row.order_index,
  };
  if (row.day_label !== null) out.dayLabel = row.day_label;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToPlannedExercise(row: PlannedExerciseRow): StoredPlannedExercise {
  const out: StoredPlannedExercise = {
    id: row.id,
    workoutTemplateId: row.workout_template_id,
    exerciseId: row.exercise_id,
    orderIndex: row.order_index,
    targetSets: row.target_sets,
  };
  if (row.target_reps_low !== null) out.targetRepsLow = row.target_reps_low;
  if (row.target_reps_high !== null) out.targetRepsHigh = row.target_reps_high;
  if (row.target_weight_lbs !== null) out.targetWeightLbs = row.target_weight_lbs;
  if (row.target_rpe !== null) out.targetRpe = row.target_rpe;
  if (row.rest_sec !== null) out.restSec = row.rest_sec;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToProgramAssignment(row: ProgramAssignmentRow): StoredProgramAssignment {
  const out: StoredProgramAssignment = {
    id: row.id,
    sessionId: row.session_id,
    assignedAt: row.assigned_at,
  };
  if (row.planned_exercise_id !== null) out.plannedExerciseId = row.planned_exercise_id;
  if (row.workout_template_id !== null) out.workoutTemplateId = row.workout_template_id;
  return out;
}
