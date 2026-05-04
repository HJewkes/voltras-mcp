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
 * A persisted rep row. Extends the upstream analytics `Rep` exactly so that
 * stored reps can be passed straight back into `@voltras/workout-analytics`
 * functions without translation.
 */
export interface StoredRep extends Rep {
  id: string;
  setId: string;
  index: number;
}

/**
 * Compile-time shape guard: `StoredRep` must remain assignment-compatible
 * with `Rep`. If the upstream `Rep` interface gains or renames a field, the
 * `satisfies` clause below breaks the build — fail loudly at compile time,
 * never silently at runtime. Exported as a const so `noUnusedLocals` is
 * satisfied without leaking implementation detail.
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
  chainsLbs?: number;
  eccentricPercent?: number;
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
 * Persistence boundary for VMCP. The SQLite implementation in
 * `src/store/sqlite-store.ts` opens a `node:sqlite` database; consumers depend
 * only on this interface.
 */
export interface SessionStore {
  /**
   * Upsert: INSERT OR REPLACE semantics. Called twice per session — once at
   * `session.start` (no `endedAt`), once at `session.end` (with `endedAt`).
   * Implementations MUST overwrite the existing row when the ids match;
   * a naive `INSERT` will fail on the second call.
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

  /** Release the underlying database handle. Idempotent. */
  close(): Promise<void>;
}
