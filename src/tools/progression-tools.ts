// `progression.*` tool handlers.
//
// `progression.get_for_exercise` aggregates session/set history for an
// exercise over a lookback window and returns top-weight + volume trends.
// It is the primary answer to "what did I hit last time?" without requiring
// the caller to loop through individual `session.get` responses (which can
// be 182 KB per session at scale).
//
// Implementation notes:
//   - N+1 query pattern: one `listSessions` call + one `getSetsForSession`
//     per returned session. Acceptable at this scale (called once per
//     session-start, default cap of 20 sessions). A future join-query path
//     in `SessionStore` can replace this without changing the aggregator.
//   - Lookback window is computed in UTC from the current wall clock at
//     handler invocation time.
//   - `exerciseId` is NOT validated against the exercise catalog — we treat
//     any id as a valid filter key so callers can query historical data for
//     exercises that were renamed or removed from the catalog.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { type ServerState } from '../state/server-state.js';
import { ProgressionGetInput } from '../schemas/progression.js';
import { aggregateProgression } from '../state/progression-aggregator.js';
import { scopeSessionSetsToExerciseId } from '../store/set-scope.js';
import { LOCAL_USER_ID } from '../store/sqlite-store.js';
import type { StoredSession, StoredSet } from '../store/types.js';
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
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
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
  });
  // Ascending (matches getSetsForExercise's ORDER BY started_at ASC); dedupe
  // to distinct sessions, then keep the most-recent `limit` — this is also
  // the exercise-instance count: one entry per session that trained this
  // exercise, decoupled from what else that session held.
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
  const setsBySessionId = new Map<string, StoredSet[]>();
  for (const id of limitedSessionIds) {
    const allSetsInSession = await state.store.getSetsForSession(id);
    setsBySessionId.set(id, scopeSessionSetsToExerciseId(allSetsInSession, input.exerciseId));
  }

  return aggregateProgression(
    input.exerciseId,
    windowStartedAt,
    windowEndedAt,
    sessions,
    setsBySessionId,
  );
}
