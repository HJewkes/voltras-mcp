// Pure aggregation helpers for `session.list` summary tier.
//
// Each function is side-effect-free and depends only on its arguments, making
// unit-testing straightforward without any store or server-state setup.
//
// The summary tier fires one `getSetsForSession` call per session in the list
// (N+1 pattern). This is acceptable for v1 where N ≤ 200 and SQLite queries
// are in-process. A future optimisation can add a
// `listSessionAggregates(filter)` store method that performs the aggregation in
// a single SQL query.

import type { StoredSession, StoredSet } from '../store/types.js';

/**
 * Aggregate view of a single session, returned by `session.list` with the
 * default `detail: 'summary'` tier. All `StoredSession` fields are preserved
 * (superset contract), plus computed aggregates derived from the session's sets.
 */
export interface SessionListEntrySummary extends StoredSession {
  /** Number of sets recorded in this session. */
  setCount: number;
  /** Total reps across all sets. */
  totalReps: number;
  /**
   * Maximum `weightLbs` across all sets, or `null` when no sets exist.
   * Useful as a headline "top weight" for session history displays.
   */
  topWeightLbs: number | null;
  /**
   * Distinct training modes used across all sets, in order of first appearance.
   * Empty when no sets exist.
   */
  trainingModes: string[];
  /**
   * Session wall-clock duration in milliseconds (`endedAt - startedAt`).
   * `null` when `endedAt` is not yet set (session still active) or when
   * either timestamp fails to parse.
   */
  totalDurationMs: number | null;
}

/**
 * Full session entry: all summary fields PLUS the complete sets array.
 * Returned by `session.list { detail: 'full' }`.
 */
export interface SessionListEntryFull extends SessionListEntrySummary {
  sets: StoredSet[];
}

/**
 * Compute aggregate fields for a single session given its sets.
 * Returns a `SessionListEntrySummary` — the full `StoredSession` shape
 * plus the computed aggregates.
 */
export function aggregateSession(
  session: StoredSession,
  sets: StoredSet[],
): SessionListEntrySummary {
  const setCount = sets.length;
  const totalReps = sets.reduce((acc, s) => acc + s.reps.length, 0);

  let topWeightLbs: number | null = null;
  if (sets.length > 0) {
    topWeightLbs = Math.max(...sets.map((s) => s.weightLbs));
  }

  // Preserve insertion order while deduplicating (first-appearance ordering).
  const seen = new Set<string>();
  const trainingModes: string[] = [];
  for (const s of sets) {
    if (!seen.has(s.trainingMode)) {
      seen.add(s.trainingMode);
      trainingModes.push(s.trainingMode);
    }
  }

  let totalDurationMs: number | null = null;
  if (session.endedAt !== undefined) {
    const start = Date.parse(session.startedAt);
    const end = Date.parse(session.endedAt);
    if (!isNaN(start) && !isNaN(end)) {
      totalDurationMs = end - start;
    }
  }

  return {
    ...session,
    setCount,
    totalReps,
    topWeightLbs,
    trainingModes,
    totalDurationMs,
  };
}

/**
 * Produce the full-detail entry for a session (summary fields + sets array).
 */
export function aggregateSessionFull(
  session: StoredSession,
  sets: StoredSet[],
): SessionListEntryFull {
  return { ...aggregateSession(session, sets), sets };
}
