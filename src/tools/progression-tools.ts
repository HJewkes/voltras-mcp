// `progression.*` tool handlers.
//
// `progression.get_for_exercise` aggregates session/set history for an
// exercise over a lookback window and returns top-weight + volume trends.
// It is the primary answer to "what did I hit last time?" without requiring
// the caller to loop through individual `session.get` responses (which can
// be 182 KB per session at scale).
//
// Implementation notes:
//   - Session discovery (VMCP-01.72b, H1): one `getSetsForExercise` call
//     finds every matching SET in the window, deduped to distinct session
//     ids and sliced to the most-recent `limit` (see the BEHAVIOR CHANGE
//     comment at the slice site — this is newest-N, not oldest-N). Then N+1:
//     one `getSession` + one `getSetsForSession` per session id. Acceptable
//     at this scale (called once per session-start, default cap of 20
//     sessions). A `getSession` that returns `undefined` silently drops that
//     session from the result rather than erroring — the id came from a real
//     set a moment earlier, so this should not happen in practice, but a
//     caller relying on `sessionCount` matching `limitedSessionIds.length`
//     should know it isn't guaranteed.
//   - Lookback window is computed in UTC from the current wall clock at
//     handler invocation time.
//   - `exerciseId` is NOT validated against the exercise catalog — we treat
//     any id as a valid filter key so callers can query historical data for
//     exercises that were renamed or removed from the catalog.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { type ServerState } from '../state/server-state.js';
import { chooseComparisonPartner, type ComparabilityReport } from '../analytics/comparability.js';
import {
  buildComparabilitySubjectGroups,
  type ComparabilitySubjectFetchers,
} from '../analytics/comparability-subject.js';
import { ProgressionGetInput } from '../schemas/progression.js';
import { aggregateProgression } from '../state/progression-aggregator.js';
import { setPurposeOf } from '../store/set-purpose.js';
import { scopeSessionSetsToExerciseId, scopeSetsToLifter } from '../store/set-scope.js';
import {
  LOCAL_USER_ID,
  type StoredSession,
  type StoredSet,
  type StoredSide,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';

const DEFAULT_LOOKBACK_WEEKS = 8;
const DEFAULT_LIMIT = 20;

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Register `progression.get_for_exercise`.
 *
 * Uses the same placeholder-replace pattern as `session-tools.ts`: the
 * real handler is hot-swapped into the pre-registered placeholder via
 * `RegisteredTool.update({ paramsSchema, callback })`.
 */
const PROGRESSION_GET_DESCRIPTION =
  'Answer "what did I hit last time on this exercise?" by aggregating the most recent sessions ' +
  '(default: last 20 within an 8-week lookback, both overridable) that trained the given ' +
  'exerciseId — top weight and volume trends across those sessions. Cheaper than looping ' +
  '`session.get` calls yourself (a single session response can be large). `exerciseId` is not ' +
  'validated against the catalog, so historical data for a renamed/removed exercise still works. ' +
  '`side` (VMCP-04.09) narrows the same history to one arm; omitted, the response covers both ' +
  'and adds a `sideSplit` summary when any set in range carries a side. `comparability` (VW-94) ' +
  'names the most recent earlier session whose top set is like-vs-like with the latest one — the ' +
  'basis a progress claim may rest on. `trend` spans the whole window regardless, so when ' +
  '`comparability` reports `noValidComparison` say what changed (its `nearest.reasons`) rather ' +
  'than presenting the trend delta as progress.';

export function registerProgressionTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'progression.get_for_exercise',
    ProgressionGetInput,
    wrapHandler(ProgressionGetInput, (input) => getProgressionForExercise(state, input)),
    PROGRESSION_GET_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

async function getProgressionForExercise(
  state: ServerState,
  input: z.infer<typeof ProgressionGetInput>,
): Promise<unknown> {
  const lookbackWeeks = input.lookbackWeeks ?? DEFAULT_LOOKBACK_WEEKS;
  const limit = input.limit ?? DEFAULT_LIMIT;

  const windowEndedAt = new Date().toISOString();
  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - lookbackWeeks * 7);
  const windowStartedAt = windowStart.toISOString();

  // VMCP-01.72b (H1): pick candidate SESSIONS by each SET's own exerciseId,
  // not by the session row's single `exercise_id` column. That column is
  // last-write-wins once `session.set_exercise` lets one session hold
  // several exercises — a session that trained squat then bench would
  // persist with `exercise_id: 'bench-press'`, and a `listSessions({
  // exerciseId: 'back-squat' })` filter would silently miss it entirely
  // (not "wrong sets" — "session never considered"). `getSetsForExercise`
  // reads the set-level column, which is authoritative.
  const exerciseSets = await state.store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId: input.exerciseId,
    from: windowStartedAt,
    to: windowEndedAt,
    // VW-169: omitted ⇒ the owner's sets only. A guest working in on a shared
    // rig would otherwise land in the owner's top-weight and volume trends.
    ...(input.lifter !== undefined ? { lifter: input.lifter } : {}),
    // VMCP-04.09: omitted ⇒ both sides, matching metrics.compute's default.
    ...(input.side !== undefined ? { side: input.side } : {}),
  });
  // Ascending (matches getSetsForExercise's ORDER BY started_at ASC); dedupe
  // to distinct sessions, then keep the most-recent `limit` — this is also
  // the exercise-instance count: one entry per session that trained this
  // exercise, decoupled from what else that session held.
  //
  // BEHAVIOR CHANGE (VMCP-01.72b S7, undocumented until now): pre-H1, `main`
  // fetched `listSessions({ sort: 'startedAt:asc', limit })`, i.e. SQL
  // `ORDER BY started_at ASC LIMIT N` — the OLDEST N sessions in the window
  // when there were more than `limit` matches. `.slice(-limit)` on an
  // ascending array keeps the NEWEST N instead. This is very likely the
  // right fix on its own — "what did I hit last time?" wants the most
  // recent training, not the earliest sessions in an 8-week window — but it
  // changes `topWeightLbsFirst`/`Last` and every trend delta for anyone with
  // more than `limit` sessions of one exercise in the window. Flagging here
  // because the H1 rewrite (session discovery by set, not by session row)
  // made this an unavoidable side effect, not a deliberate independent
  // decision — a future change to the discovery mechanism must not silently
  // flip it back.
  const sessionIdsInOrder = [...new Set(exerciseSets.map((s) => s.sessionId))];
  const limitedSessionIds = sessionIdsInOrder.slice(-limit);

  const sessions = (
    await Promise.all(limitedSessionIds.map((id) => state.store.getSession(id)))
  ).filter((s): s is StoredSession => s !== undefined);

  // N+1: one getSetsForSession call per session. Acceptable for v1.
  // Each session's FULL set list is fetched (not just this exercise's sets)
  // because `scopeSessionSetsToExerciseId` needs the whole list to judge
  // whether the session is single- or multi-exercise before it can decide
  // whether an unattributed set is safe to keep.
  const exerciseScopedSetsBySessionId = new Map<string, StoredSet[]>();
  for (const id of limitedSessionIds) {
    // VW-169: the lifter scope comes FIRST. `getSetsForSession` returns the
    // whole session, and one session can hold both the owner's sets and a
    // guest's — the exercise scoping below cannot tell them apart.
    const allSetsInSession = scopeSetsToLifter(
      await state.store.getSetsForSession(id),
      input.lifter,
    );
    exerciseScopedSetsBySessionId.set(
      id,
      scopeSessionSetsToExerciseId(allSetsInSession, input.exerciseId),
    );
  }

  // VMCP-04.09: the side filter narrows the same per-session sets used for
  // the main aggregation, applied AFTER exercise scoping so the H2
  // unattributed-set leniency still sees the session's full exercise context.
  const setsBySessionId =
    input.side === undefined
      ? exerciseScopedSetsBySessionId
      : filterSetsBySide(exerciseScopedSetsBySessionId, input.side);

  const response = aggregateProgression(
    input.exerciseId,
    windowStartedAt,
    windowEndedAt,
    sessions,
    setsBySessionId,
  );

  return {
    ...response,
    side: input.side,
    comparability: await pickProgressionBasis(state, limitedSessionIds, setsBySessionId),
    ...(input.side === undefined
      ? { sideSplit: computeSideSplit(limitedSessionIds, exerciseScopedSetsBySessionId) }
      : {}),
  };
}

/** The like-vs-like basis for the window, or why the window has none. */
type ProgressionComparability = ComparabilityReport & { basisSetId?: string };

/**
 * VW-94: name the most recent EARLIER session whose top set is like-vs-like
 * with the latest one — the basis a "you're getting stronger" claim may rest
 * on.
 *
 * `trend` above is deliberately unchanged: it still spans the window's first
 * and last session unconditionally, because narrowing it would silently change
 * every existing caller's numbers. This block is the honest second opinion
 * beside it, and with no valid basis it still names the nearest session's top
 * set and the reasons it failed.
 */
async function pickProgressionBasis(
  state: ServerState,
  sessionIdsOldestFirst: readonly string[],
  setsBySessionId: Map<string, StoredSet[]>,
): Promise<ProgressionComparability> {
  const newestFirst = [...sessionIdsOldestFirst].reverse();
  const [latestId, ...earlierIds] = newestFirst;
  if (latestId === undefined) return { noValidComparison: true };

  // VW-211: every session here is already scoped to ONE exercise
  // (`setsBySessionId`), so each is its own group for `setIndexInExercise`.
  const relevantIds = [latestId, ...earlierIds];
  const enrichedGroups = await buildComparabilitySubjectGroups(
    relevantIds.map((id) => setsBySessionId.get(id) ?? []),
    comparabilitySubjectFetchers(state),
  );
  const enrichedBySessionId = new Map(relevantIds.map((id, i) => [id, enrichedGroups[i]!]));

  const basis = topWorkingSet(enrichedBySessionId.get(latestId));
  if (basis === undefined) return { noValidComparison: true };

  const candidates = earlierIds
    .map((id) => topWorkingSet(enrichedBySessionId.get(id)))
    .filter((set): set is NonNullable<typeof set> => set !== undefined);
  return { basisSetId: basis.id, ...chooseComparisonPartner(basis, candidates) };
}

/**
 * VW-211: wires the comparability v2 subject fields' store reads to this
 * server's store and exercise catalog — same wiring as
 * `metrics-tools.ts`'s `comparabilitySubjectFetchers`, duplicated rather than
 * shared so this file's store access stays self-contained.
 */
function comparabilitySubjectFetchers(state: ServerState): ComparabilitySubjectFetchers {
  return {
    getSetsForExercise: (exerciseId, lifter) =>
      state.store.getSetsForExercise({
        userId: LOCAL_USER_ID,
        exerciseId,
        ...(lifter !== undefined ? { lifter } : {}),
      }),
    getFirstSessionStartedAt: async (lifter) =>
      (await state.store.getSessionDateSpan(lifter !== undefined ? { lifter } : {})).first,
    getLifterSessionExerciseIds: async (lifter) =>
      (await state.store.listSessions(lifter !== undefined ? { lifter } : {})).map(
        (s) => s.exerciseId,
      ),
    primaryMuscleOf: (exerciseId) => state.exercises.getById(exerciseId)?.muscleGroups[0],
  };
}

/**
 * A session's heaviest WORKING set — the one its top-weight figure comes from.
 * Warm-ups, probes and weightless sets are excluded, matching what the
 * aggregator counts as a top weight.
 */
function topWorkingSet<T extends StoredSet>(sets: readonly T[] | undefined): T | undefined {
  const working = (sets ?? []).filter(
    (set) => setPurposeOf(set) === 'working' && set.weightLbs !== undefined,
  );
  if (working.length === 0) return undefined;
  return working.reduce((top, set) => ((set.weightLbs ?? 0) > (top.weightLbs ?? 0) ? set : top));
}

function filterSetsBySide(
  setsBySessionId: Map<string, StoredSet[]>,
  side: StoredSide,
): Map<string, StoredSet[]> {
  return new Map(
    [...setsBySessionId].map(([id, sets]) => [id, sets.filter((s) => s.side === side)]),
  );
}

/** Per-side set count and last-session top load; `undefined` when no set in range has a `side`. */
interface SideSplitSummary {
  setCount: number;
  lastSessionTopWeightLbs: number;
}

// VMCP-04.09: derived from the same `setsBySessionId` the aggregator already
// consumes — not a second store query — since bilateral rows already carry
// their own resolved `side`, no bilateral-group dedup is needed to split them.
function computeSideSplit(
  limitedSessionIds: string[],
  setsBySessionId: Map<string, StoredSet[]>,
): { left: SideSplitSummary; right: SideSplitSummary } | undefined {
  const allSets = limitedSessionIds.flatMap((id) => setsBySessionId.get(id) ?? []);
  if (!allSets.some((s) => s.side !== undefined)) return undefined;

  const lastSessionSets =
    setsBySessionId.get(limitedSessionIds[limitedSessionIds.length - 1]) ?? [];
  return {
    left: sideSplitSummary(allSets, lastSessionSets, 'left'),
    right: sideSplitSummary(allSets, lastSessionSets, 'right'),
  };
}

function sideSplitSummary(
  allSets: StoredSet[],
  lastSessionSets: StoredSet[],
  side: StoredSide,
): SideSplitSummary {
  const lastSessionTopWeightLbs = lastSessionSets
    .filter((s) => s.side === side)
    .reduce((max, s) => (s.weightLbs !== undefined && s.weightLbs > max ? s.weightLbs : max), 0);
  return {
    setCount: allSets.filter((s) => s.side === side).length,
    lastSessionTopWeightLbs,
  };
}
