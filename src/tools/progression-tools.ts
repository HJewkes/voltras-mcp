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
import {
  compareSetupSignatures,
  medianRomMetres,
  type SetupComparability,
  type SetupSignature,
} from '../analytics/setup-comparability.js';
import {
  chooseSideComparisonMetric,
  type SideComparisonMetric,
} from '../analytics/side-comparison.js';
import {
  compareSetupCards,
  getReferenceSetupCard,
  type SetupCardComparabilityVerdict,
} from '../analytics/setup-cards.js';
import { ProgressionGetInput } from '../schemas/progression.js';
import { aggregateProgression } from '../state/progression-aggregator.js';
import { clampToChapter } from '../store/exercise-chapters.js';
import { setMedianRomM } from '../store/exercise-setups.js';
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
  'than presenting the trend delta as progress. CABLE GEOMETRY GATES THE TWO SIDES (VW-272): ' +
  "`sideSplit.setupComparability` is `setup_confounded` when the two arms' median cable travel " +
  "differs by more than 1.15x, because a cable's resistance moment arm moves with its anchor, so " +
  'the same nominal load at a different anchor height is a different joint torque (Keogh, Lake & ' +
  'Swinton 2013). On that verdict do NOT read the left/right load difference as an imbalance — ' +
  "relay `sideSplit.setupReason` and `sideSplit.setupSignatures` (both sides' travel medians) " +
  'instead. `setup_unverified` means neither side recorded travel, so the check never ran. ' +
  '`setupCard` (VW-275) is a SEPARATE gate on the DECLARED setup: it compares the most recent ' +
  "session's confirmed card (anchor/mountHole/cableLengthSetting/mode) against the exercise's " +
  'reference card — the most recently confirmed one, or a digest-seeded default when nothing has ' +
  'been confirmed. `setup_card_mismatch` means a field on the two cards disagrees; say which ' +
  'field, do not treat the load difference as a training effect. `setup_card_unverified` means ' +
  'the session or the exercise has no card recorded, so the check never ran. `sideSplit.comparisonMetric` ' +
  '(VW-304) names which figure to actually compare between the two sides: `peak_force` when the ' +
  'last session recorded it on both, else `top_weight` — peak force is preferred because it is the ' +
  'only metric with good bilateral reliability in unilateral isometric squat testing (Bishop et al. ' +
  '2021, JSCR 35(2S): CV 5.44-5.70%, ICC 0.93-0.94), a finding this comparison defers to until this ' +
  "server's own data says otherwise. `sideSplit.comparisonBasis` states why in prose for this call. " +
  '`chapterStartedAt` (VW-361) is non-null when the lifter declared a new chapter for this ' +
  'exercise, and `windowStartedAt` is then CLAMPED to it: the lookback asked for is a floor, not ' +
  'a way back past a technique reform. A clamped window can come back with zero sessions — that ' +
  'is a new chapter with nothing recorded since, not an untrained exercise, and the pre-chapter ' +
  'loads are not the number to beat (rp:rp-s3-old-prs-irrelevant-reframe).';

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
  // VW-361: a declared chapter moves the window start forward, so "what did I
  // hit last time?" never answers with a load set under the old technique. The
  // lookback the caller asked for is the FLOOR, not the answer; the reported
  // `windowStartedAt` is the clamped one, so the response says which window it
  // actually read.
  const chapterStartedAt = await state.store.chapterStartedAt(LOCAL_USER_ID, input.exerciseId);
  const windowStartedAt = clampToChapter(windowStart.toISOString(), chapterStartedAt);

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
    // VW-361: null unless a chapter is declared. Non-null says the window above
    // is the clamped one, which is what keeps a zero-session answer from
    // reading as "you have never trained this".
    chapterStartedAt,
    comparability: await pickProgressionBasis(state, limitedSessionIds, setsBySessionId),
    ...(input.side === undefined
      ? { sideSplit: computeSideSplit(limitedSessionIds, exerciseScopedSetsBySessionId) }
      : {}),
    setupCard: await computeSetupCardVerdict(
      state,
      input.exerciseId,
      limitedSessionIds,
      exerciseScopedSetsBySessionId,
    ),
  };
}

/**
 * VW-275: the DECLARED-setup gate, orthogonal to `sideSplit.setupComparability`
 * (VW-272's ROM-inferred geometry check between two limbs). This one compares
 * the most recent session's own confirmed card against the exercise's
 * reference card, regardless of side.
 */
async function computeSetupCardVerdict(
  state: ServerState,
  exerciseId: string,
  sessionIdsOldestFirst: readonly string[],
  setsBySessionId: Map<string, StoredSet[]>,
): Promise<SetupCardComparabilityVerdict> {
  const latestId = sessionIdsOldestFirst[sessionIdsOldestFirst.length - 1];
  const setupId =
    latestId === undefined ? undefined : dominantSetupId(setsBySessionId.get(latestId) ?? []);
  const sessionSetup =
    setupId === undefined ? undefined : await state.store.getExerciseSetup(setupId);
  const reference = await getReferenceSetupCard(state.store, state.exercises, {
    userId: LOCAL_USER_ID,
    exerciseId,
  });
  return compareSetupCards(sessionSetup?.card, reference);
}

/** The most-repeated non-undefined `setupId` among `sets`, or `undefined` if none carries one. */
function dominantSetupId(sets: readonly StoredSet[]): string | undefined {
  const counts = new Map<string, number>();
  for (const set of sets) {
    if (set.setupId === undefined) continue;
    counts.set(set.setupId, (counts.get(set.setupId) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
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
    getSessionDietPhase: (sessionId) => state.store.getSessionDietPhase(sessionId),
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

/**
 * Per-side set count and last-session load. `lastSessionPeakForceLbs` is
 * absent when the last session's sets on this side never had the firmware's
 * peak force reading (VW-304) — `undefined` when no set in range has a `side`.
 */
interface SideSplitSummary {
  setCount: number;
  lastSessionTopWeightLbs: number;
  lastSessionPeakForceLbs?: number;
}

/**
 * The per-side split, plus whether its two columns may be READ against each
 * other (VW-272).
 *
 * The two summaries are facts about one side each and always ship; what the gate
 * governs is the comparison a reader would make between them. On
 * `setup_confounded` the load difference is at least partly the rig, so `reason`
 * says so in words rather than leaving the two numbers side by side with nothing
 * between them.
 *
 * `comparisonMetric` / `comparisonBasis` (VW-304) name which of the two summaries'
 * fields a reader should actually compare: peak force when the last session
 * recorded it on both sides (the only metric with good bilateral reliability —
 * see `analytics/side-comparison.ts`), top weight otherwise. Present regardless
 * of `setupComparability`, since which field to read and whether the two sides
 * may be compared are separate questions.
 */
interface SideSplitReport {
  left: SideSplitSummary;
  right: SideSplitSummary;
  setupComparability: SetupComparability;
  setupSignatures: { left: SetupSignature; right: SetupSignature };
  setupReason: string;
  comparisonMetric: SideComparisonMetric;
  comparisonBasis: string;
}

// VMCP-04.09: derived from the same `setsBySessionId` the aggregator already
// consumes — not a second store query — since bilateral rows already carry
// their own resolved `side`, no bilateral-group dedup is needed to split them.
function computeSideSplit(
  limitedSessionIds: string[],
  setsBySessionId: Map<string, StoredSet[]>,
): SideSplitReport | undefined {
  const allSets = limitedSessionIds.flatMap((id) => setsBySessionId.get(id) ?? []);
  if (!allSets.some((s) => s.side !== undefined)) return undefined;

  const lastSessionSets =
    setsBySessionId.get(limitedSessionIds[limitedSessionIds.length - 1]) ?? [];
  const gate = compareSetupSignatures(
    storedSetupSignature(allSets, 'left'),
    storedSetupSignature(allSets, 'right'),
  );
  const left = sideSplitSummary(allSets, lastSessionSets, 'left');
  const right = sideSplitSummary(allSets, lastSessionSets, 'right');
  // sideSplit has no velocity-derived figure to fall back to (VW-304) — only
  // peak force vs. its existing top-weight comparison.
  const comparison = chooseSideComparisonMetric({
    peakForce:
      left.lastSessionPeakForceLbs !== undefined && right.lastSessionPeakForceLbs !== undefined,
    meanVelocity: false,
  });
  return {
    left,
    right,
    setupComparability: gate.comparability,
    setupSignatures: { left: gate.left, right: gate.right },
    setupReason: gate.reason,
    comparisonMetric: comparison.metric,
    comparisonBasis: comparison.reason,
  };
}

/**
 * One side's setup signature over the window (VW-272): the median of its sets'
 * own median working-rep ROMs, and the setup cluster they were stamped with when
 * they all agree on one.
 *
 * A window that spans a real setup change on one side has sets in more than one
 * cluster, and `setupId` is left off rather than naming whichever one came
 * first — the travel median still describes the window either way.
 */
function storedSetupSignature(sets: readonly StoredSet[], side: StoredSide): SetupSignature {
  const own = sets.filter((set) => set.side === side);
  const medianRomM = medianRomMetres(
    own.map((set) => setMedianRomM(set)).filter((rom): rom is number => rom !== undefined),
  );
  const setupIds = new Set(own.map((set) => set.setupId).filter((id) => id !== undefined));
  return {
    side,
    ...(medianRomM !== undefined ? { medianRomM } : {}),
    ...(setupIds.size === 1 ? { setupId: [...setupIds][0] } : {}),
  };
}

function sideSplitSummary(
  allSets: StoredSet[],
  lastSessionSets: StoredSet[],
  side: StoredSide,
): SideSplitSummary {
  const sideLastSessionSets = lastSessionSets.filter((s) => s.side === side);
  const lastSessionTopWeightLbs = sideLastSessionSets.reduce(
    (max, s) => (s.weightLbs !== undefined && s.weightLbs > max ? s.weightLbs : max),
    0,
  );
  const peakForces = sideLastSessionSets
    .map((s) => s.firmwarePeakForceLbs)
    .filter((v): v is number => v !== undefined);
  const lastSessionPeakForceLbs = peakForces.length > 0 ? Math.max(...peakForces) : undefined;
  return {
    setCount: allSets.filter((s) => s.side === side).length,
    lastSessionTopWeightLbs,
    ...(lastSessionPeakForceLbs !== undefined ? { lastSessionPeakForceLbs } : {}),
  };
}
