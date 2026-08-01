// `session.*` tool handlers (Wave 3B, Task 11).
//
// Owns the workout-session lifecycle exposed over MCP:
//   * `session.start` — begins a session, validating exercise context (R21).
//   * `session.end` — closes the session, force-ending any active set with
//     `partialReason: 'session_end'` (EC-06) before writing the final row.
//   * `session.list` — read-side query, default sort `startedAt:desc` (R19).
//   * `session.get` — composes a stored session with its sets.
//
// Registration uses the placeholder map from `runServer`: each tool name has
// a pre-registered `STARTING` callback installed in `registerStartingPlaceholders`,
// and we hot-swap the real handler via `placeholder.update({ callback })`. This
// preserves the bootstrap-window guard (EC-16) without requiring a separate
// dispatch table.
//
// Error-channel convention: handlers throw a `ToolError` (an `Error` subclass
// with a `code` field) for guard failures (`SESSION_ALREADY_ACTIVE`,
// `NO_ACTIVE_SESSION`, `EXERCISE_NOT_FOUND`, `NOT_FOUND`,
// `AMBIGUOUS_EXERCISE_SWITCH`). `wrapHandler`
// routes these through `mapSdkError`, which preserves the `code` as-is — the
// same wire shape `errorResult` would produce. This keeps the handlers
// expression-oriented without a manual try/catch around every call.
//
// R21 ("exerciseId XOR exerciseName") is split: the schema's `.refine()`
// enforces "at least one"; this file enforces "if both, id wins" by clearing
// `exerciseName` whenever `exerciseId` is present before persisting.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { type TrainingMode, TrainingModeNames } from '@voltras/node-sdk';

import { type ServerState, type SlotState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import {
  SessionEndInput,
  SessionGetInput,
  SessionListInput,
  SessionSetExerciseInput,
  SessionStartInput,
} from '../schemas/session.js';
import type { StoredSession, StoredSet } from '../store/types.js';
import type { ActiveSession } from '../state/live-state.js';
import {
  aggregateSession,
  aggregateSessionFull,
  type SessionListEntrySummary,
  type SessionListEntryFull,
} from '../state/session-list-aggregator.js';
import { finalizeSet } from './set-tools.js';
import { wrapHandler } from './helpers.js';
import { buildSessionExerciseChangedPayload } from '../state/channel-payloads.js';

/**
 * Error type used by tool handlers to signal a known, mapped error code.
 * `wrapHandler` -> `mapSdkError` will preserve the `code` field on the wire.
 */
class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Register `session.start`, `session.end`, `session.list`, `session.get`.
 *
 * `placeholders` is the map produced by `registerStartingPlaceholders` in
 * `server.ts`; we replace each `STARTING` callback with the real handler via
 * `RegisteredTool.update({ callback })` so existing references stay valid.
 */
const SESSION_START_DESCRIPTION =
  'Start a workout session, optionally pinned to an exercise (`exerciseId` or `exerciseName`, ' +
  'at least one required if either is given). `slot` selects which device slot (default ' +
  "'primary'; use 'left'/'right' for a bilateral rig). A session with no exercise set at " +
  'start can have one attached later via `session.set_exercise`. `verboseIdleReps` controls ' +
  'whether idle-state rep noise is included in the channel event stream. Two coaching ' +
  'constraints govern the session you are about to run. (1) Cue budget: at most 1–2 coaching ' +
  'cues per interval (pre-set / intra-set / post-set), even when several faults are visible — ' +
  'presenting multiple corrections at once means none of them land, so queue the rest for a ' +
  'later interval rather than spending the budget up front. Cue density is itself tier-split ' +
  '(advanced lifters get silence during the set; beginners tolerate more in-set cueing), so ' +
  "attach the lifter's experience tier to any cue-count guidance you pass on. (2) Warm-up sets " +
  'are individualized, not templated: warm-up set COUNT varies by lifter and by exercise (2 for ' +
  'a small movement on an already-warm muscle, 4–5 for a large, technically demanding one), and ' +
  'a second exercise for a muscle the first exercise already warmed needs only one brief feel ' +
  'set. Do not emit a fixed warm-up block for every session.';

const SESSION_END_DESCRIPTION =
  'End the active session on a slot and return its summary. Idempotent-adjacent: ending an ' +
  'already-ended or nonexistent session is a normal, checkable outcome, not necessarily an ' +
  'error — check the response shape rather than assuming a throw.';

const SESSION_SET_EXERCISE_DESCRIPTION =
  'Attach or change the exercise (`exerciseId` or `exerciseName`) on the active session for a ' +
  'slot. Use this for a session that started without a pinned exercise, or a multi-exercise ' +
  'session moving to its next movement. Exercise-name resolution is exact-match; prefer ' +
  '`exerciseId` from `exercise.search`/`exercise.get` when you have it.';

const SESSION_LIST_DESCRIPTION =
  'List past sessions, optionally filtered by date range (`from`/`to`) and/or `exerciseId`, ' +
  'with `sort`/`limit`/`offset` pagination. `detail` controls whether each entry is a summary ' +
  'row or the full session payload — prefer summary (the default) for browsing; a session can ' +
  'be 100+ KB of set/rep data at `detail: full` scale, so fetch that per-session via ' +
  '`session.get` only for the one you actually need.';

const SESSION_GET_DESCRIPTION =
  'Fetch one full session by id, including its sets. Can be large for a long session — prefer ' +
  '`session.list` for browsing/filtering and only call this for a session you already intend ' +
  'to inspect in full.';

export function registerSessionTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'session.start',
    SessionStartInput,
    wrapHandler(SessionStartInput, (input) => startSession(state, input)),
    SESSION_START_DESCRIPTION,
  );
  install(
    placeholders,
    'session.end',
    SessionEndInput,
    wrapHandler(SessionEndInput, (input) => endSession(state, input.slot)),
    SESSION_END_DESCRIPTION,
  );
  install(
    placeholders,
    'session.set_exercise',
    SessionSetExerciseInput,
    wrapHandler(SessionSetExerciseInput, (input) => setSessionExercise(state, input)),
    SESSION_SET_EXERCISE_DESCRIPTION,
  );
  install(
    placeholders,
    'session.list',
    SessionListInput,
    wrapHandler(SessionListInput, (input) => listSessions(state, input)),
    SESSION_LIST_DESCRIPTION,
  );
  install(
    placeholders,
    'session.get',
    SessionGetInput,
    wrapHandler(SessionGetInput, (input) => getSession(state, input)),
    SESSION_GET_DESCRIPTION,
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
  // Pair the real `paramsSchema` with the callback. The bootstrap placeholder
  // schema (`z.object({}).passthrough().shape`) loses passthrough through
  // `.shape`, so without this every required input would be stripped before
  // the callback's wrapHandler sees it.
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

async function startSession(
  state: ServerState,
  input: z.infer<typeof SessionStartInput>,
): Promise<{ sessionId: string }> {
  const slot = getSlot(state, input.slot);
  if (slot.live.session !== undefined) {
    throw new ToolError('SESSION_ALREADY_ACTIVE', 'A session is already active.');
  }

  // R21: id wins over name. Drop name whenever id is present.
  const useId = input.exerciseId !== undefined;
  if (useId) {
    const found = state.exercises.getById(input.exerciseId!);
    if (found === undefined) {
      throw new ToolError(
        'EXERCISE_NOT_FOUND',
        `No exercise with id "${input.exerciseId!}" exists in the catalog.`,
      );
    }
  }

  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const exerciseId = useId ? input.exerciseId : undefined;
  const exerciseName = useId ? undefined : input.exerciseName;

  const active: ActiveSession = {
    sessionId,
    startedAt,
    setIds: [],
    status: 'active',
    ...(exerciseId !== undefined ? { exerciseId } : {}),
    ...(exerciseName !== undefined ? { exerciseName } : {}),
    ...(input.verboseIdleReps === true ? { verboseIdleReps: true } : {}),
  };
  slot.live.startSession(active);
  // Clear idle-rep accumulators so the PT skill starts each session from a
  // clean slate. Reps lifted before this session.start won't carry over
  // into the new session's `idleRepCount` / `idleReps` on the session resource.
  slot.live.clearIdleReps();

  const stored: StoredSession = {
    id: sessionId,
    startedAt,
    ...(exerciseId !== undefined ? { exerciseId } : {}),
    ...(exerciseName !== undefined ? { exerciseName } : {}),
  };
  await state.store.putSession(stored);

  // Bug 22 — arm the per-slot mode-revert guard with the current device
  // training mode. Subsequent `onSettingsUpdate` events inside the
  // detection window that report a different trainingMode latch a safety
  // abort that blocks the next `set.start` from engaging the motor. We
  // arm against the device's *current* mode (the user-facing intent at
  // session.start time) rather than a tool argument because session.start
  // does not yet take a trainingMode parameter — the mode is set
  // implicitly via prior `device.set_mode` calls.
  // VMCP-02.72: reset before arming so a latched abort from a PRIOR session
  // (session.start requires no active session, so any latch is stale) cannot
  // block this session's first set.start. `arm` alone does not clear the
  // latch.
  slot.modeRevertGuard.reset();
  const requestedMode = trainingModeFromSnapshot(slot.live.snapshotDevice().trainingMode);
  if (requestedMode !== undefined) {
    slot.modeRevertGuard.arm(requestedMode);
  }

  return { sessionId };
}

/**
 * Comparison key for exercise-name matching: case- and
 * punctuation-insensitive, so "Cable Chest Press" and "cable-chest-press"
 * collapse to the same key. Mirrors
 * `dashboard/read-models/exercise-history.ts`'s `normalizeExerciseLabel` —
 * duplicated locally rather than imported so the tool layer doesn't reach
 * into dashboard read-models for a five-line pure function.
 */
function normalizeExerciseName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a free-text exercise name to a catalog id, but ONLY on an exact
 * (normalized) match — `state.exercises.search()` is relevance-ranked and
 * may return several candidates for an ambiguous query, and silently
 * picking its first result would attribute the switch to a possibly-wrong
 * exercise. Returns `undefined` when there is no exact match (zero results,
 * or more than one exercise normalizing to the same key).
 */
function resolveExactExerciseName(state: ServerState, name: string): string | undefined {
  const target = normalizeExerciseName(name);
  const matches = state.exercises
    .search(name)
    .filter((e) => normalizeExerciseName(e.name) === target);
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/**
 * True when the slot's current session already has at least one SET
 * attributed to a real catalog exercise — the currently-open set (if any)
 * plus every completed set retained for this session
 * (`snapshotCompletedSets` is already session-scoped). Used to decide
 * whether a name-only `session.set_exercise` call can be trusted: a session
 * that has recorded nothing but unattributed/name-only sets so far is
 * exactly the "session is still single-exercise" case the H2 leniency
 * exists to protect, so a further name-only switch is safe. One that
 * already has a real exerciseId on record is not — see S3 in the
 * VMCP-01.72b review.
 */
function sessionHasAttributedSet(slot: SlotState): boolean {
  if (slot.live.set?.exerciseId !== undefined) return true;
  return slot.live.snapshotCompletedSets().some((record) => record.set.exerciseId !== undefined);
}

/**
 * Repoint the active session's current exercise (VMCP-01.72b) so one
 * workout can hold several exercises without ending and restarting the
 * session. Sets already open when this is called are unaffected — they
 * snapshotted the pointer at `set.start` (see `startSet` /
 * `ActiveSet.exerciseId`); only sets started AFTER this call inherit the
 * new pointer. Deliberately allowed mid-set for exactly that reason: it's
 * what makes switching exercises between sets, without ending the session,
 * the feature's point.
 *
 * Deferred persistence: no direct `store.putSession` call here. The stored
 * session row's `exerciseId`/`exerciseName` are already advisory-only
 * ("the session-level column stays as a hint" — sqlite-store.ts) and get
 * refreshed from `active.exerciseId`/`exerciseName` the next time the
 * session row is written (`session.end`). A crash between this call and
 * `session.end` loses the in-memory pointer, same as any other live-only
 * LiveState mutation.
 */
async function setSessionExercise(
  state: ServerState,
  input: z.infer<typeof SessionSetExerciseInput>,
): Promise<{ sessionId: string; exerciseId?: string; exerciseName?: string }> {
  const slot = getSlot(state, input.slot);
  const active = slot.live.session;
  if (active === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active.');
  }

  // R21: id wins over name. Drop name whenever id is present.
  const useId = input.exerciseId !== undefined;
  if (useId) {
    const found = state.exercises.getById(input.exerciseId!);
    if (found === undefined) {
      throw new ToolError(
        'EXERCISE_NOT_FOUND',
        `No exercise with id "${input.exerciseId!}" exists in the catalog.`,
      );
    }
  }
  let exerciseId = useId ? input.exerciseId : undefined;
  let exerciseName = useId ? undefined : input.exerciseName;

  // VMCP-01.72b (S3): a name-only switch leaves the pointer with NO
  // exerciseId, and `scopeSessionSetsToExercise`'s multi-exercise detection
  // (`isSingleExerciseSession`) only inspects sets that HAVE one — it can't
  // see a second exercise recorded purely by name, so it wrongly stays
  // "single" and re-applies the unattributed-set leniency across exercises
  // that are, in fact, different. Two ways this call can proceed safely:
  //
  //   1. The name matches the catalog exactly (case/punctuation-insensitive)
  //      — silently promote it to that id, same as if the caller had passed
  //      the id directly. Closes the common case for free.
  //   2. It doesn't match the catalog, but this session has recorded NO
  //      attributed set yet — a session that has only ever held one (as-yet
  //      unidentified) exercise is exactly the case the unattributed
  //      leniency exists to protect, so this is safe.
  //
  // Anything else — an unresolvable name switched into a session that
  // already holds a real, catalog-identified exercise — is rejected. The
  // guard can't be honored without an id, so refusing beats silently
  // mis-attributing.
  if (!useId && exerciseName !== undefined) {
    const resolvedId = resolveExactExerciseName(state, exerciseName);
    if (resolvedId !== undefined) {
      exerciseId = resolvedId;
      exerciseName = undefined;
    } else if (sessionHasAttributedSet(slot)) {
      throw new ToolError(
        'AMBIGUOUS_EXERCISE_SWITCH',
        `"${exerciseName}" does not match a catalog exercise, and this session already holds ` +
          'sets attributed to a different exercise. A free-text name cannot be safely ' +
          'disambiguated from the ones already recorded — call session.set_exercise with ' +
          `exerciseId instead, or add "${exerciseName}" to the exercise catalog.`,
      );
    }
  }

  const previous = {
    ...(active.exerciseId !== undefined ? { exerciseId: active.exerciseId } : {}),
    ...(active.exerciseName !== undefined ? { exerciseName: active.exerciseName } : {}),
  };
  slot.live.setSessionExercise(exerciseId, exerciseName);

  const payload = buildSessionExerciseChangedPayload(
    active.sessionId,
    {
      ...(exerciseId !== undefined ? { exerciseId } : {}),
      ...(exerciseName !== undefined ? { exerciseName } : {}),
    },
    previous,
  );
  state.channels.forSlot(input.slot ?? PRIMARY_SLOT).publish(payload);

  return {
    sessionId: active.sessionId,
    ...(exerciseId !== undefined ? { exerciseId } : {}),
    ...(exerciseName !== undefined ? { exerciseName } : {}),
  };
}

/**
 * Reverse-lookup a `TrainingMode` enum value from a `TrainingModeName`
 * string (the form `DeviceSnapshot.trainingMode` carries). Returns
 * `undefined` when the snapshot has no recognised mode (`'Unknown'` or
 * the device hasn't pushed a settings_update yet) — the guard treats that
 * as "nothing to watch for", which is the correct fail-open shape for
 * sessions started with a mode the bridge doesn't recognise.
 *
 * Implementation note: there's no public reverse-map exported from the
 * SDK, so we walk `TrainingModeNames` once. The set is fixed at 8
 * entries; the lookup is O(1) amortised because we iterate once.
 */
function trainingModeFromSnapshot(name: string | undefined): TrainingMode | undefined {
  if (name === undefined) return undefined;
  for (const key of Object.keys(TrainingModeNames)) {
    const value = Number(key) as TrainingMode;
    if (TrainingModeNames[value] === name) {
      return value;
    }
  }
  return undefined;
}

async function endSession(state: ServerState, slotId: string | undefined): Promise<{ ok: true }> {
  const resolvedSlotId = slotId ?? PRIMARY_SLOT;
  const slot = getSlot(state, resolvedSlotId);
  const active = slot.live.session;
  if (active === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active.');
  }

  // EC-06: if a set is open, force-close it through the shared finalize path
  // (VMCP-02.50) so a session-triggered close does everything an explicit
  // set.end does — disengage the motor (safety: never leave the cable loaded),
  // cancel the idle watchdog, clear the set-start device snapshot, use that
  // start snapshot for the persisted row, and emit the `set_ended` event.
  // The prior hand-rolled `endSet` + `putSet` skipped all of those and
  // persisted the CURRENT (possibly mid-set-changed) device snapshot.
  // `partialReason: 'session_end'` keeps the row flagged partial with the
  // session-end cause.
  if (slot.live.set !== undefined) {
    await finalizeSet(state, resolvedSlotId, {
      cause: 'tool',
      disengageMotor: true,
      partialReason: 'session_end',
    });
  }

  // VMCP-02.72: clear the mode-revert guard on the session boundary. A latched
  // safety abort must not outlive the session that produced it — the
  // set_aborted_by_mode_revert error text tells the user to end + restart the
  // session to recover, so the latch has to actually reset here (and on
  // session.start). Without this, the latch survived a full session cycle and
  // spuriously aborted every subsequent set.start.
  slot.modeRevertGuard.reset();

  const finalizedSession = slot.live.endSession();
  // `endSession` returns undefined only when there was no active session; we
  // checked that above, so `finalizedSession` is non-undefined here.
  const endedAt = new Date().toISOString();
  const stored: StoredSession = {
    id: active.sessionId,
    startedAt: active.startedAt,
    endedAt,
    ...(active.exerciseId !== undefined ? { exerciseId: active.exerciseId } : {}),
    ...(active.exerciseName !== undefined ? { exerciseName: active.exerciseName } : {}),
  };
  await state.store.putSession(stored);
  void finalizedSession; // referenced via `active` snapshot for upsert payload
  return { ok: true };
}

async function listSessions(
  state: ServerState,
  input: z.infer<typeof SessionListInput>,
): Promise<SessionListEntrySummary[] | SessionListEntryFull[]> {
  // R19: default sort is `startedAt:desc`. The schema declares the default
  // but marks the field optional, so an undefined value still reaches us
  // when the caller omits it.
  const filter = {
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.exerciseId !== undefined ? { exerciseId: input.exerciseId } : {}),
    sort: (input.sort ?? 'startedAt:desc') as 'startedAt:desc' | 'startedAt:asc',
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
  };
  const sessions = await state.store.listSessions(filter);

  // N+1: one getSetsForSession per session. Acceptable for v1 (N ≤ 200,
  // in-process SQLite). Future optimisation: add listSessionAggregates() to
  // the store interface for a single SQL aggregate query.
  const detail = input.detail ?? 'summary';
  const results = await Promise.all(
    sessions.map(async (session) => {
      const sets = await state.store.getSetsForSession(session.id);
      return detail === 'full'
        ? aggregateSessionFull(session, sets)
        : aggregateSession(session, sets);
    }),
  );

  return results as SessionListEntrySummary[] | SessionListEntryFull[];
}

async function getSession(
  state: ServerState,
  input: z.infer<typeof SessionGetInput>,
): Promise<{ session: StoredSession; sets: StoredSet[] }> {
  const session = await state.store.getSession(input.id);
  if (session === undefined) {
    throw new ToolError('NOT_FOUND', `No session with id "${input.id}" exists.`);
  }
  const sets = await state.store.getSetsForSession(input.id);
  return { session, sets };
}
