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
// set metadata derives from the slot's `live.snapshotDevice()`. The "snapshot at
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
import { type TrainingMode, TrainingModeNames } from '@voltras/node-sdk';

import { type ServerState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import {
  SetEndInput,
  SetGetInput,
  SetLiveMetricsInput,
  SetStartInput,
  type TriggerSpec,
  type WatchConfig,
} from '../schemas/set.js';
import type { StoredRep, StoredSet } from '../store/types.js';
import type { ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import {
  buildIdleTimeoutPayload,
  buildSetAbortedByModeRevertPayload,
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
 * unit (event-bridge.ts:onInProgress). `set.get` is read-only: it pulls a
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
    wrapHandler(SetStartInput, (input) => startSet(state, input.watch, input.slot)),
  );
  install(
    placeholders,
    'set.end',
    SetEndInput,
    wrapHandler(SetEndInput, (input) => endSetTool(state, input.slot)),
  );
  install(
    placeholders,
    'set.live_metrics',
    SetLiveMetricsInput,
    wrapHandler(SetLiveMetricsInput, (input) => liveMetrics(state, input.slot)),
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

/**
 * Re-arm the slot's mode-revert guard against the device's *current*
 * training mode. Called at `set.start` time so a mode change between
 * `session.start` and `set.start` (the user toggled modes on the unit
 * between two sets in the same session) is treated as the new
 * user-requested baseline rather than as a revert from the
 * session-start mode.
 *
 * A snapshot mode of `'Unknown'` (or any name the SDK doesn't recognise)
 * leaves the guard idle — fail-open is safer here than fail-closed,
 * because we'd otherwise refuse every set.start on devices that haven't
 * yet completed their initial settings cascade.
 */
function armModeRevertGuardForSet(slot: ReturnType<typeof getSlot>): void {
  const name = slot.live.snapshotDevice().trainingMode;
  if (name === undefined) return;
  for (const key of Object.keys(TrainingModeNames)) {
    const value = Number(key) as TrainingMode;
    if (TrainingModeNames[value] === name) {
      slot.modeRevertGuard.arm(value);
      return;
    }
  }
}

async function startSet(
  state: ServerState,
  watch: WatchConfig | undefined,
  slotIdInput: string | undefined,
): Promise<{ setId: string }> {
  const slotId = slotIdInput ?? PRIMARY_SLOT;
  const slot = getSlot(state, slotId);
  const session = slot.live.session;
  if (session === undefined) {
    throw new ToolError('NO_ACTIVE_SESSION', 'No session is active. Call session.start first.');
  }
  if (slot.live.set !== undefined) {
    throw new ToolError('SET_ALREADY_ACTIVE', 'A set is already active.');
  }

  // <Bug-22> Refuse to engage strength-mode GO when the device is in Rowing.
  // `client.startRecording()` writes `BP_SET_FITNESS_MODE = 5` (the strength
  // arm), which silently reverts an active rowing session — HIGH safety
  // severity. Rowing is committed via the SDK's `enterRowMode + startRow`
  // pair; once `client.isRowingActive` is true (or the device has already
  // settled into Rowing mode), the user must not engage via `set.start`.
  const trainingMode = slot.live.snapshotDevice().trainingMode;
  if (trainingMode === 'Rowing' || slot.client.isRowingActive) {
    throw new ToolError(
      'ROWING_USE_TWO_STAGE',
      'Cannot start a set while the device is in Rowing mode. Rowing engages via ' +
        'device.enter_row_mode + device.start_row, not set.start. set.start would issue ' +
        'the strength-mode GO and silently revert the rowing session.',
    );
  }
  // </Bug-22>

  // Bug 22 — consult the mode-revert guard BEFORE engaging the motor.
  // If the per-slot guard latched an abort (a settings_update inside the
  // detection window reported a trainingMode different from what the user
  // requested at session.start / a prior set.start), refuse the engage,
  // emit a `set_aborted_by_mode_revert` channel event, and surface a
  // structured tool error. The motor never engages — this is the
  // HIGH-severity safety guarantee. The user must re-select the desired
  // mode on the unit and retry; arming the guard again happens implicitly
  // when set.start is called and `armModeRevertGuardForSet` records the
  // device's *current* mode below.
  const pendingAbort = slot.modeRevertGuard.consumeAbort();
  if (pendingAbort !== null) {
    const requestedName =
      TrainingModeNames[pendingAbort.requested] ?? String(pendingAbort.requested);
    const actualName = TrainingModeNames[pendingAbort.actual] ?? String(pendingAbort.actual);
    const payload = buildSetAbortedByModeRevertPayload(
      requestedName,
      actualName,
      pendingAbort.timestampMs,
      session.sessionId,
    );
    state.channels.forSlot(slotId).publish(payload);
    throw new ToolError(
      'SET_ABORTED_BY_MODE_REVERT',
      `Set aborted: device reverted from ${requestedName} to ${actualName} after the user requested ${requestedName}. ` +
        `Motor not engaged. Re-select ${requestedName} on the unit and retry.`,
    );
  }

  // Re-arm the guard for the upcoming engagement window. The user's
  // intent at this exact moment is the device's current trainingMode (the
  // guard rearm BEFORE startRecording so any device-side autonomous
  // revert that lands during the BLE round-trip is observed and latched
  // for the *next* set.start, since this current call has already
  // committed past the abort check).
  armModeRevertGuardForSet(slot);

  // Engage the device motor — firmware-side equivalent of the "tap to load"
  // prompt on the unit. Without this the cable is free-running and no force
  // is applied. SDK: VoltraClient.startRecording → Workout.GO.
  await slot.client.startRecording();

  const setId = randomUUID();
  const startedAt = new Date().toISOString();
  slot.live.startSet({
    setId,
    sessionId: session.sessionId,
    startedAt,
    reps: [],
    status: 'active',
    ...(watch !== undefined ? { watch } : {}),
  });
  const device = slot.live.snapshotDevice();
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
  const ordinal = (slot.live.snapshotSession()?.setIds.length ?? 0) + 1;
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
  // Slot-scoped publisher auto-injects `slot: slotId` into meta — every
  // channel event from this slot is tagged so bilateral coaching can
  // tell left-arm from right-arm at a glance. Single-device flows still
  // see meta.slot = 'primary' (a meta-key addition, not a behavior change).
  state.channels.forSlot(slotId).publish(payload);
  // Arm the idle-timeout watchdog if any idle_timeout_ms spec is in the
  // watch config. Smallest threshold wins (one watchdog per set) — see
  // SetWatchdog for the rationale. Reset happens in the bridge on every
  // rep_finalized; cancel happens in finalizeSet.
  if (watch !== undefined) {
    armIdleWatchdog(state, setId, startedAt, watch, slotId);
  }
  return { setId };
}

/**
 * Arm the idle-timeout watchdog for `setId`. Picks the smallest
 * `idle_timeout_ms` threshold across `stopOn` + `notifyOn` (the larger
 * thresholds would never get to fire because the smallest wakes the
 * model first; see SetWatchdog for the policy). Returns silently when
 * no idle_timeout_ms specs are registered — the watch config may carry
 * only synchronous trigger types, in which case there's no watchdog to
 * arm.
 *
 * `onFire` reads the current LiveState snapshot at fire time so the
 * payload reflects whichever reps managed to land before the timeout
 * (or none, if the user pulled their hand back at startup). Auto-stop
 * is governed by whether the smallest threshold is on `stopOn`.
 */
export function armIdleWatchdog(
  state: ServerState,
  setId: string,
  setStartedAt: string,
  watch: WatchConfig,
  slotId: string = PRIMARY_SLOT,
): void {
  const smallest = smallestIdleSpec(watch);
  if (smallest === undefined) {
    return;
  }
  const idleMs = smallest.spec.value;
  state.setWatchdog.register(setId, idleMs, () => {
    fireIdleTimeout(state, setId, setStartedAt, smallest.spec, smallest.isStopOn, slotId);
  });
}

/**
 * Reset the watchdog deadline for `setId`. Called by the bridge after
 * every rep_finalized boundary so an active lifter never trips the
 * idle alarm. No-op when the set didn't register an idle spec.
 */
export function resetIdleWatchdog(state: ServerState, setId: string, watch?: WatchConfig): void {
  if (watch === undefined) return;
  const smallest = smallestIdleSpec(watch);
  if (smallest === undefined) return;
  const idleMs = smallest.spec.value;
  // Re-arm with the same onFire — read-time snapshot still works because
  // the closure captures setId and the spec, not stale rep data. The
  // watchdog is registered per-set and setIds are unique across slots
  // (LiveState mints them) so the bridge can re-arm without threading a
  // slot id; fireIdleTimeout discovers the right slot from the setId.
  state.setWatchdog.reset(setId, idleMs, () => {
    fireIdleTimeout(
      state,
      setId,
      /* setStartedAt — recomputed below */ '',
      smallest.spec,
      smallest.isStopOn,
      slotForSetId(state, setId),
    );
  });
}

/**
 * Reverse-lookup which slot owns the given `setId` by scanning live state
 * for a match. Each slot's `LiveState` mints UUIDs, so collisions are
 * astronomically unlikely; if the set is no longer active anywhere
 * (already finalized through some other path) we return `PRIMARY_SLOT`
 * defensively — the watchdog callback will then no-op once it finds
 * `live.snapshotSet()?.setId !== setId`.
 */
function slotForSetId(state: ServerState, setId: string): string {
  for (const slot of state.slots.values()) {
    if (slot.live.snapshotSet()?.setId === setId) {
      return slot.slotId;
    }
  }
  return PRIMARY_SLOT;
}

interface SmallestIdleSpec {
  spec: Extract<TriggerSpec, { type: 'idle_timeout_ms' }>;
  isStopOn: boolean;
}

/**
 * Pick the spec with the smallest threshold across stopOn + notifyOn.
 * `isStopOn=true` if the winning threshold appears in stopOn (a
 * stopOn:30s + notifyOn:60s registers the 30s as stopOn, since 30 < 60).
 * If the same threshold appears in both arrays, stopOn wins so the
 * coach's "abandon and end" intent takes priority over the soft notify.
 */
function smallestIdleSpec(watch: WatchConfig): SmallestIdleSpec | undefined {
  let best: SmallestIdleSpec | undefined;
  const consider = (spec: TriggerSpec, isStopOn: boolean): void => {
    if (spec.type !== 'idle_timeout_ms') return;
    if (best === undefined || spec.value < best.spec.value) {
      best = { spec, isStopOn };
    } else if (spec.value === best.spec.value && isStopOn) {
      // stopOn wins on tie — auto-stop intent dominates notify-only.
      best = { spec, isStopOn };
    }
  };
  for (const spec of watch.stopOn) consider(spec, true);
  for (const spec of watch.notifyOn) consider(spec, false);
  return best;
}

/**
 * Build + publish the `idle_timeout` channel event for the active set,
 * then auto-stop if the firing spec was on stopOn. Reads the current
 * LiveState snapshot so the payload reflects whichever reps closed
 * before the timeout. The dedupe key prevents double-fire if a stray
 * reset somehow re-arms the timer after expiry — defensive.
 */
function fireIdleTimeout(
  state: ServerState,
  setId: string,
  _setStartedAt: string,
  spec: Extract<TriggerSpec, { type: 'idle_timeout_ms' }>,
  isStopOn: boolean,
  slotId: string,
): void {
  const slot = getSlot(state, slotId);
  const set = slot.live.snapshotSet();
  if (set === undefined || set.setId !== setId) {
    // Set already ended through some other path between the timer queue
    // and this callback — silent drop.
    return;
  }
  const dedupeKey = `idle_timeout_ms:${spec.value}`;
  if (!slot.live.tryFireTrigger(dedupeKey)) {
    return;
  }
  const device = slot.live.snapshotDevice();
  // Compute "last rep at" — the timestamp anchoring the idle interval.
  // Without per-rep timestamps surfaced through the bridge we anchor on
  // set.startedAt for the zero-rep case; otherwise the most recent rep's
  // concentric.endTime gives us the moment the rep closed.
  const lastRepAt = (() => {
    if (set.reps.length === 0) {
      return set.startedAt;
    }
    const lastRep = set.reps[set.reps.length - 1];
    const t = lastRep.concentric.endTime;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
      return new Date(t).toISOString();
    }
    return set.startedAt;
  })();
  const payload = buildIdleTimeoutPayload(set, device, spec.value, spec.value, lastRepAt, isStopOn);
  state.channels.forSlot(slotId).publish(payload);
  if (isStopOn) {
    void finalizeSet(state, slotId, {
      cause: 'tool',
      disengageMotor: true,
      partialReason: 'auto_stopped',
      auto_stop_cause: 'idle_timeout_ms',
    }).catch((err) => {
      log.warn('set-tools: idle_timeout auto-stop finalize failed', err);
    });
  }
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

async function endSetTool(
  state: ServerState,
  slotIdInput: string | undefined,
): Promise<{ ok: true; reps: number }> {
  const slotId = slotIdInput ?? PRIMARY_SLOT;
  if (getSlot(state, slotId).live.set === undefined) {
    throw new ToolError('NO_ACTIVE_SET', 'No set is active. Call set.start first.');
  }
  // The explicit-tool path always disengages the motor (Workout.STOP) and
  // emits a `set_ended` event with no `partialReason`. Step 4 of P0
  // dual-Voltras threads the slot id all the way through `finalizeSet` so
  // bilateral flows close the right slot's set instead of always primary.
  const stored = await finalizeSet(state, slotId, { cause: 'tool', disengageMotor: true });
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
  slotId: string,
  opts: {
    cause: SetEndedCause;
    disengageMotor: boolean;
    partialReason?: 'auto_stopped';
    auto_stop_cause?: string;
  },
): Promise<StoredSet | undefined> {
  const slot = getSlot(state, slotId);
  if (slot.live.set === undefined) {
    return undefined;
  }
  const setId = slot.live.set.setId;
  // Cancel the idle watchdog as the very first step. Any termination
  // path (tool, device-signal, auto-stop, disconnect cascade) routes
  // through here, so this guarantees a stale timer never publishes
  // after the set has been considered finalized.
  state.setWatchdog.cancel(setId);
  // `live.endSet` is called without a `reason`: the explicit-tool path is a
  // graceful close, the device-signal path applies its
  // `partial=true / partialReason='device_signal'` stamp directly on the
  // finalized snapshot below, and the auto-stop path also stamps below
  // (so the partial-reason override lives in exactly one place).
  const finalized = slot.live.endSet();
  if (finalized === undefined) {
    return undefined;
  }

  if (opts.disengageMotor) {
    // Disengage the device motor between sets (Workout.STOP) so the cable
    // goes free while the user rests. SDK keeps the workout-mode session
    // open so a subsequent set.start can re-engage without re-arming. The
    // tool path and auto-stop path both run this; the device-signal path
    // skips it because the device already de-engaged on its own.
    await slot.client.endSet();
  }

  // Use the snapshot captured at `set.start`; fall back to the current
  // snapshot if it was somehow missing (defensive — should not happen).
  const device = state.setStartDeviceSnapshots.get(setId) ?? slot.live.snapshotDevice();
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
  // every set close currently triggers. Slot-scoped publisher so meta
  // carries `slot: slotId` for bilateral consumers.
  const payload = buildSetEndedPayload(stored, opts.cause, opts.auto_stop_cause);
  state.channels.forSlot(slotId).publish(payload);
  return stored;
}

async function liveMetrics(
  state: ServerState,
  slotIdInput: string | undefined,
): Promise<{ active: false } | ActiveSet> {
  const slotId = slotIdInput ?? PRIMARY_SLOT;
  const snapshot = getSlot(state, slotId).live.snapshotSet();
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
