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
//
// ANSWERS (VW-594). `recordDeloadResponse` files the lifter's accept or decline
// as one `advisory_decisions` row and writes nothing else. An answered rung
// reads `suppressed` until a newer session changes the evidence it was filed
// against.

import type { MrvGuardVerdict, MrvUnderperformanceVerdict } from '@voltras/workout-analytics';

import {
  DELOAD_LADDER_CONSTANTS,
  selectDeloadRung,
  type DeloadAdvisory,
  type DeloadEvidence,
  type DeloadMuscleSignal,
  type DeloadRung,
  type PriorLadderDecision,
} from '../analytics/deload-ladder.js';
import type { ExerciseService } from '../exercises/exercise-service.js';
import { mapCatalogMuscle, type TitanMuscleGroup } from '../exercises/muscle-map.js';
import type { ServerState } from '../state/server-state.js';
import { checkMrvGuard } from '../store/mrv-guard.js';
import { isEligibleForComparison, scopeSetsToLifter } from '../store/set-scope.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredAdvisoryDecision,
  type StoredSet,
} from '../store/types.js';
import { getTierSignal, type TierSignalState } from './tier-signal.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sessions one MRV check compares: two consecutive pairs. */
const SESSIONS_PER_CHECK = 3;

/** Generous ceiling on owner sessions read from one rolling window. */
const WINDOW_SESSION_LIMIT = 500;

export type DeloadAdvisoryDeps = Pick<ServerState, 'store'> & {
  exercises: Pick<ExerciseService, 'getById'>;
};

/** The `advisory_decisions` code a ladder advisory is filed under. */
export const DELOAD_LADDER_CODE = 'deload_ladder';

const LADDER_RUNGS: readonly string[] = [
  'recovery_session',
  'recovery_half_week',
  'deload_week',
] satisfies DeloadRung[];

export type BuildDeloadAdvisoryDeps = DeloadAdvisoryDeps & TierSignalState;

export interface DeloadAdvisoryContext {
  now: Date;
  /** The planned week in force, or the week of the workout about to be trained, is a deload week. */
  currentWeekIsDeload: boolean;
}

type AdvisoryCore = Pick<DeloadAdvisory, 'status' | 'rung' | 'reasoning' | 'userMessage'>;

/** The tool that files the lifter's answer to an advised rung. */
export const RESPOND_DELOAD_TOOL = 'plan.respond_deload_advisory';

/** The read on `advise`: reproducible, and naming the tool that files the answer. */
type AdviseRead = AdvisoryCore &
  Pick<DeloadAdvisory, 'muscles' | 'thresholdsUsed' | 'algorithmVersion'> & {
    respondWith: typeof RESPOND_DELOAD_TOOL;
  };

/**
 * The advisory as `plan.next_workout` emits it. Only `advise` carries the
 * thresholds and version that make it reproducible and the tool that answers
 * it, and only `advise` and `watching` name muscles: a silent read costs the
 * sitting as few tokens as it can.
 */
export type DeloadAdvisoryRead =
  | AdvisoryCore
  | (AdvisoryCore & Pick<DeloadAdvisory, 'muscles'>)
  | AdviseRead;

/** The ladder advisory as it stands at `now`, always explained, never applied. */
export async function buildDeloadAdvisory(
  deps: BuildDeloadAdvisoryDeps,
  context: DeloadAdvisoryContext,
): Promise<DeloadAdvisoryRead> {
  const muscles = await collectDeloadBreaches(deps, context.now);
  const tier = await getTierSignal(deps, LOCAL_USER_ID, context.now.toISOString());
  const decisions = await deps.store.listAdvisoryDecisions(LOCAL_USER_ID, {
    code: DELOAD_LADDER_CODE,
  });
  const advisory = selectDeloadRung({
    muscles,
    tier: { tier: tier.tier, confidence: tier.confidence },
    currentWeekIsDeload: context.currentWeekIsDeload,
    priorDecisions: toPriorLadderDecisions(decisions),
    now: context.now,
  });
  const answer = advisory.status === 'advise' ? findAnswer(decisions, advisory) : undefined;
  return answer === undefined ? toAdvisoryRead(advisory) : answeredVerdict(answer);
}

function toAdvisoryRead(advisory: DeloadAdvisory): DeloadAdvisoryRead {
  const { status, rung, reasoning, userMessage, muscles } = advisory;
  const core = { status, rung, reasoning, userMessage };
  if (status === 'advise') {
    const { thresholdsUsed, algorithmVersion } = advisory;
    return { ...core, muscles, thresholdsUsed, algorithmVersion, respondWith: RESPOND_DELOAD_TOOL };
  }
  return status === 'watching' ? { ...core, muscles } : core;
}

function isAdviseRead(read: DeloadAdvisoryRead): read is AdviseRead {
  return read.status === 'advise' && 'respondWith' in read;
}

/** What an answer is filed against: each confirmed muscle and the sessions that confirmed it. */
function answeredEvidence(muscles: DeloadAdvisory['muscles']): Record<string, unknown>[] {
  return muscles
    .filter((signal) => signal.state === 'confirmed')
    .map(({ muscle, evidence }) => ({
      muscle,
      evidence: evidence.map(({ exerciseId, sessionIds }) => ({
        exerciseId,
        sessionIds: [...sessionIds],
      })),
    }));
}

/**
 * The newest answer filed against exactly this evidence. Any later session of
 * a confirmed muscle changes its session ids, which is what re-offers the rung.
 */
function findAnswer(
  decisions: readonly StoredAdvisoryDecision[],
  advisory: DeloadAdvisory,
): StoredAdvisoryDecision | undefined {
  const evidence = JSON.stringify(answeredEvidence(advisory.muscles));
  return decisions.find(
    (decision) =>
      (decision.userResponse === 'accepted' || decision.userResponse === 'declined') &&
      JSON.stringify(decision.inputs.muscles) === evidence,
  );
}

function answeredVerdict(answer: StoredAdvisoryDecision): DeloadAdvisoryRead {
  const rung = answer.verdict.replaceAll('_', ' ');
  const day = answer.issuedAt.slice(0, 10);
  return {
    status: 'suppressed',
    rung: null,
    reasoning: `The lifter ${answer.userResponse ?? 'answered'} the ${rung} advised on ${day} on this same evidence, so it is not offered again until a newer session of a confirmed muscle comes in.`,
    userMessage:
      answer.userResponse === 'declined'
        ? `You turned down the ${rung} on this evidence. It comes back only if a newer session shows the decline again.`
        : `You already said yes to the ${rung} on this evidence. Nothing in the plan was changed for you.`,
  };
}

/**
 * File the lifter's answer to the rung open in `read`. Writes one decision row
 * and nothing else: accepting records a yes and leaves the plan as it is.
 */
export async function recordDeloadResponse(
  store: SessionStore,
  read: DeloadAdvisoryRead,
  response: 'accepted' | 'declined',
  now: Date,
): Promise<{ recorded: boolean; reason: string }> {
  if (!isAdviseRead(read) || read.rung === null) {
    return { recorded: false, reason: `No ladder rung is open: ${read.reasoning}` };
  }
  const at = now.toISOString();
  await store.putAdvisoryDecision({
    userId: LOCAL_USER_ID,
    code: DELOAD_LADDER_CODE,
    issuedAt: at,
    inputs: { muscles: answeredEvidence(read.muscles) },
    thresholds: read.thresholdsUsed,
    algorithmVersion: read.algorithmVersion,
    verdict: read.rung,
    userResponse: response,
    respondedAt: at,
  });
  return {
    recorded: true,
    reason:
      response === 'declined'
        ? 'Declined and filed. The same evidence is not re-offered; a newer session that confirms the decline again re-opens it.'
        : 'Filed. Nothing in the plan changed: flag a deload week or lighten a session with the plan tools if the lifter wants it applied.',
  };
}

function toPriorLadderDecisions(
  decisions: readonly StoredAdvisoryDecision[],
): PriorLadderDecision[] {
  return decisions.flatMap((decision) =>
    isLadderRung(decision.verdict)
      ? [
          {
            rung: decision.verdict,
            advisedAt: decision.issuedAt,
            response: decision.userResponse ?? null,
          },
        ]
      : [],
  );
}

function isLadderRung(verdict: string): verdict is DeloadRung {
  return LADDER_RUNGS.includes(verdict);
}

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
