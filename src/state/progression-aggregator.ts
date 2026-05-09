// Pure aggregation logic for `progression.get_for_exercise`.
//
// Takes pre-fetched `StoredSession` and `StoredSet` arrays and computes the
// progression response shape. No I/O or SQLite access here — all reads go
// through the `SessionStore` in the tool handler, keeping this function
// independently unit-testable.
//
// Rep completion model: `totalReps` counts every rep across all sets in a
// session (including reps from partial sets). `completedReps` counts only reps
// from sets where `partial === false`, i.e. sets the user explicitly ended
// rather than sets that were auto-stopped or force-ended mid-session. This
// is the most meaningful distinction available in the store — the `Rep` type
// from `@voltras/workout-analytics` carries no per-rep completion status.

import type { StoredSession, StoredSet } from '../store/types.js';

/** Per-session aggregate returned by the tool. Sorted oldest → newest. */
export interface ProgressionSessionSummary {
  sessionId: string;
  startedAt: string;
  setCount: number;
  topWeightLbs: number;
  totalReps: number;
  completedReps: number;
  estimatedTotalVolumeLbs: number;
}

/** Trend between the first and last session. `null` when fewer than 2 sessions. */
export interface ProgressionTrend {
  topWeightLbsFirst: number;
  topWeightLbsLast: number;
  topWeightLbsDelta: number;
  topWeightLbsDeltaPct: number;
  estimatedTotalVolumeFirst: number;
  estimatedTotalVolumeLast: number;
  estimatedTotalVolumeDeltaPct: number;
}

/** Full response payload for `progression.get_for_exercise`. */
export interface ProgressionResponse {
  exerciseId: string;
  windowStartedAt: string;
  windowEndedAt: string;
  sessionCount: number;
  sessions: ProgressionSessionSummary[];
  trend: ProgressionTrend | null;
}

/**
 * Aggregate sessions and their sets into a progression response.
 *
 * `sessions` must already be filtered to the desired lookback window and
 * `exerciseId`. `setsBySessionId` maps each session id to its sets (may be
 * empty for sessions with no recorded sets). Both collections are treated as
 * immutable; no mutation occurs.
 *
 * Sessions with no sets are included with all-zero metrics — this handles
 * edge cases like sessions that ended before a set was started.
 */
export function aggregateProgression(
  exerciseId: string,
  windowStartedAt: string,
  windowEndedAt: string,
  sessions: StoredSession[],
  setsBySessionId: Map<string, StoredSet[]>,
): ProgressionResponse {
  // Sort oldest → newest for the output array and trend computation.
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const summaries: ProgressionSessionSummary[] = sorted.map((session) => {
    const sets = setsBySessionId.get(session.id) ?? [];
    return summariseSession(session.id, session.startedAt, sets);
  });

  return {
    exerciseId,
    windowStartedAt,
    windowEndedAt,
    sessionCount: summaries.length,
    sessions: summaries,
    trend: summaries.length >= 2 ? computeTrend(summaries) : null,
  };
}

function summariseSession(
  sessionId: string,
  startedAt: string,
  sets: StoredSet[],
): ProgressionSessionSummary {
  let topWeightLbs = 0;
  let totalReps = 0;
  let completedReps = 0;
  let estimatedTotalVolumeLbs = 0;

  for (const set of sets) {
    if (set.weightLbs > topWeightLbs) {
      topWeightLbs = set.weightLbs;
    }
    const repCount = set.reps.length;
    totalReps += repCount;
    // "completed" = reps from a set the user explicitly ended (not partial).
    if (!set.partial) {
      completedReps += repCount;
    }
    estimatedTotalVolumeLbs += set.weightLbs * repCount;
  }

  return {
    sessionId,
    startedAt,
    setCount: sets.length,
    topWeightLbs,
    totalReps,
    completedReps,
    estimatedTotalVolumeLbs,
  };
}

function computeTrend(summaries: ProgressionSessionSummary[]): ProgressionTrend {
  const first = summaries[0];
  const last = summaries[summaries.length - 1];

  const topWeightLbsDelta = last.topWeightLbs - first.topWeightLbs;
  const topWeightLbsDeltaPct =
    first.topWeightLbs === 0 ? 0 : (topWeightLbsDelta / first.topWeightLbs) * 100;

  const estimatedTotalVolumeDelta =
    last.estimatedTotalVolumeLbs - first.estimatedTotalVolumeLbs;
  const estimatedTotalVolumeDeltaPct =
    first.estimatedTotalVolumeLbs === 0
      ? 0
      : (estimatedTotalVolumeDelta / first.estimatedTotalVolumeLbs) * 100;

  return {
    topWeightLbsFirst: first.topWeightLbs,
    topWeightLbsLast: last.topWeightLbs,
    topWeightLbsDelta,
    topWeightLbsDeltaPct,
    estimatedTotalVolumeFirst: first.estimatedTotalVolumeLbs,
    estimatedTotalVolumeLast: last.estimatedTotalVolumeLbs,
    estimatedTotalVolumeDeltaPct,
  };
}
