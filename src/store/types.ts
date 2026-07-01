// Persistence contracts for voltras-mcp.
//
// Mirrors the WA-04 target schema (analytics plan `622c5d67`) so the SQLite
// implementation in `src/store/sqlite-store.ts` can be swapped for a thin
// adapter over `@voltras/workout-analytics` storage once that package ships.
//
// `StoredRep extends Rep` together with the `_STORED_REP_SHAPE_CHECK`
// compile-time `satisfies` assertion locks our stored shape to the upstream
// analytics `Rep` interface.
// If `@voltras/workout-analytics` changes the `Rep` shape, this file fails to
// compile and the schema drift surfaces in CI rather than at runtime.
//
// Designed in tandem with PR 1 of plan `a9cb1cb7`. The accompanying
// `src/store/sqlite-store.ts` (Task 07) provides the only built-in
// implementation of `SessionStore`.
//
// NOTE: `TrainingModeName` is defined here as a string alias rather than
// imported from `src/schemas/common.ts` because schemas land in a parallel
// task; the alias will be unified once both branches merge.
import type { Rep } from '@voltras/workout-analytics';

/** String form of the SDK's `TrainingMode` enum (e.g. `"WeightTraining"`). */
export type TrainingModeName = string;

/**
 * A persisted rep row. Intersected with the upstream analytics `Rep` so that
 * stored reps can be passed straight back into `@voltras/workout-analytics`
 * functions without translation.
 *
 * Modelled as a type intersection rather than `interface … extends Rep`
 * because TypeScript silently drops Rep's fields when an interface extends
 * the type-only re-export chain shipped from `@voltras/workout-analytics`
 * (root → models → rep). The intersection form preserves field visibility.
 */
export type StoredRep = Rep & {
  id: string;
  setId: string;
  index: number;
};

/**
 * Compile-time shape guard: `StoredRep` must remain assignment-compatible
 * with `Rep`. If the upstream `Rep` interface gains or renames a field, the
 * `satisfies` clause below breaks the build — fail loudly at compile time,
 * never silently at runtime.
 */
export const _STORED_REP_SHAPE_CHECK = null as unknown as StoredRep satisfies Rep;

/**
 * A persisted set row. `partial` is true when the set ended for any reason
 * other than an explicit `set.end` call; `partialReason` carries the cause.
 */
export interface StoredSet {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  partial: boolean;
  partialReason?: string;
  trainingMode: TrainingModeName;
  weightLbs: number;
  reps: StoredRep[];
}

/**
 * A persisted session row. `endedAt` is undefined while the session is still
 * active and is filled in once `session.end` runs.
 */
export interface StoredSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  exerciseId?: string;
  exerciseName?: string;
  notes?: string;
}

/**
 * Filter parameters for `listSessions`. `sort` defaults to `'startedAt:desc'`
 * and `limit` defaults to `50` at the implementation layer.
 */
export interface SessionListFilter {
  from?: string;
  to?: string;
  exerciseId?: string;
  sort?: 'startedAt:desc' | 'startedAt:asc';
  limit?: number;
  offset?: number;
}

/**
 * Stored telemetry snapshot for a single device read. Reserved for future
 * persistence of device-state samples; not used in Wave 1 transport flows but
 * declared here so the WA-04 alignment is type-checked end to end.
 */
export interface StoredDeviceTelemetry {
  recordedAt: string;
  deviceId: string;
  weightLbs?: number;
  trainingMode?: TrainingModeName;
  batteryPercent?: number;
}

/**
 * Mesocycle focus tag. Open-typed via the `string` member so callers can
 * persist freeform labels (e.g. `'volume-accumulation'`) when the canonical
 * tags aren't a fit.
 */
export type TrainingFocus = 'hypertrophy' | 'strength' | 'peaking' | 'deload' | string;

/** A multi-week training program (the top-level planning container). */
export interface StoredTrainingProgram {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  archivedAt?: string;
}

/** A mesocycle within a program (e.g. a 4-week hypertrophy block). */
export interface StoredTrainingBlock {
  id: string;
  programId: string;
  orderIndex: number;
  name: string;
  focus?: TrainingFocus;
  weeksCount: number;
  notes?: string;
}

/** A single week within a block. */
export interface StoredTrainingWeek {
  id: string;
  blockId: string;
  orderIndex: number;
  name?: string;
}

/** A planned workout within a week (e.g. "Upper A"). */
export interface StoredWorkoutTemplate {
  id: string;
  weekId: string;
  dayLabel?: string;
  name: string;
  notes?: string;
  orderIndex: number;
}

/** A planned exercise within a workout template (sets/reps/weight prescription). */
export interface StoredPlannedExercise {
  id: string;
  workoutTemplateId: string;
  exerciseId: string;
  orderIndex: number;
  targetSets: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
  targetRpe?: number;
  restSec?: number;
  notes?: string;
}

/** Links a completed session to a planned exercise / workout template. */
export interface StoredProgramAssignment {
  id: string;
  sessionId: string;
  plannedExerciseId?: string;
  workoutTemplateId?: string;
  assignedAt: string;
}

/**
 * Persistence boundary for VMCP. The SQLite implementation in
 * `src/store/sqlite-store.ts` opens a `node:sqlite` database; consumers depend
 * only on this interface.
 */
export interface SessionStore {
  /**
   * Upsert via `ON CONFLICT(id) DO UPDATE` (see the SqliteSessionStore
   * implementation). Called twice per session — once at `session.start`
   * (no `endedAt`), once at `session.end` (with `endedAt`) — so the second
   * call MUST update the existing row in place; a naive `INSERT` fails on it.
   *
   * DO NOT implement this as `INSERT OR REPLACE`. `sessions` is a foreign-key
   * cascade parent: `program_assignments.session_id REFERENCES sessions(id)
   * ON DELETE CASCADE`. `INSERT OR REPLACE` deletes the conflicting row before
   * re-inserting, and that delete cascades — every `session.end` re-put would
   * wipe the session's `program_assignment` links (the data-loss regression
   * fixed in #79). Update the row in place instead.
   */
  putSession(s: StoredSession): Promise<void>;

  /** Persist a completed (or partial) set together with its rep array. */
  putSet(s: StoredSet): Promise<void>;

  /** Look up a session by id; returns `undefined` when no row matches. */
  getSession(id: string): Promise<StoredSession | undefined>;

  /**
   * Look up a set by id; returns `undefined` when no row matches. Required by
   * set-level metrics pipelines (`vbt.set`, `quality.rep`, `fatigue.set`)
   * which receive a bare `setId` with no surrounding `sessionId`.
   */
  getSet(id: string): Promise<StoredSet | undefined>;

  /** Filtered/paginated session listing. */
  listSessions(filter: SessionListFilter): Promise<StoredSession[]>;

  /** Return every set persisted for the given session, oldest-first. */
  getSetsForSession(sessionId: string): Promise<StoredSet[]>;

  // --- Block-periodization planning (v3 schema) ---

  /** Upsert a training program (top-level planning container). */
  putTrainingProgram(p: StoredTrainingProgram): Promise<void>;
  /** Look up a training program by id. */
  getTrainingProgram(id: string): Promise<StoredTrainingProgram | undefined>;
  /** List training programs; archived rows are excluded by default. */
  listTrainingPrograms(opts?: { includeArchived?: boolean }): Promise<StoredTrainingProgram[]>;

  /** Upsert a block (mesocycle) within a program. */
  putTrainingBlock(b: StoredTrainingBlock): Promise<void>;
  /** Return every block in a program, ordered by `orderIndex` ascending. */
  getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]>;

  /** Upsert a week within a block. */
  putTrainingWeek(w: StoredTrainingWeek): Promise<void>;
  /** Return every week in a block, ordered by `orderIndex` ascending. */
  getTrainingWeeksForBlock(blockId: string): Promise<StoredTrainingWeek[]>;

  /** Upsert a workout template within a week. */
  putWorkoutTemplate(t: StoredWorkoutTemplate): Promise<void>;
  /** Look up a workout template by id. */
  getWorkoutTemplate(id: string): Promise<StoredWorkoutTemplate | undefined>;
  /** Return every template in a week, ordered by `orderIndex` ascending. */
  getWorkoutTemplatesForWeek(weekId: string): Promise<StoredWorkoutTemplate[]>;

  /** Upsert a planned exercise within a workout template. */
  putPlannedExercise(e: StoredPlannedExercise): Promise<void>;
  /** Return every planned exercise in a template, ordered by `orderIndex` ascending. */
  getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]>;

  /** Upsert a session-to-plan link. */
  putProgramAssignment(a: StoredProgramAssignment): Promise<void>;
  /** Return every assignment that links to a given session. */
  getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]>;
  /**
   * Return every assignment that points at a given workout template (across
   * any session). Used by `plan.next_workout` to detect which templates have
   * already been completed in a program walk.
   */
  getAssignmentsForTemplate(templateId: string): Promise<StoredProgramAssignment[]>;

  /** Release the underlying database handle. Idempotent. */
  close(): Promise<void>;
}
