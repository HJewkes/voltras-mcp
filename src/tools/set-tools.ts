// `set.*` tool handlers (Wave 3B, Task 11).
//
// Owns the rep-recording set lifecycle exposed over MCP:
//   * `set.start` — begins a new set, snapshotting device settings at start
//     time so the persisted row reflects the configuration the user lifted
//     against (not whatever the device drifts to mid-set).
//   * `set.end` — finalizes the active set, persisting reps and the cached
//     device snapshot.
//   * `set.live_metrics` — polling fallback for `voltra://set/active`,
//     returning `{ active: false }` when no set is in flight (AC-12).
//
// `SetStartInput` is `z.object({})` by design (R18 / Task 03's handoff): all
// set metadata derives from `state.live.snapshotDevice()`. The "snapshot at
// start" choice is implemented via a per-handler `Map<setId, DeviceSnapshot>`
// — the same closure that owns the live state holds the snapshot until
// `set.end` consumes it. Re-reading the device at `set.end` would let
// mid-set `device.set_weight` calls retroactively rewrite the stored
// `weightLbs`, which is the wrong shape for analytics consumers.
//
// Error-channel convention matches `session-tools.ts`: a thrown `ToolError`
// with a `code` field is preserved by `mapSdkError` -> `errorResult`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { ServerState } from '../state/server-state.js';
import { SetEndInput, SetGetInput, SetLiveMetricsInput, SetStartInput } from '../schemas/set.js';
import type { StoredRep, StoredSet } from '../store/types.js';
import type { ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import { buildSetStartedPayload, summarizePreviousSet } from '../state/channel-payloads.js';
import { log } from '../logger.js';
import { wrapHandler } from './helpers.js';

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
 * Register `set.start`, `set.end`, `set.live_metrics`, `set.get`.
 *
 * The shared `deviceSnapshots` map persists between `set.start` and the
 * matching `set.end` so the snapshot taken at start time survives any
 * intervening `applySettings` mutations. `set.get` is read-only: it pulls a
 * completed set straight from the store and is unaffected by live state.
 */
export function registerSetTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const deviceSnapshots = new Map<string, DeviceSnapshot>();

  install(
    placeholders,
    'set.start',
    SetStartInput,
    wrapHandler(SetStartInput, () => startSet(state, deviceSnapshots)),
  );
  install(
    placeholders,
    'set.end',
    SetEndInput,
    wrapHandler(SetEndInput, () => endSet(state, deviceSnapshots)),
  );
  install(
    placeholders,
    'set.live_metrics',
    SetLiveMetricsInput,
    wrapHandler(SetLiveMetricsInput, () => liveMetrics(state)),
  );
  install(
    placeholders,
    'set.get',
    SetGetInput,
    wrapHandler(SetGetInput, (input) => getStoredSet(state, input.setId)),
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

async function startSet(
  state: ServerState,
  deviceSnapshots: Map<string, DeviceSnapshot>,
): Promise<{ setId: string }> {
  const session = state.live.session;
  if (session === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active. Call session.start first.');
  }
  if (state.live.set !== undefined) {
    throw new ToolError('SET_ALREADY_ACTIVE', 'A set is already active.');
  }

  // Engage the device motor — firmware-side equivalent of the "tap to load"
  // prompt on the unit. Without this the cable is free-running and no force
  // is applied. SDK: VoltraClient.startRecording → Workout.GO.
  await state.client.startRecording();

  const setId = randomUUID();
  const startedAt = new Date().toISOString();
  state.live.startSet({
    setId,
    sessionId: session.sessionId,
    startedAt,
    reps: [],
    status: 'active',
  });
  const device = state.live.snapshotDevice();
  deviceSnapshots.set(setId, device);
  // Push a lifecycle event so a channel-enabled host wakes the model on the
  // set boundary instead of forcing it to poll. Fire-and-forget when the
  // host didn't opt in to channels (see channel-publisher.ts).
  //
  // The channel payload carries the full set config (weight, mode, started_at)
  // plus a summary of the previous set in the session for fatigue baselining.
  // PT Claude can skip the device.get_state + session.get retrieval pair that
  // every set.start currently triggers.
  //
  // Ordinal counts the new set as part of the session — the live session's
  // setIds array doesn't include it yet (set-end is what appends), so add 1.
  const ordinal = (state.live.snapshotSession()?.setIds.length ?? 0) + 1;
  // Fetch the previous set summary best-effort. If the store query fails for
  // any reason (transient SQLite contention, etc.), we fall back to a null
  // previous_set_summary rather than blowing up the channel emission — the
  // model can always call metrics.compute later if it wants the fatigue
  // context.
  const previousSummary = await fetchPreviousSetSummary(state, session.sessionId, setId);
  const activeSet: ActiveSet = {
    setId,
    sessionId: session.sessionId,
    startedAt,
    reps: [],
    status: 'active',
  };
  const payload = buildSetStartedPayload(activeSet, device, ordinal, previousSummary);
  state.channels.publish(payload);
  return { setId };
}

async function fetchPreviousSetSummary(
  state: ServerState,
  sessionId: string,
  newSetId: string,
): Promise<ReturnType<typeof summarizePreviousSet> | null> {
  try {
    const sets = await state.store.getSetsForSession(sessionId);
    if (sets.length === 0) {
      return null;
    }
    // `getSetsForSession` returns oldest-first per the SessionStore contract;
    // walk from the end to find the most recent set that isn't the new
    // not-yet-persisted one (defensive — putSet hasn't run yet at this point,
    // but a re-run with the same id should still pick the prior set).
    for (let i = sets.length - 1; i >= 0; i--) {
      const candidate = sets[i];
      if (candidate.id !== newSetId) {
        return summarizePreviousSet(candidate);
      }
    }
    return null;
  } catch (err) {
    log.warn('set.start: failed to load previous-set summary, omitting from channel event', err);
    return null;
  }
}

async function endSet(
  state: ServerState,
  deviceSnapshots: Map<string, DeviceSnapshot>,
): Promise<{ ok: true; reps: number }> {
  if (state.live.set === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active. Call set.start first.');
  }

  const setId = state.live.set.setId;
  const finalized = state.live.endSet();
  // `live.set` was defined a moment ago, so `endSet()` returned a value.
  if (finalized === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active.');
  }

  // Disengage the device motor between sets (Workout.STOP) so the cable goes
  // free while the user rests. SDK keeps the workout-mode session open so a
  // subsequent set.start can re-engage without re-arming.
  await state.client.endSet();

  // Use the snapshot captured at `set.start`; fall back to the current
  // snapshot if it was somehow missing (defensive — should not happen).
  const device = deviceSnapshots.get(setId) ?? state.live.snapshotDevice();
  deviceSnapshots.delete(setId);

  const stored = toStoredSet(finalized, device);
  await state.store.putSet(stored);
  // Push a lifecycle event so a channel-enabled host wakes the model on
  // set close — useful for "score the set" follow-ups without polling.
  const durationMs = Date.parse(stored.endedAt) - Date.parse(stored.startedAt);
  state.channels.publish({
    content: `Set ${setId.slice(0, 8)} ended (${stored.reps.length} reps).`,
    meta: {
      source: 'voltras',
      event_type: 'set_ended',
      set_id: setId,
      rep_count: String(stored.reps.length),
      duration_ms: String(Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0),
    },
  });
  return { ok: true, reps: stored.reps.length };
}

async function liveMetrics(state: ServerState): Promise<{ active: false } | ActiveSet> {
  const snapshot = state.live.snapshotSet();
  return Promise.resolve(snapshot ?? { active: false });
}

/**
 * Fetch a completed set's full payload (set metadata + every persisted rep
 * with per-phase telemetry). Throws `SET_NOT_FOUND` when no row matches; the
 * `errorResult` mapping in `wrapHandler` surfaces that as a structured tool
 * error to the MCP client.
 */
async function getStoredSet(state: ServerState, setId: string): Promise<StoredSet> {
  const stored = await state.store.getSet(setId);
  if (stored === undefined) {
    throw new ToolError('SET_NOT_FOUND', `No set found with id ${JSON.stringify(setId)}.`);
  }
  return stored;
}

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
