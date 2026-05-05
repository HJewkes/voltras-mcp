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
// start" choice is implemented via `state.setStartDeviceSnapshots`
// (Map<setId, DeviceSnapshot>) — the snapshot is held until `set.end` (or
// the bridge's `set_ended_by_device` autonomous handler) consumes it. The
// map lives on shared state rather than in this module's closure so both
// finalize paths reuse the same `finalizeSet` helper. Re-reading the device
// at finalize time would let mid-set `device.set_weight` calls
// retroactively rewrite the stored `weightLbs`, which is the wrong shape
// for analytics consumers.
//
// Error-channel convention matches `session-tools.ts`: a thrown `ToolError`
// with a `code` field is preserved by `mapSdkError` -> `errorResult`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { ServerState } from '../state/server-state.js';
import {
  SetEndInput,
  SetGetInput,
  SetLiveMetricsInput,
  SetStartInput,
  type WatchConfig,
} from '../schemas/set.js';
import type { StoredRep, StoredSet } from '../store/types.js';
import type { ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import {
  buildSetEndedPayload,
  buildSetStartedPayload,
  summarizePreviousSet,
  type SetEndedCause,
} from '../state/channel-payloads.js';
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
 * The shared device-snapshot map (on `state.setStartDeviceSnapshots`)
 * persists between `set.start` and the matching finalize call so the
 * snapshot taken at start time survives any intervening `applySettings`
 * mutations. The map lives on `state` rather than in this module's closure
 * so the bridge's `set_ended_by_device` handler can finalize the same set
 * with the same recorded device config when the user presses Stop on the
 * unit (event-bridge.ts:onSetBoundary). `set.get` is read-only: it pulls a
 * completed set straight from the store and is unaffected by live state.
 */
export function registerSetTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'set.start',
    SetStartInput,
    wrapHandler(SetStartInput, (input) => startSet(state, input.watch)),
  );
  install(
    placeholders,
    'set.end',
    SetEndInput,
    wrapHandler(SetEndInput, () => endSetTool(state)),
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
  watch: WatchConfig | undefined,
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
    ...(watch !== undefined ? { watch } : {}),
  });
  const device = state.live.snapshotDevice();
  state.setStartDeviceSnapshots.set(setId, device);
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

async function endSetTool(state: ServerState): Promise<{ ok: true; reps: number }> {
  if (state.live.set === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active. Call set.start first.');
  }
  // The explicit-tool path always disengages the motor (Workout.STOP) and
  // emits a `set_ended` event with no `partialReason`.
  const stored = await finalizeSet(state, { cause: 'tool', disengageMotor: true });
  if (stored === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active.');
  }
  return { ok: true, reps: stored.reps.length };
}

/**
 * Shared finalize sequence used by the explicit `set.end` tool, the
 * bridge's autonomous `set_ended_by_device` handler, AND the trigger DSL
 * `stopOn` auto-stop path. Returns the persisted set on success, or
 * `undefined` when no set was active (the device-signal / auto-stop callers
 * treat this as a silent drop; the tool caller turns it into NO_ACTIVE_SET).
 *
 * `disengageMotor` should be `true` for the tool / auto-stop paths (we
 * explicitly stop recording so the cable goes free for rest) and `false`
 * for the device signal path — the device has already de-engaged on its
 * own, and an extra `Workout.STOP` would be a no-op at best and a
 * connection-state churn at worst.
 *
 * `cause` selects the channel `event_type` (`set_ended` vs
 * `set_ended_by_device`) and, for the device-signal path, also stamps the
 * stored row with `partial=true` and `partialReason='device_signal'`.
 *
 * `partialReason` overrides the LiveState-derived stamp (used by the
 * trigger DSL auto-stop path to mark the row as `'auto_stopped'`). When
 * absent, the device-signal path keeps stamping `'device_signal'`, and the
 * tool path keeps the graceful-close `partial=false`.
 *
 * `auto_stop_cause` flows through to the `set_ended` payload's meta and
 * content as `auto_stop_cause` so the model can distinguish auto-stop
 * sub-causes (`rep_count_reached`, `velocity_loss_exceeded`,
 * `idle_timeout_ms`) without re-parsing the partial_reason enum.
 */
export async function finalizeSet(
  state: ServerState,
  opts: {
    cause: SetEndedCause;
    disengageMotor: boolean;
    partialReason?: 'auto_stopped';
    auto_stop_cause?: string;
  },
): Promise<StoredSet | undefined> {
  if (state.live.set === undefined) {
    return undefined;
  }
  const setId = state.live.set.setId;
  // `live.endSet` is called without a `reason`: the explicit-tool path is a
  // graceful close, the device-signal path applies its
  // `partial=true / partialReason='device_signal'` stamp directly on the
  // finalized snapshot below, and the auto-stop path also stamps below
  // (so the partial-reason override lives in exactly one place).
  const finalized = state.live.endSet();
  if (finalized === undefined) {
    return undefined;
  }

  if (opts.disengageMotor) {
    // Disengage the device motor between sets (Workout.STOP) so the cable
    // goes free while the user rests. SDK keeps the workout-mode session
    // open so a subsequent set.start can re-engage without re-arming. The
    // tool path and auto-stop path both run this; the device-signal path
    // skips it because the device already de-engaged on its own.
    await state.client.endSet();
  }

  // Use the snapshot captured at `set.start`; fall back to the current
  // snapshot if it was somehow missing (defensive — should not happen).
  const device = state.setStartDeviceSnapshots.get(setId) ?? state.live.snapshotDevice();
  state.setStartDeviceSnapshots.delete(setId);

  // Pick the partial-reason stamp (if any). Auto-stop wins when supplied;
  // device-signal wins when no auto-stop reason is set; otherwise the
  // graceful tool-end path leaves the row non-partial.
  const finalizedWithCause: ActiveSet = (() => {
    if (opts.partialReason !== undefined) {
      return { ...finalized, status: 'partial', partialReason: opts.partialReason };
    }
    if (opts.cause === 'device_signal') {
      return { ...finalized, status: 'partial', partialReason: 'device_signal' };
    }
    return finalized;
  })();
  const stored = toStoredSet(finalizedWithCause, device);
  await state.store.putSet(stored);
  // Push a lifecycle event so a channel-enabled host wakes the model on set
  // close. The payload carries the full rep array plus a pre-computed VBT
  // summary (first/last rep velocity + velocity-loss %), so PT Claude can
  // skip the set.get + metrics.compute vbt.set retrieval calls that almost
  // every set close currently triggers.
  const payload = buildSetEndedPayload(stored, opts.cause, opts.auto_stop_cause);
  state.channels.publish(payload);
  return stored;
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
