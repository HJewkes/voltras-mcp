// VW-592 (VW-139 S2): the store side of the deload advisory. Finds, per
// body-map muscle, whether measured performance fell two sessions in a row.
//
// THE RUNG IS DECIDED ELSEWHERE. `analytics/deload-ladder.ts` turns these
// per-muscle states into an advisory; this file only reads the store and calls
// `checkMrvGuard` in-process, which is the consumption path VW-131 sanctioned.
//
// NO CLOCK READS. `now` is passed in, so the same store and the same instant
// always yield the same breaches.
//
// ONE SET FILTER. Owner-only and training-only come from the store's own
// defaults; warm-up, probe and technique sets are dropped by
// `isEligibleForComparison`, the filter the drift and MRV guards already use.

import type { MrvGuardVerdict, MrvUnderperformanceVerdict } from '@voltras/workout-analytics';

import {
  DELOAD_LADDER_CONSTANTS,
  type DeloadEvidence,
  type DeloadMuscleSignal,
} from '../analytics/deload-ladder.js';
import type { ExerciseService } from '../exercises/exercise-service.js';
import { mapCatalogMuscle, type TitanMuscleGroup } from '../exercises/muscle-map.js';
import type { ServerState } from '../state/server-state.js';
import { checkMrvGuard } from '../store/mrv-guard.js';
import { isEligibleForComparison, scopeSetsToLifter } from '../store/set-scope.js';
import { LOCAL_USER_ID, type SessionStore, type StoredSet } from '../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sessions one MRV check compares: two consecutive pairs. */
const SESSIONS_PER_CHECK = 3;

/** Generous ceiling on owner sessions read from one rolling window. */
const WINDOW_SESSION_LIMIT = 500;

export type DeloadAdvisoryDeps = Pick<ServerState, 'store'> & {
  exercises: Pick<ExerciseService, 'getById'>;
};

/** One owner session of one exercise, stamped with its newest working set. */
interface ExerciseSession {
  sessionId: string;
  lastSetAt: string;
}

/** One exercise's MRV check over its last three owner sessions. */
interface ExerciseCheck {
  evidence: DeloadEvidence;
  confirmedAt: string;
  priorPair: MrvUnderperformanceVerdict;
  currentPair: MrvUnderperformanceVerdict;
  guard: MrvGuardVerdict;
}

/**
 * Per-muscle performance states for every body-map muscle the owner trained in
 * the rolling window ending at `now`, ready for `selectDeloadRung`.
 */
export async function collectDeloadBreaches(
  deps: DeloadAdvisoryDeps,
  now: Date,
): Promise<DeloadMuscleSignal[]> {
  const exerciseIds = await exercisesTrainedInWindow(deps.store, now);
  const checks = new Map<string, ExerciseCheck>();
  for (const exerciseId of exerciseIds) {
    const check = await checkExercise(deps.store, exerciseId, now);
    if (check !== undefined) checks.set(exerciseId, check);
  }
  return [...groupByPrimaryMuscle(deps.exercises, exerciseIds)].map(([muscle, ids]) =>
    muscleSignal(
      muscle,
      ids.flatMap((id) => checks.get(id) ?? []),
    ),
  );
}

/** Exercises with an owner working set in a training session inside the window. */
async function exercisesTrainedInWindow(store: SessionStore, now: Date): Promise<string[]> {
  const from = new Date(now.getTime() - DELOAD_LADDER_CONSTANTS.rollingWindowDays * DAY_MS);
  const sessions = await store.listSessions({
    from: from.toISOString(),
    to: now.toISOString(),
    limit: WINDOW_SESSION_LIMIT,
  });
  const ids = new Set<string>();
  for (const session of sessions) {
    const owned = scopeSetsToLifter(await store.getSetsForSession(session.id), undefined);
    for (const set of owned.filter(isWorkingSet)) {
      if (set.exerciseId !== undefined) ids.add(set.exerciseId);
    }
  }
  return [...ids].sort();
}

function isWorkingSet(set: StoredSet): boolean {
  return isEligibleForComparison(set, {});
}

/** `checkMrvGuard` over the exercise's last three owner sessions, or nothing with fewer. */
async function checkExercise(
  store: SessionStore,
  exerciseId: string,
  now: Date,
): Promise<ExerciseCheck | undefined> {
  const sessions = await recentSessions(store, exerciseId, now);
  if (sessions.length < SESSIONS_PER_CHECK) return undefined;
  const [first, second, third] = sessions.slice(-SESSIONS_PER_CHECK) as [
    ExerciseSession,
    ExerciseSession,
    ExerciseSession,
  ];
  const result = await checkMrvGuard(store, {
    key: { userId: LOCAL_USER_ID, exerciseId },
    session1Id: first.sessionId,
    session2Id: second.sessionId,
    session3Id: third.sessionId,
  });
  return {
    ...result,
    confirmedAt: third.lastSetAt,
    evidence: {
      exerciseId,
      sessionIds: [first.sessionId, second.sessionId, third.sessionId],
      reasoning: result.guard.reasoning,
    },
  };
}

/** Distinct owner sessions with a working set of the exercise, oldest first, none after `now`. */
async function recentSessions(
  store: SessionStore,
  exerciseId: string,
  now: Date,
): Promise<ExerciseSession[]> {
  const sets = await store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId,
    to: now.toISOString(),
  });
  const lastSetAt = new Map<string, string>();
  for (const set of sets.filter(isWorkingSet)) {
    const seen = lastSetAt.get(set.sessionId);
    if (seen === undefined || set.startedAt > seen) lastSetAt.set(set.sessionId, set.startedAt);
  }
  return [...lastSetAt]
    .map(([sessionId, at]) => ({ sessionId, lastSetAt: at }))
    .sort((a, b) => a.lastSetAt.localeCompare(b.lastSetAt));
}

/** Exercise ids under each body-map muscle their catalog entry names as primary. */
function groupByPrimaryMuscle(
  exercises: DeloadAdvisoryDeps['exercises'],
  exerciseIds: readonly string[],
): Map<TitanMuscleGroup, string[]> {
  const byMuscle = new Map<TitanMuscleGroup, string[]>();
  for (const exerciseId of exerciseIds) {
    const primaries = exercises.getById(exerciseId)?.muscleGroups ?? [];
    const muscles = new Set(primaries.flatMap((group) => mapCatalogMuscle(group)));
    for (const muscle of muscles)
      byMuscle.set(muscle, [...(byMuscle.get(muscle) ?? []), exerciseId]);
  }
  return byMuscle;
}

function muscleSignal(muscle: string, checks: readonly ExerciseCheck[]): DeloadMuscleSignal {
  const evidence = checks.map((check) => check.evidence);
  const flagged = checks.filter((check) => check.guard.mrvFlagged);
  if (flagged.length > 0) {
    if (hasCounterEvidence(checks)) return { muscle, evidence, state: 'provisional' };
    const confirmedAt = flagged.map((check) => check.confirmedAt).sort()[flagged.length - 1];
    return { muscle, evidence, state: 'confirmed', confirmedAt: confirmedAt as string };
  }
  if (checks.some(isSingleMiss)) return { muscle, evidence, state: 'provisional' };
  if (checks.some(hasEvaluablePair)) return { muscle, evidence, state: 'clear' };
  return { muscle, evidence, state: 'inconclusive' };
}

/**
 * Q5: a confirmation stands only if no sibling primary exercise of the same
 * muscle improved over the same window, because a false positive costs real
 * training. Changing the owner's answer to Q5 changes this one function.
 */
function hasCounterEvidence(checks: readonly ExerciseCheck[]): boolean {
  return checks.some((check) => !check.guard.mrvFlagged && improved(check.currentPair));
}

/** The newest pair was evaluable, held, and moved more volume than the week before. */
function improved(pair: MrvUnderperformanceVerdict): boolean {
  return pair.evaluable && !pair.underperformed && pair.volumeLoadDeltaPct > 0;
}

function isSingleMiss(check: ExerciseCheck): boolean {
  const misses = [check.priorPair, check.currentPair].filter(
    (pair) => pair.evaluable && pair.underperformed,
  );
  return misses.length === 1;
}

function hasEvaluablePair(check: ExerciseCheck): boolean {
  return check.priorPair.evaluable || check.currentPair.evaluable;
}
