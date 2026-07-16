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
import { getPhaseMeanVelocity, getRepRangeOfMotion } from '@voltras/workout-analytics';

import { type ServerState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import {
  SetEndInput,
  SetGetInput,
  SetLiveMetricsInput,
  SetStartInput,
  type WatchConfig,
} from '../schemas/set.js';
import type { StoredRep, StoredSet } from '../store/types.js';
import { selectSetReps, type ActiveSet, type DeviceSnapshot } from '../state/live-state.js';
import { mmsToMps, mmToM } from '../state/live-signal.js';
import {
  buildIdleTimeoutPayload,
  buildSetAbortedByModeRevertPayload,
  buildBilateralDivergencePayload,
  buildSetEndedPayload,
  buildSetStartedPayload,
  buildWeightImpliedMismatchPayload,
  serializeRepForPayload,
  summarizePreviousSet,
  type SetEndedCause,
} from '../state/channel-payloads.js';
import { finalizeReps } from '../state/rep-finalize.js';
import { evaluateWeightImplied } from '../state/weight-implied-watch.js';
import type { ChannelPublisher } from '../state/channel-publisher.js';
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
  // VMCP-02.52: reject a second set.start that raced past the guard above
  // while a prior start is still mid-flight. The set isn't installed in
  // LiveState until after `await client.startRecording()` below, so without
  // this latch an interleaved call would mint a phantom setId and leak a
  // `setStartDeviceSnapshots` entry that no finalize path ever cleans up.
  if (slot.setStartInFlight === true) {
    throw new ToolError('SET_ALREADY_ACTIVE', 'A set is already being started on this slot.');
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
        `Motor not engaged. Recovery: (1) re-issue the setter cascade that targets ${requestedName} ` +
        `(e.g. device.set_mode); the latch auto-clears as soon as the device echoes back ${requestedName} ` +
        `within the detection window. (2) Or call session.end + session.start to drop the latched session ` +
        `state and start fresh. The current device mode is ${actualName} — use device.get_state to inspect ` +
        `the mode_revert_latched block before retrying.`,
    );
  }

  // Re-arm the guard for the upcoming engagement window. The user's
  // intent at this exact moment is the device's current trainingMode (the
  // guard rearm BEFORE startRecording so any device-side autonomous
  // revert that lands during the BLE round-trip is observed and latched
  // for the *next* set.start, since this current call has already
  // committed past the abort check).
  armModeRevertGuardForSet(slot);

  // Mint the set identity up front so the re-entrancy latch can wrap the
  // engage-and-install window without threading a possibly-unassigned setId.
  const setId = randomUUID();
  const startedAt = new Date().toISOString();

  // VMCP-02.52: hold the per-slot latch across the engage round-trip. Cleared
  // in `finally` once the set is installed — after which `live.set` (the
  // SET_ALREADY_ACTIVE guard) takes over blocking concurrent starts. A throw
  // from `startRecording` clears the latch too, so a retry can proceed.
  slot.setStartInFlight = true;
  try {
    // Engage the device motor — firmware-side equivalent of the "tap to load"
    // prompt on the unit. Without this the cable is free-running and no force
    // is applied. SDK: VoltraClient.startRecording → Workout.GO.
    await slot.client.startRecording();

    slot.live.startSet({
      setId,
      sessionId: session.sessionId,
      startedAt,
      reps: [],
      status: 'active',
      ...(watch !== undefined ? { watch } : {}),
    });
  } finally {
    slot.setStartInFlight = false;
  }
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
  // VMCP-01.59: echo the set-start onto the dashboard SSE stream so the client
  // can reset its live tempo bar. Fitness-units lifecycle metadata only.
  state.liveSignals?.emit({
    type: 'set',
    data: { kind: 'started', setId, sessionId: session.sessionId },
  });
  // VMCP-02.08: the next set has begun → cancel any in-flight rest_status
  // timer for this slot. No-op when no rest was active (cold start, or the
  // 5-minute cap already disposed it). Sits AFTER the set_started publish
  // so the lifecycle ordering on the channel is unambiguous: every
  // rest_status event for set-N lands before the set_started for set-N+1.
  state.restTimers.cancel(slotId, 'next_set');
  // Arm the idle-timeout watchdog when the watch config supplies an
  // `inactivityTimeoutMs`. Reset happens in the bridge on every
  // rep_finalized; cancel happens in finalizeSet. The watchdog fire path
  // ALWAYS finalizes the set as `partial` / `inactivity_timeout` and
  // disengages the motor — inactivity is the one remaining force-close
  // case (the user has truly walked away).
  if (watch !== undefined) {
    armIdleWatchdog(state, setId, startedAt, watch, slotId);
  }
  return { setId };
}

/**
 * Arm the inactivity watchdog for `setId` if the watch config supplies an
 * `inactivityTimeoutMs`. Returns silently when no inactivity threshold is
 * configured — the bridge's default `SET_INACTIVITY_TIMEOUT_MS` safety net
 * still applies via a separate per-slot timer in event-bridge.
 *
 * `onFire` reads the current LiveState snapshot at fire time so the
 * payload reflects whichever reps managed to land before the timeout
 * (or none, if the user pulled their hand back at startup). The watchdog
 * always finalizes as `partial` / `inactivity_timeout`; in the F14/F15
 * rewrite there is no longer a "notify-only" inactivity variant.
 */
export function armIdleWatchdog(
  state: ServerState,
  setId: string,
  setStartedAt: string,
  watch: WatchConfig,
  slotId: string = PRIMARY_SLOT,
): void {
  if (watch.inactivityTimeoutMs === undefined) {
    return;
  }
  const idleMs = watch.inactivityTimeoutMs;
  state.setWatchdog.register(setId, idleMs, () => {
    fireIdleTimeout(state, setId, setStartedAt, idleMs, slotId);
  });
}

/**
 * Reset the watchdog deadline for `setId`. Called by the bridge after
 * every rep_finalized boundary so an active lifter never trips the
 * idle alarm. No-op when the set didn't register an inactivity timeout.
 */
export function resetIdleWatchdog(state: ServerState, setId: string, watch?: WatchConfig): void {
  if (watch === undefined || watch.inactivityTimeoutMs === undefined) return;
  const idleMs = watch.inactivityTimeoutMs;
  // Re-arm with the same onFire — read-time snapshot still works because
  // the closure captures setId, not stale rep data. The watchdog is
  // registered per-set and setIds are unique across slots (LiveState mints
  // them) so the bridge can re-arm without threading a slot id;
  // fireIdleTimeout discovers the right slot from the setId.
  state.setWatchdog.reset(setId, idleMs, () => {
    fireIdleTimeout(state, setId, '', idleMs, slotForSetId(state, setId));
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

/**
 * Build + publish the `idle_timeout` channel event for the active set,
 * then force-close as `partial` / `inactivity_timeout`. Reads the current
 * LiveState snapshot so the payload reflects whichever reps closed before
 * the timeout. The dedupe key prevents double-fire if a stray reset
 * somehow re-arms the timer after expiry — defensive.
 *
 * F14/F15 rewrite: inactivity is the only retained force-close path. The
 * user has truly abandoned the set; freeing the slot is a server-side
 * resource-management responsibility, not a coaching decision.
 */
function fireIdleTimeout(
  state: ServerState,
  setId: string,
  _setStartedAt: string,
  thresholdMs: number,
  slotId: string,
): void {
  const slot = getSlot(state, slotId);
  const set = slot.live.snapshotSet();
  if (set === undefined || set.setId !== setId) {
    // Set already ended through some other path between the timer queue
    // and this callback — silent drop.
    return;
  }
  const dedupeKey = `inactivity_timeout:${thresholdMs}`;
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
  const payload = buildIdleTimeoutPayload(set, device, thresholdMs, thresholdMs, lastRepAt);
  state.channels.forSlot(slotId).publish(payload);
  void finalizeSet(state, slotId, {
    cause: 'tool',
    disengageMotor: true,
    partialReason: 'inactivity_timeout',
  }).catch((err) => {
    log.warn('set-tools: inactivity-timeout finalize failed', err);
  });
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
 * Shared finalize sequence used by the explicit `set.end` tool, the bridge's
 * autonomous device-signal handler, the inactivity-watchdog force-close,
 * AND the `device.exit_guided_load` reap path. Returns the persisted set on
 * success, or `undefined` when no set was active (autonomous callers treat
 * this as a silent drop; the tool caller turns it into NO_ACTIVE_SET).
 *
 * F14/F15 rewrite: there is no longer a watch-trigger force-close path.
 * Watch triggers publish advisory channel events only; the canonical set
 * close comes from the device's `aa 85 5f` disengage signal or the user's
 * explicit `set.end` tool call. The only remaining force-close paths are
 * inactivity (the user walked away), disconnect, session_end cascade, and
 * the guided-load reap.
 *
 * `disengageMotor` should be `true` for the tool / inactivity paths (we
 * explicitly stop recording so the cable goes free for rest) and `false`
 * for the device-signal path — the device has already de-engaged on its
 * own, and an extra `Workout.STOP` would be a no-op at best and a
 * connection-state churn at worst.
 *
 * `cause` is `'tool'` for tool / auto-create reap / inactivity paths and
 * `'device_signal'` for the autonomous device-signal close. In the unified
 * payload (`event_type='set_ended'`) it flows through to `meta.closed_by`.
 *
 * `partialReason` flags the row as partial. `'device_signal'` is no longer
 * a partial reason — a device-driven close is the canonical natural close.
 * The tool path with no partialReason is a graceful close.
 */
export async function finalizeSet(
  state: ServerState,
  slotId: string,
  opts: {
    cause: SetEndedCause;
    disengageMotor: boolean;
    partialReason?: 'inactivity_timeout' | 'guided_load_exited' | 'session_end';
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
  // Harvest the device-asserted summary BEFORE `endSet` — once `endSet`
  // discards the active set, the captured `latestSummary` goes with it.
  // Symmetric across both finalize paths (tool-driven `set_ended` and
  // bridge-driven `set_ended_by_device`): if an `onSummary` arrived during
  // the set's lifetime, the resulting payload carries the `device_summary`
  // block; if it never arrived (mid-set disconnect, abrupt close), the
  // block is omitted.
  const deviceSummary = slot.live.consumeLatestSummary();
  const deviceSetSummary = slot.live.consumeLatestSetSummary();
  // F14 (VMCP-01.28): inactivity-timeout force-close fires while a rep is
  // potentially in-progress; the trailing rep in the analytics-set may be
  // concentric-only with no eccentric phase (`addSampleToSet` opens a new
  // rep on the eccentric→concentric edge). Persisting it inflates the
  // rep count and pollutes vbt_summary.last_rep_v. Drop before persistence
  // only for the inactivity-timeout path. Device-signal close, graceful
  // tool close, and the guided-load reap all leave the trailing rep alone
  // — those are intentional close moments where the analytics output is
  // already the right shape.
  const dropTrailingInProgress = opts.partialReason === 'inactivity_timeout';
  const finalized = slot.live.endSet(undefined, { dropTrailingInProgress });
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
  //
  // F4 (VMCP-01.19) + VMCP-02.57: the guided-load auto-create path
  // snapshots at `armed` time, before the device's settings_update has
  // propagated the target weight, so the start snapshot holds a stale
  // pre-target `weightLbs`. Re-snapshot live for EVERY guided-load-
  // originated set — the natural device-signal close, not just the
  // `guided_load_exited` reap — so the persisted header reflects the
  // weight the reps were actually performed at (bench 2026-07-05: header
  // read 30 for a set done entirely at 50). Symmetric with how trigger
  // DSL / device-signal paths fall back when no start-snapshot exists.
  const startSnapshot = state.setStartDeviceSnapshots.get(setId);
  const isGuidedLoadSet =
    finalized.autoCreatedBy === 'guided_load' || opts.partialReason === 'guided_load_exited';
  const device = isGuidedLoadSet
    ? slot.live.snapshotDevice()
    : (startSnapshot ?? slot.live.snapshotDevice());
  state.setStartDeviceSnapshots.delete(setId);

  // Stamp partial only when an explicit reason was supplied. F14/F15
  // rewrite: device-signal close is no longer "partial" — it's the
  // canonical natural set close. The old logic stamped
  // `partialReason='device_signal'` on every onSetSummary close, which
  // mislabeled the intentional disengage as something went wrong.
  const finalizedWithCause: ActiveSet =
    opts.partialReason !== undefined
      ? { ...finalized, status: 'partial', partialReason: opts.partialReason }
      : finalized;
  // VMCP-02.29 PR5: route the persisted rep array through the configured rep
  // source. Default `'analytics'` returns the set unchanged (byte-identical
  // stored set + vbt_summary); `'firmware'` swaps in the firmware-anchored
  // enriched reps, which feeds toStoredSet -> stored.reps -> computeVbtSummary.
  const finalizedForStore = selectSetReps(finalizedWithCause, state.config?.repSource);
  // VMCP-02.66/02.65/02.69a: correct the rep array once, here, so the persisted
  // set and the `set_ended` payload (built from `stored` below) share the same
  // de-artifacted / idle-truncated / re-peaked reps. The movement-class-dependent
  // segmentation corrections (02.66/02.65) stay dark behind VMCP_REP_CORRECTIONS
  // until the VW-16 bench parity run; 02.69a signed peaks always run.
  const correctedForStore: ActiveSet = {
    ...finalizedForStore,
    reps: finalizeReps(finalizedForStore.reps, {
      segmentationCorrections: state.config?.repCorrections === 'on',
    }),
  };
  const stored = toStoredSet(correctedForStore, device);
  await state.store.putSet(stored);
  // Push a lifecycle event so a channel-enabled host wakes the model on set
  // close. The payload carries the full rep array plus a pre-computed VBT
  // summary (first/last rep velocity + velocity-loss %), so PT Claude can
  // skip the set.get + metrics.compute vbt.set retrieval calls that almost
  // every set close currently triggers. Slot-scoped publisher so meta
  // carries `slot: slotId` for bilateral consumers.
  const payload = buildSetEndedPayload(
    stored,
    opts.cause,
    deviceSummary,
    deviceSetSummary,
    finalized.firmwareTotalRepCount,
  );
  const slotChannels = state.channels.forSlot(slotId);
  slotChannels.publish(payload);
  // VW-57: the terminal rep (rep N) never fires a phase-transition
  // `rep_finalized`, so event-bridge's `onFrame` SSE tap only ever streams reps
  // 1..N-1 (it emits rep k when rep k+1 *begins*; rep N has no successor). Echo
  // the final rep onto the SSE stream here — the ONE choke point both close
  // paths (tool `set.end` and device `onSetSummary`) funnel through — so the
  // dashboard live tiles get rep N's rom/vCon/peakVelocity/peakForce without
  // waiting for the next 500 ms snapshot poll. Emitted BEFORE the `set ended`
  // signal below so the wire order is `rep(N)` -> `set(ended)`. Reuses the exact
  // WA derivations event-bridge uses for reps 1..N-1 (fitness units only — m/s,
  // m, lbs — no protocol bytes). No double-emit: the `onFrame` tap tops out at
  // rep N-1, so rep N is streamed exactly once, here.
  const terminalRep = correctedForStore.reps[correctedForStore.reps.length - 1];
  if (terminalRep !== undefined) {
    const peakConcentricForce = correctedForStore.reps.reduce(
      (max, rep) => Math.max(max, rep.concentric.peakForce),
      0,
    );
    state.liveSignals?.emit({
      type: 'rep',
      data: {
        repIndex: correctedForStore.reps.length,
        vCon: mmsToMps(getPhaseMeanVelocity(terminalRep.concentric)),
        rom: mmToM(getRepRangeOfMotion(terminalRep)),
        peakVelocity: mmsToMps(terminalRep.concentric.peakVelocity),
        peakForceSoFar: peakConcentricForce,
      },
    });
  }
  // VMCP-01.59: echo the set-end onto the dashboard SSE stream so the client
  // clears its live tempo bar back to the non-live (per-rep-summary) mode.
  state.liveSignals?.emit({
    type: 'set',
    data: { kind: 'ended', setId: stored.id, sessionId: stored.sessionId },
  });
  // VMCP-02.68: advisory flag when the force-implied weight disagrees with the
  // logged header weight (stale/mis-recorded header). VMCP-02.67: reconcile the
  // per-side rep count against the paired bilateral set. Both are advisory
  // channel events only — they never mutate the persisted set.
  publishWeightImpliedMismatch(stored, slotId, slotChannels);
  publishBilateralDivergence(state, slotId, stored);
  // VMCP-02.08 / VMCP-02.54: optionally kick off the passive rest_status
  // emission cycle. Starts AFTER the set_ended publish so a channel-consumer
  // receives both the set_ended and the initial (t=0) rest_status in
  // deterministic order. Gated on two conditions:
  //   - `config.restTimer === 'on'` — opt-in (default off). The automatic
  //     rest stream is noise for callers that don't consume it.
  //   - `partialReason !== 'session_end'` — a session.end cascade tears down
  //     the owning session (VMCP-02.50/#95 routes its open-set close through
  //     finalizeSet), so arming a rest timer here would emit rest_status
  //     pushes for a session that no longer exists (VMCP-02.54).
  // The disconnect handler still cancels its slot's rest timer explicitly, so
  // a force-close-during-disconnect never leaves a live timer.
  if (state.config?.restTimer === 'on' && opts.partialReason !== 'session_end') {
    state.restTimers.start(slotId, stored.id, slotChannels);
  }
  return stored;
}

/**
 * VMCP-02.68: publish a `weight_implied_mismatch` event when the set's
 * force-implied weight disagrees with the stored header weight past the
 * configured ratio. No-op when the set has no positive force telemetry or the
 * disagreement is within tolerance (`evaluateWeightImplied` returns null / an
 * unflagged result).
 */
function publishWeightImpliedMismatch(
  stored: StoredSet,
  slotId: string,
  channels: ChannelPublisher,
): void {
  const result = evaluateWeightImplied(stored.weightLbs, stored.reps);
  if (result === null || !result.flagged) {
    return;
  }
  channels.publish(buildWeightImpliedMismatchPayload(stored, result, slotId));
}

/**
 * VMCP-02.67: feed this set close to the bilateral reconciler and publish a
 * `bilateral_divergence` event when it pairs with a prior opposite-slot close
 * whose rep count differs. Cross-slot, so it publishes on the top-level
 * (non-slot-scoped) channel. Silently skipped when no reconciler is wired
 * (test states that pre-date the feature) — mirrors the coercion-watch
 * passthrough convention.
 */
function publishBilateralDivergence(state: ServerState, slotId: string, stored: StoredSet): void {
  const divergence = state.bilateralReconciler?.record({
    slotId,
    setId: stored.id,
    sessionId: stored.sessionId,
    startedAtMs: Date.parse(stored.startedAt),
    repCount: stored.reps.length,
    weightLbs: stored.weightLbs,
  });
  if (divergence === undefined) {
    return;
  }
  state.channels.publish(buildBilateralDivergencePayload(divergence));
}

async function liveMetrics(
  state: ServerState,
  slotIdInput: string | undefined,
): Promise<{ active: false } | ActiveSet> {
  const slotId = slotIdInput ?? PRIMARY_SLOT;
  const snapshot = getSlot(state, slotId).live.snapshotSet();
  if (snapshot === undefined) {
    return Promise.resolve({ active: false });
  }
  // VMCP-02.29 PR5: project the live rep buffer onto the configured rep
  // source. Default `'analytics'` returns the snapshot unchanged.
  return Promise.resolve(selectSetReps(snapshot, state.config?.repSource));
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
    // VMCP-02.64: persist the per-rep derived VBT block so cross-session
    // trending reads the finalized values without recomputing from samples.
    derived: serializeRepForPayload(rep),
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
