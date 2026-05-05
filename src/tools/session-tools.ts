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
// `NO_ACTIVE_SESSION`, `EXERCISE_NOT_FOUND`, `NOT_FOUND`). `wrapHandler`
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

import { type ServerState, getSlot } from '../state/server-state.js';
import {
  SessionEndInput,
  SessionGetInput,
  SessionListInput,
  SessionStartInput,
} from '../schemas/session.js';
import type { StoredRep, StoredSession, StoredSet } from '../store/types.js';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import { wrapHandler } from './helpers.js';

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
  );
  install(
    placeholders,
    'session.end',
    SessionEndInput,
    wrapHandler(SessionEndInput, (input) => endSession(state, input.slot)),
  );
  install(
    placeholders,
    'session.list',
    SessionListInput,
    wrapHandler(SessionListInput, (input) => listSessions(state, input)),
  );
  install(
    placeholders,
    'session.get',
    SessionGetInput,
    wrapHandler(SessionGetInput, (input) => getSession(state, input)),
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
  // Pair the real `paramsSchema` with the callback. The bootstrap placeholder
  // schema (`z.object({}).passthrough().shape`) loses passthrough through
  // `.shape`, so without this every required input would be stripped before
  // the callback's wrapHandler sees it.
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
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
  };
  slot.live.startSession(active);

  const stored: StoredSession = {
    id: sessionId,
    startedAt,
    ...(exerciseId !== undefined ? { exerciseId } : {}),
    ...(exerciseName !== undefined ? { exerciseName } : {}),
  };
  await state.store.putSession(stored);

  return { sessionId };
}

async function endSession(state: ServerState, slotId: string | undefined): Promise<{ ok: true }> {
  const slot = getSlot(state, slotId);
  const active = slot.live.session;
  if (active === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active.');
  }

  // EC-06: if a set is open, force-end it as partial first.
  if (slot.live.set !== undefined) {
    const device = slot.live.snapshotDevice();
    const finalized = slot.live.endSet('session_end');
    if (finalized !== undefined) {
      await state.store.putSet(toStoredSet(finalized, device));
    }
  }

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
): Promise<StoredSession[]> {
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
  return state.store.listSessions(filter);
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

/**
 * Build a `StoredSet` from a finalized `ActiveSet` and the device snapshot
 * captured at set start (or at session-end-cascade time).
 *
 * `chainsLbs` and `eccentricPercent` are intentionally omitted: the
 * `DeviceSnapshot` shape (Wave 1) does not carry them. They land in a future
 * wave once the SDK exposes the corresponding settings reads.
 */
function toStoredSet(active: ActiveSet, device: DeviceSnapshot): StoredSet {
  const reps: StoredRep[] = active.reps.map((rep, index) => ({
    ...rep,
    id: randomUUID(),
    setId: active.setId,
    index,
  }));
  return {
    id: active.setId,
    sessionId: active.sessionId,
    startedAt: active.startedAt,
    endedAt: active.endedAt ?? new Date().toISOString(),
    partial: active.status === 'partial',
    ...(active.partialReason !== undefined ? { partialReason: active.partialReason } : {}),
    trainingMode: device.trainingMode ?? 'Unknown',
    weightLbs: device.weightLbs ?? 0,
    reps,
  };
}
