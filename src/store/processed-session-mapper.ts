// Maps stored session/set rows to WA's `ProcessedSession` shape (VW-144/145)
// for the cross-session `history.*` pipelines in `metrics-tools.ts`.
//
// This is the ONLY new analytics-adjacent logic this feature adds — every
// downstream consumer of a `ProcessedSession` (`buildTimeSeries`,
// `analyzeTrend`, `detectPlateau`, and WA's own `getWeeklySummaries` /
// `getVolumeByMuscleGroup` once they are reachable — see the w3-29 BLOCKED
// report) is `@voltras/workout-analytics`, untouched.

import {
  estimateE1RMFromReps,
  type ProcessedSession,
  type ProcessedSet,
} from '@voltras/workout-analytics';
import { setPurposeOf } from './set-purpose.js';
import type { StoredSet } from './types.js';

/** The session-level fields the mapper needs — a subset of `StoredSession`. */
export interface ProcessedSessionSource {
  id: string;
  startedAt: string;
  exerciseId?: string;
}

/** The device counts; the derived rep array is the fallback when it did not. */
function repCountOf(set: StoredSet): number {
  return set.firmwareRepCount ?? set.reps.length;
}

/**
 * One stored set to WA's `ProcessedSet`, or `undefined` when it carries no
 * finite `weightLbs` — a Band/Damper/Isokinetic set has no real load to report
 * a top-load, volume or e1RM figure against, and `?? 0` would read as "lifted
 * nothing" rather than "nothing recorded", corrupting every metric that takes
 * a max or a sum over the group.
 */
function toProcessedSet(set: StoredSet): ProcessedSet | undefined {
  if (!Number.isFinite(set.weightLbs)) return undefined;
  const weightLbs = set.weightLbs as number;
  const repCount = repCountOf(set);
  return {
    weightLbs,
    repCount,
    ...(repCount > 0 ? { estimated1rm: estimateE1RMFromReps(weightLbs, repCount).e1RM } : {}),
  };
}

/**
 * One session's raw sets to a `ProcessedSession`, or `undefined` when nothing
 * survives filtering (an all-warmup session, an all-guest session, or one
 * where every set was weightless).
 *
 * Three filters, applied in this order:
 *   1. Guests (VW-169): a set with a `lifter` is not this owner's training
 *      dose, whoever queried it.
 *   2. Warm-ups: `setPurposeOf(set) !== 'working'` drops warmup/probe/
 *      technique rows the same way `session.volume`'s `setsByTargetMuscle`
 *      does — the EXPLICIT purpose only, no top-load re-ranking (that
 *      heuristic lives in `selectWorkingSets` for single-exercise groups and
 *      would mis-rank a multi-exercise session's accessory work as "warmup").
 *   3. Weightless sets (see `toProcessedSet`).
 *
 * Bilateral L/R rows are NOT collapsed: each row maps to its own `ProcessedSet`
 * one-for-one, exactly how `session.volume`'s `computeVolume` sums every row
 * it is given rather than merging a pair first.
 */
export function toProcessedSession(
  session: ProcessedSessionSource,
  rawSets: readonly StoredSet[],
): ProcessedSession | undefined {
  const sets: ProcessedSet[] = [];
  for (const set of rawSets) {
    if (set.lifter !== undefined) continue;
    if (setPurposeOf(set) !== 'working') continue;
    const processed = toProcessedSet(set);
    if (processed !== undefined) sets.push(processed);
  }
  if (sets.length === 0) return undefined;
  return {
    id: session.id,
    startedAt: session.startedAt,
    ...(session.exerciseId !== undefined ? { exerciseId: session.exerciseId } : {}),
    sets,
  };
}

/**
 * `toProcessedSession` over many sessions, dropping the ones that map to
 * nothing. `setsBySession` keys on `ProcessedSessionSource.id`; a session with
 * no entry maps as if it had no sets at all.
 */
export function toProcessedSessions(
  sessions: readonly ProcessedSessionSource[],
  setsBySession: ReadonlyMap<string, readonly StoredSet[]>,
): ProcessedSession[] {
  const out: ProcessedSession[] = [];
  for (const session of sessions) {
    const mapped = toProcessedSession(session, setsBySession.get(session.id) ?? []);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/** Group a flat set list (e.g. from `getSetsForExercise`) by `sessionId`. */
export function groupBySessionId(sets: readonly StoredSet[]): Map<string, StoredSet[]> {
  const map = new Map<string, StoredSet[]>();
  for (const set of sets) {
    const group = map.get(set.sessionId);
    if (group) group.push(set);
    else map.set(set.sessionId, [set]);
  }
  return map;
}
