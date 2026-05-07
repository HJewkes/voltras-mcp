// SDK event-bridge — funnels VoltraClient events into LiveState mutations
// and emits MCP `sendResourceUpdated` hints for the affected resource URIs.
//
// Wave 2C wiring (Task 09). Subscribes once per connect; the returned
// unsubscribe handles are kept on the slot (`slot.unwireBridge`) so a slot
// teardown / primary reset can detach listeners from the stale client before
// rebinding to a fresh one.
//
// ── Per-slot fan-out (Step 4 of P0 dual-Voltras) ──────────────────────────
//
// Bilateral lifts run two devices simultaneously, each owning its own slot.
// `wireEventBridge(state)` is the bootstrap orchestrator that calls
// `wireBridgeForSlot(state, slot)` for every slot currently in the slots map
// (today: just primary). New slots wire/unwire automatically through the
// `slot-manager.ts` lifecycle helpers (`createSlot` / `removeSlot` /
// `resetPrimarySlot`), which import `wireBridgeForSlot` directly. Each
// per-slot wirer captures the originating `slot.slotId` in its closures,
// so every published channel event is tagged with `slot: <slotId>` (via
// `state.channels.forSlot(...)`) and the autonomous `set_ended_by_device`
// finalize knows which slot's set to close.
//
// ── Event mapping ─────────────────────────────────────────────────────────
//
//   onFrame                     → buffer telemetry samples; detect rep cycle
//                                 completion via phase transitions; emit one
//                                 Rep at the *end* of each cycle.
//   onPerRep                    → debug-only — the device fires this at every
//                                 phase transition (pull start, return start),
//                                 so it produces ~2 splits per real rep. We
//                                 log it to the debug event buffer and
//                                 otherwise ignore it. Subscribing keeps the
//                                 listener slot bound so the SDK does not
//                                 buffer events.
//   onInProgress                → suppressed within a SET_START_GRACE_MS
//                                 window of `set.start` (the device fires
//                                 in-progress events in response to our
//                                 Workout.GO engage command, which would
//                                 otherwise reset the rep counter mid-set).
//                                 Outside the grace window WITH an active
//                                 set, the heartbeat is treated as the user
//                                 pressing Stop on the Voltra UI — the
//                                 bridge finalizes the set via the shared
//                                 `finalizeSet` helper, which persists,
//                                 clears live state, and emits the
//                                 `set_ended_by_device` channel event.
//                                 Outside the grace window with NO active
//                                 set, the event is a silent drop (the
//                                 explicit `set.end` tool already finalized;
//                                 LiveState's set is undefined and double-
//                                 firing is the race-condition guard).
//                                 (Critic gap Q6.)
//   onSettingsUpdate            → applySettings + notify voltra://device/current.
//                                 Also feeds the per-slot ModeRevertGuard
//                                 (Bug 22) so trainingMode drift inside the
//                                 detection window can latch a safety abort
//                                 visible to set.start, and synthesises a
//                                 `settings_update` channel event whenever
//                                 `damperLevel` transitions (Bug 27).
//   onStateDump                 → applyStateDump + notify voltra://device/current.
//                                 Synthesises a `settings_update` channel
//                                 event for each field that transitions
//                                 (assistMode, chainsActive, chainTargetTenths).
//                                 assistMode=8 is the device's idle sentinel
//                                 (no active fitness mode) — treated as the
//                                 "off" state for channel-event reporting (Bug 26).
//   onConnectionStateChange     → applySettings({ connected }) + notify
//                                 voltra://device/current. On 'disconnected'
//                                 also markDisconnected and notify both
//                                 voltra://session/active and
//                                 voltra://set/active (R24).
//
// ── Why frame-driven cycle detection ──────────────────────────────────────
//
// The SDK's BLE `rep_boundary` notification fires at every phase transition
// (the device-side decode comment confirms "end of concentric or eccentric"),
// so a single user-perceived rep produces two notifications: one at
// CONCENTRIC→ECCENTRIC and another at ECCENTRIC→IDLE. The pre-fix bridge
// invoked `live.appendRep` on each, doubling the rep count and splitting
// telemetry across two records. The fix is to ignore the device-level
// boundary entirely and detect cycle completion ourselves from the frame
// phase stream. A rep is considered complete when we observe the buffered
// frames cover a CONCENTRIC phase (with the user pulling) followed by an
// ECCENTRIC phase, then transition out of ECCENTRIC. Emitting at that
// transition guarantees one rep per pull-and-release cycle, matching the
// device UI's count.
//
// ── Notification fire-and-forget ──────────────────────────────────────────
//
// `Server.sendResourceUpdated` returns a `Promise<void>` because the
// underlying transport is async. The bridge invokes it synchronously and
// awaits nothing — a notification failure is not actionable from the event
// callback (it is best-effort per spec R14) and we do not want to delay the
// LiveState mutation. The promise is `void`-discarded to satisfy
// `no-floating-promises` linting.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  GuidedLoadState,
  InProgressEvent,
  PerRepEvent,
  PreSummaryEvent,
  SummaryEvent,
  TelemetryFrame,
} from '@voltras/node-sdk';
import { TrainingModeNames } from '@voltras/node-sdk';
import type { TrainingMode } from '@voltras/node-sdk';
import type { Rep, WorkoutSample } from '@voltras/workout-analytics';
import { randomUUID } from 'node:crypto';

import type { LiveState, DeviceSnapshot } from './live-state.js';
import { getDebugBuffers } from './debug-buffer.js';
import type { ChannelPublisher } from './channel-publisher.js';
import {
  buildConnectionChangedPayload,
  buildRepFinalizedPayload,
  buildSetPreSummaryPayload,
  buildSetTargetReachedPayload,
  buildSettingsUpdatePayload,
  buildVelocityLossExceededPayload,
  triggerDedupeKey,
  type ActiveSetAtDisconnect,
  type SettingsUpdateAll,
  type SettingsUpdateField,
} from './channel-payloads.js';
import type { ServerState, SlotState } from './server-state.js';
import type { TriggerSpec } from '../schemas/set.js';
import { finalizeSet, resetIdleWatchdog } from '../tools/set-tools.js';
import { log } from '../logger.js';

// The SDK declares a numeric `MovementPhase` enum with UNKNOWN = -1; the
// analytics-set state machine doesn't model UNKNOWN. Frames carrying it are
// dropped before reaching `live.processSample`.
const SDK_PHASE_UNKNOWN = -1;

// The settings-update payload is the SDK's protocol-layer `DeviceSettings`.
// Re-declared structurally here to avoid pulling in the protocol module's
// type path (which is not exported from the package's public entry).
//
// `damperLevel` was added in SDK 0.6.0's `VoltraDeviceSettings` and surfaces
// through this same callback when the cmd=0x10 cascade carries paramID
// 0x0351 (Bug 27 / B4 SDK PR #41 corrected the paramID from `5103` to
// `0351` at the decoder layer).
interface SdkSettingsUpdate {
  baseWeight?: number;
  weight?: number;
  chains?: number;
  inverseChains?: number;
  eccentric?: number;
  mode?: TrainingMode;
  trainingMode?: TrainingMode;
  battery?: number | null;
  damperLevel?: number;
}

// Structural mirror of SDK 0.7.0's `StateDumpEvent` (from the internal
// `src/voltra/protocol/types.ts`). Not imported from the public entry
// because `StateDumpEvent` is not re-exported from `@voltras/node-sdk`'s
// root `index.ts` — the bridge only consumes it via the `onStateDump`
// callback, so the structural alias is sufficient and keeps the bridge
// decoupled from the SDK's private module paths.
interface SdkStateDump {
  chainsActive: number;
  assistMode: number;
  chainTargetTenths: number;
  raw: Uint8Array;
}

const DEVICE_URI = 'voltra://device/current';
const SESSION_URI = 'voltra://session/active';
const SET_URI = 'voltra://set/active';

/**
 * Suppression window after `set.start`: any `onInProgress` event that
 * arrives within this many milliseconds of the set's `startedAt` is
 * treated as the device's echo of our Workout.GO engage command rather
 * than a user-pressed Stop. The chosen 500ms is empirically wide enough
 * to swallow the BLE round-trip jitter (~80–250ms in normal conditions)
 * without overlapping with the shortest realistic user-driven Stop.
 */
const SET_START_GRACE_MS = 500;

/**
 * Bootstrap orchestrator: wire the bridge for every slot currently in
 * `state.slots` and populate each slot's `unwireBridge` tear-down hook in
 * place. Each slot's listeners persist for the slot's lifetime and are torn
 * down when the slot is removed (`removeSlot`) or its client is replaced
 * (`resetPrimarySlot`). At bootstrap time only the primary slot exists;
 * new slots subscribe on allocation through `createSlot` (slot-manager.ts).
 *
 * Returns a single `unwireAll` function that tears down every per-slot
 * subscription. Mostly useful in tests; `runServer` keeps the
 * subscriptions for the process lifetime and lets `manager.dispose()`
 * clear listeners on shutdown.
 */
export function wireEventBridge(state: ServerState): () => void {
  const unwirers: Array<() => void> = [];
  for (const slot of state.slots.values()) {
    const unwire = wireBridgeForSlot(state, slot);
    slot.unwireBridge = unwire;
    unwirers.push(unwire);
  }
  return () => {
    for (const u of unwirers) {
      u();
    }
  };
}

/**
 * Subscribe the bridge to a single slot's `client`. Returns the unwire hook
 * the caller stashes on `slot.unwireBridge` so the slot can detach listeners
 * when its client is swapped or the slot itself is removed.
 *
 * Captures the slot reference in a closure so every event handler knows
 * which slot's `live` / `client` to operate on, and every published channel
 * event is auto-tagged with `slot: slot.slotId` via
 * `state.channels.forSlot(...)`. `finalizeSet` calls thread the slot id so
 * the autonomous device-signal path closes the correct slot's set instead
 * of always defaulting to primary.
 *
 * Tolerates `state.server === undefined` (test wiring that constructs a
 * partial ServerState) by skipping resource-updated notifications. The
 * channel + finalize paths still run so unit tests can observe them.
 */
export function wireBridgeForSlot(state: ServerState, slot: SlotState): () => void {
  const { client, live } = slot;
  const slotId = slot.slotId;
  const server = state.server;
  const channels = state.channels;
  const slotChannels = channels.forSlot(slotId);
  const debug = getDebugBuffers();
  const unsubs: Array<() => void> = [];
  // Latest known damperLevel; the bridge synthesizes a `settings_update`
  // channel event only on transition (Bug 27). Initialised to `undefined`
  // so the very first cmd=0x10 cascade carrying damperLevel emits a baseline
  // event — without that, cold-start consumers would never see the initial
  // damper value and would have to call `device.get_state` to discover it.
  let lastDamperLevel: number | undefined = undefined;
  // Latest known state-dump values; transitions synthesize `settings_update`
  // channel events (Bug 26 / C1). Initialised to `undefined` so the first
  // state-dump frame always emits a baseline event.
  let lastAssistMode: number | undefined = undefined;
  let lastChainsActive: number | undefined = undefined;
  let lastChainTargetTenths: number | undefined = undefined;

  // ── Sample-driven rep detection (canonical workout-analytics pipeline) ─
  //
  // Workout-analytics's `addSampleToSet` is the source of truth for
  // rep-boundary detection — it's what the mobile app uses, and it lives
  // inside `LiveState.processSample`. The bridge's only job here is to
  // convert each `TelemetryFrame` into a `WorkoutSample` and forward it.
  // The state machine (eccentric→concentric starts a new rep, IDLE folds
  // into hold time) is owned by the model. We do NOT subscribe to
  // `onPerRep` for state mutation — the device fires it at every phase
  // transition, which produces split reps. We do NOT subscribe to
  // `onInProgress` for state mutation either — the device emits it
  // continuously during workout mode, not just at end-of-set, and the set
  // lifecycle is owned by the explicit `set.start`/`set.end` tools.
  // Diagnostic raw-frame capture (SDK 0.6.2+). Fires for every inbound BLE
  // notification BEFORE decode, including frames the decoder can't classify
  // (cmd=0x10 family until Phase 1a lands). Pushed into the events ring as
  // a 'raw_frame' event for byte-level analysis. The client.onRawFrame
  // method itself is no-op on SDK <0.6.2; the optional-chain guards against
  // pre-0.6.2 SDK builds in case a consumer pins an older version.
  if (typeof client.onRawFrame === 'function') {
    pushUnsub(
      unsubs,
      client.onRawFrame((data: Uint8Array) => {
        debug.events.push({
          capturedAt: Date.now(),
          type: 'raw_frame',
          payload: {
            bytesHex: Buffer.from(data).toString('hex'),
            bytesLength: data.length,
          },
        });
      }),
    );
  }

  pushUnsub(
    unsubs,
    client.onFrame((frame: TelemetryFrame) => {
      debug.frames.push({
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        phase: frame.phase as unknown as number,
        position: frame.position,
        velocity: frame.velocity,
        force: frame.force,
      });

      if (live.snapshotSet() === undefined) return;

      const phase = frame.phase as unknown as number;
      if (phase === SDK_PHASE_UNKNOWN) return;

      const previousRepCount = live.snapshotSet()?.reps.length ?? 0;
      live.processSample({
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        phase: phase as unknown as WorkoutSample['phase'],
        position: frame.position,
        velocity: Math.abs(frame.velocity),
        force: Math.abs(frame.force),
      });
      const nextRepCount = live.snapshotSet()?.reps.length ?? 0;
      if (nextRepCount !== previousRepCount) {
        notify(server, SET_URI);
        // Publish a `rep_finalized` channel event only when a rep has
        // actually closed. Per workout-analytics's `addSampleToSet`:
        //   - The first CONCENTRIC sample creates rep 1 in-progress
        //     (length 0 -> 1). Nothing has finalized yet, so do not
        //     publish.
        //   - Every subsequent ECCENTRIC -> CONCENTRIC transition
        //     appends a new in-progress rep AND leaves the previously-
        //     final rep untouched. That's the moment the prior rep is
        //     "done" — it sits at index `nextRepCount - 2` while the new
        //     in-progress rep is at `nextRepCount - 1`.
        //   - The terminal rep (rep N) never closes via a phase
        //     transition; `set.end` -> `completeSet` finalizes it and
        //     the `set_ended` channel event from set-tools.ts covers
        //     that case.
        // Net coverage: reps 1..N-1 emit `rep_finalized` (each fires
        // when the *next* rep begins — small lag the coaching surface
        // should expect), and rep N is delivered inside `set_ended`.
        const set = live.snapshotSet();
        if (set !== undefined && set.reps.length >= 2) {
          const finalizedIndex = set.reps.length - 2;
          const finalizedRep = set.reps[finalizedIndex];
          const device = live.snapshotDevice();
          // The summary + structured rep/set_context payload is built
          // by `buildRepFinalizedPayload` so the channel-content
          // contract lives in one place (see channel-payloads.ts). The
          // model can read the summary line for an at-a-glance update
          // or drill into the JSON body for per-phase peak/mean
          // velocities, ROM, peak force, and rep_count_so_far without a
          // follow-up `set.get`.
          const payload = buildRepFinalizedPayload(
            finalizedRep,
            finalizedIndex,
            set,
            device,
            set.reps.length,
          );
          slotChannels.publish(payload);
          // Reset the idle watchdog — an active lifter must never trip
          // the abandonment alarm. Safe to call unconditionally; no-op
          // when the set has no idle_timeout_ms specs registered.
          if (set.watch !== undefined) {
            resetIdleWatchdog(state, set.setId, set.watch);
          }
          // Evaluate any registered trigger DSL specs against the
          // finalized rep. Trigger events publish BEFORE finalizeSet
          // (which publishes set_ended) so PT Claude reads
          // `<set_target_reached>` / `<velocity_loss_exceeded>` first
          // and `<set_ended>` second.
          evaluateRepTriggers(
            live,
            slotChannels,
            finalizedIndex,
            finalizedRep,
            device,
            state,
            slotId,
          );
        }
      }
    }),
  );

  pushUnsub(
    unsubs,
    client.onPerRep((payload: PerRepEvent) => {
      // Diagnostic capture: full device payload to debug ring so Phase 0
      // validation can verify setCounter/repCount/targetWeightTenths
      // ground truth. Bridge does not act on these fields yet.
      debug.events.push({
        capturedAt: Date.now(),
        type: 'rep_boundary',
        payload: {
          phase: payload.phase,
          frameCounter: payload.frameCounter,
          setCounter: payload.setCounter,
          repCount: payload.repCount,
          targetWeightTenths: payload.targetWeightTenths,
          bridgeRepsSoFar: live.snapshotSet()?.reps.length ?? 0,
        },
      });
    }),
  );

  pushUnsub(
    unsubs,
    client.onSummary((payload: SummaryEvent) => {
      // End-of-set vendor frame. Capture on the active set so the
      // finalize path can read-and-clear it for the persisted payload
      // (the `set_ended*` payload's `device_summary` block — see
      // `finalizeSet` in set-tools.ts and `buildSetEndedPayload`'s
      // `deviceSummary` parameter). No channel publish here — the
      // summary rides out on the `set_ended` event via
      // `consumeLatestSummary` to avoid a race between two events for
      // the same set.
      debug.events.push({
        capturedAt: Date.now(),
        type: 'summary',
        payload: {
          schemaVersion: payload.schemaVersion,
          setCounter: payload.setCounter,
          repCount: payload.repCount,
          rawHex: Buffer.from(payload.raw).toString('hex'),
          rawLength: payload.raw.length,
        },
      });
      live.applySummary(payload);
    }),
  );

  pushUnsub(
    unsubs,
    client.onPreSummary((payload: PreSummaryEvent) => {
      // Vendor `preSummary` frame — fires ~3s before the final rep with
      // early access to `repDurationMs` + `repCount`. Publishes the
      // `set_pre_summary` channel event so PT Claude can prep the
      // rest-period coaching prompt while the user finishes the rep.
      // Ghost preSummary after `set.end` already closed the set: silent
      // drop (the explicit tool finalize already cleared `live.set`).
      debug.events.push({
        capturedAt: Date.now(),
        type: 'pre_summary',
        payload: {
          schemaVersion: payload.schemaVersion,
          targetWeightTenths: payload.targetWeightTenths,
          repCount: payload.repCount,
          repDurationMs: payload.repDurationMs,
          rawHex: Buffer.from(payload.raw).toString('hex'),
          rawLength: payload.raw.length,
        },
      });
      const set = live.snapshotSet();
      if (set === undefined) {
        return;
      }
      const device = live.snapshotDevice();
      slotChannels.publish(buildSetPreSummaryPayload(set, device, payload));
    }),
  );

  pushUnsub(
    unsubs,
    client.onInProgress((payload: InProgressEvent) => {
      // Device emits this continuously during workout mode (~1 Hz
      // heartbeat) — most are noise (the firmware's response to our
      // Workout.GO engage command, fired ~immediately after
      // `set.start`).
      //
      // Bug 24 — Isometric auto-telemetry stream policy (D1):
      // When the user sets Isometric mode without first calling
      // `session.start`, the device starts a 500ms-cadence cmd=0x70
      // (aa 81 2b) keep-alive burst (A4 confirms cadence). Without a
      // gate, every burst frame would push a `set_boundary` debug event
      // tagged `hadActiveSet: false` — orphan events that pollute the
      // diagnostic surface and could confuse downstream consumers. The
      // policy: when there is no active SESSION at all, treat the
      // inProgress firehose as silent — drop without logging. We still
      // log when a session is active but no set is, because that case
      // surfaces the explicit set.end race-condition guard (see the
      // "outside the grace window with NO active set is a silent drop"
      // test in event-bridge.test.ts).
      const activeSession = live.snapshotSession();
      if (activeSession === undefined) {
        return;
      }
      //
      // Apply the payload to live state FIRST so `set.live_metrics`
      // reflects the most recent peak-force / velocity / target-weight
      // tick even within the SET_START_GRACE_MS grace window. Missing
      // the freshest tick on a Stop-press would lose the user's last
      // heartbeat in the live snapshot for no reason.
      //
      // After capture, the existing grace-window logic decides whether
      // the boundary represents the user pressing Stop on the unit
      // (outside the grace window with an active set ⇒ finalize via
      // `set_ended_by_device`) or just the firmware's echo (inside the
      // grace window ⇒ no finalize). Race-condition guard: when the
      // explicit `set.end` tool runs first, `live.snapshotSet()` is
      // already `undefined` by the time the firmware's echoing
      // Workout.STOP arrives, so the `if` below is a silent no-op.
      const activeSet = live.snapshotSet();
      if (activeSet !== undefined) {
        live.applyInProgress(payload, Date.now());
      }
      debug.events.push({
        capturedAt: Date.now(),
        type: 'set_boundary',
        payload: {
          hadActiveSet: activeSet !== undefined,
          peakForceTenths: payload.peakForceTenths,
          currentForceTenths: payload.currentForceTenths,
          velocityCmPerSec: payload.velocityCmPerSec,
          targetWeightTenths: payload.targetWeightTenths,
          rawHex: Buffer.from(payload.raw).toString('hex'),
          rawLength: payload.raw.length,
        },
      });
      if (activeSet === undefined) {
        return;
      }
      const startedMs = Date.parse(activeSet.startedAt);
      if (!Number.isFinite(startedMs) || Date.now() - startedMs < SET_START_GRACE_MS) {
        return;
      }
      notify(server, SET_URI);
      // Fire-and-forget the persist + publish chain. The void-discard
      // here is deliberate — the SDK callback signature is sync, and we
      // don't want a slow store.putSet to block other event handlers.
      // Errors are logged at warn so they're visible without crashing
      // the bridge.
      void finalizeSet(state, slotId, { cause: 'device_signal', disengageMotor: false }).catch(
        (err) => {
          log.warn('event-bridge: set_ended_by_device finalize failed', err);
        },
      );
    }),
  );

  // Guided-load (Phase 1g, SDK 0.6.3+, @experimental). Fires whenever the
  // SDK's polling loop decodes a fresh status-register read. The bridge's
  // contract here is exclusively about session/set CONTEXT — when the
  // device transitions into the direct-load state machine ('armed' /
  // 'countdown' / 'engaging' / 'active'), any rep_boundary or set_boundary
  // frames that follow MUST land on a real LiveState session+set so they
  // are not orphaned (Bugs 28 + 29 from the on-device 2026-05-06T21-38-19
  // session). If no session exists we mint one tagged "Guided Load
  // (auto)"; if no set exists inside that session we mint one too.
  // `onGuidedLoadState` is a pre-0.6.3 no-op when the SDK doesn't expose
  // it, so the optional-chain guards against older builds.
  if (typeof client.onGuidedLoadState === 'function') {
    pushUnsub(
      unsubs,
      client.onGuidedLoadState((gls: GuidedLoadState) => {
        debug.events.push({
          capturedAt: Date.now(),
          type: 'guided_load_state',
          payload: {
            phase: gls.phase,
            countdownRemainingMs: gls.countdownRemainingMs,
            fitnessModeRaw: gls.fitnessModeRaw,
          },
        });
        // Only auto-create on the "device is in the direct-load state
        // machine" phases — `idle`/`exited`/`timeout` carry no
        // attribution requirement. We do not auto-tear-down on
        // `exited`/`timeout`: the explicit `session.end`/`set.end` tools
        // remain authoritative for ending the auto-created bookkeeping,
        // which keeps the bridge's tear-down policy uniform across
        // explicit and auto-created sessions.
        if (
          gls.phase !== 'armed' &&
          gls.phase !== 'countdown' &&
          gls.phase !== 'engaging' &&
          gls.phase !== 'active'
        ) {
          return;
        }
        ensureGuidedLoadSessionAndSet(state, slot, slotId);
      }),
    );
  }

  pushUnsub(
    unsubs,
    client.onSettingsUpdate((settings: SdkSettingsUpdate) => {
      debug.events.push({
        capturedAt: Date.now(),
        type: 'settings_update',
        payload: {
          weight: settings.weight ?? settings.baseWeight ?? null,
          mode: settings.mode ?? settings.trainingMode ?? null,
          battery: settings.battery ?? null,
          damperLevel: settings.damperLevel ?? null,
          __all: Object.fromEntries(
            Object.entries(settings as Record<string, unknown>).filter(([, v]) => v !== undefined),
          ),
        },
      });
      live.applySettings(settingsToSnapshot(settings));
      notify(server, DEVICE_URI);

      // Bug 22 — feed the mode-revert guard. The guard ignores updates that
      // don't carry a trainingMode field; this call is safe to invoke
      // unconditionally regardless of which paramIDs the cascade actually
      // surfaced. `mode` and `trainingMode` are aliases at the wire layer
      // (different SDK versions used different field names); we collapse
      // them here for the guard.
      const incomingMode = settings.mode ?? settings.trainingMode;
      slot.modeRevertGuard.onSettingsUpdate(incomingMode);

      // Bug 27 — synthesize a `settings_update` channel event when
      // damperLevel transitions. The cmd=0x10 cascade carrying paramID
      // 0x0351 routes through this same callback (B4's SDK PR #41 corrects
      // the paramID from `5103` to `0351` at the decoder layer); we
      // observe the field on `settings.damperLevel` and only publish
      // when the value actually changes. The `__all` block in the payload
      // snapshots every monitored field at emission time so consumers
      // don't have to merge against a prior settings_update.
      if (settings.damperLevel !== undefined && settings.damperLevel !== lastDamperLevel) {
        lastDamperLevel = settings.damperLevel;
        const device = live.snapshotDevice();
        const all: SettingsUpdateAll = { damperLevel: settings.damperLevel };
        if (device.weightLbs !== undefined) all.weightLbs = device.weightLbs;
        if (device.trainingMode !== undefined) all.trainingMode = device.trainingMode;
        if (device.batteryPercent !== undefined) all.batteryPercent = device.batteryPercent;
        const payload = buildSettingsUpdatePayload('damperLevel', settings.damperLevel, all);
        slotChannels.publish(payload);
      }
    }),
  );

  // cmd=0x07 state-dump — exposes assist mode, chains-active flag, and chain
  // target weight. SDK 0.7.0 routes this through `onStateDump` (PR #41).
  // `onStateDump` is absent on older builds; the optional-chain guard keeps
  // backward compatibility with any pre-0.7.0 test fixtures.
  if (typeof client.onStateDump === 'function') {
    pushUnsub(
      unsubs,
      client.onStateDump((dump: SdkStateDump) => {
        debug.events.push({
          capturedAt: Date.now(),
          type: 'state_dump',
          payload: {
            assistMode: dump.assistMode,
            chainsActive: dump.chainsActive,
            chainTargetTenths: dump.chainTargetTenths,
          },
        });
        live.applyStateDump({
          assistMode: dump.assistMode,
          chainsActive: dump.chainsActive,
          chainTargetTenths: dump.chainTargetTenths,
        });
        notify(server, DEVICE_URI);

        synthStateDumpTransitions(
          dump,
          { lastAssistMode, lastChainsActive, lastChainTargetTenths },
          lastDamperLevel,
          live,
          slotChannels,
        );
        lastAssistMode = dump.assistMode;
        lastChainsActive = dump.chainsActive;
        lastChainTargetTenths = dump.chainTargetTenths;
      }),
    );
  }

  pushUnsub(
    unsubs,
    client.onConnectionStateChange((connState) => {
      debug.events.push({
        capturedAt: Date.now(),
        type: 'connection_state_change',
        payload: { state: connState },
      });
      // Snapshot the active set BEFORE any cascade so a
      // disconnect-mid-set payload still carries the set context.
      // `markDisconnected` does not currently clear the set in
      // LiveState, but taking the snapshot up front future-proofs
      // against that ordering changing.
      const activeSetBefore = live.snapshotSet();
      live.applySettings({ connected: connState === 'connected' });
      notify(server, DEVICE_URI);
      if (connState === 'disconnected') {
        live.markDisconnected(new Date().toISOString());
        notify(server, SESSION_URI);
        notify(server, SET_URI);
      }
      // Build the channel payload AFTER the LiveState mutations so the
      // device snapshot reflects post-transition state (notably the
      // `disconnectedAt` timestamp set by `markDisconnected`). The
      // active-set snapshot, on the other hand, is the pre-cascade copy.
      const activeSetForPayload: ActiveSetAtDisconnect | null =
        connState === 'disconnected' && activeSetBefore !== undefined
          ? {
              set_id: activeSetBefore.setId,
              rep_count_so_far: activeSetBefore.reps.length,
              weight_lbs: live.snapshotDevice().weightLbs ?? null,
              training_mode: live.snapshotDevice().trainingMode ?? null,
            }
          : null;
      const payload = buildConnectionChangedPayload(
        connState,
        live.snapshotDevice(),
        activeSetForPayload,
      );
      slotChannels.publish(payload);
    }),
  );

  // D4 — replay SDK-retained settings into LiveState synchronously after
  // wiring all listeners. SDK 0.7.0 (Bug 17 fix) no longer resets
  // `_settings` on `cleanup()`, so `client.settings` carries the last known
  // state across reconnect. Without this replay, `voltra://device/current`
  // shows a blank snapshot until the first `onSettingsUpdate` fires (which
  // requires the device to push a settings cascade — not guaranteed on
  // reconnect alone). The replay is idempotent: on a fresh connect
  // `client.settings` is null and the branch is skipped.
  const initialSettings = (client as unknown as { settings?: SdkSettingsUpdate | null }).settings;
  if (initialSettings != null) {
    live.applySettings(settingsToSnapshot(initialSettings));
  }

  return () => {
    for (const u of unsubs) {
      u();
    }
  };
}

/**
 * Capture an SDK `on*` return value as an unsubscribe entry. The SDK
 * documents its `on*` listeners as returning a `() => void` unsubscribe
 * handle, but the runtime / mock shape varies — some fakes return
 * `undefined`, and a few older paths return a plain `void`. We narrow at
 * the push site rather than scattering the guard across each subscription.
 */
function pushUnsub(unsubs: Array<() => void>, handle: unknown): void {
  if (typeof handle === 'function') {
    unsubs.push(handle as () => void);
  }
}

function notify(server: McpServer | undefined, uri: string): void {
  // Fire-and-forget: the notification is a best-effort poll hint per R14.
  // `server` is optional to keep test wirings (which build a partial
  // ServerState) from having to construct an McpServer just to observe
  // channel publishes — a missing server skips the resource hint.
  if (server === undefined) return;
  void server.server.sendResourceUpdated({ uri });
}

/**
 * Evaluate the active set's `watch` config against the just-finalized rep.
 * Publishes one channel event per matching spec (deduped via the active
 * set's `firedTriggers` ledger) and, if any `stopOn` spec matched, calls
 * `finalizeSet(partialReason='auto_stopped')` once after publishing.
 *
 * Synchronous trigger types only: `rep_count_reached` and
 * `velocity_loss_exceeded`. The `idle_timeout_ms` spec is handled via the
 * watchdog (sprint 2 commit 2), wired in `set-tools.ts:startSet`.
 *
 * Why publish before finalize: the channel ordering matters — the model
 * should see the trigger explanation (`<set_target_reached>`) BEFORE the
 * resulting `<set_ended>` so it can reason about why the set ended without
 * post-hoc inference. The finalize happens last, exactly once per rep,
 * even when multiple stopOn specs match.
 */
function evaluateRepTriggers(
  live: LiveState,
  channels: ChannelPublisher,
  finalizedIndex: number,
  finalizedRep: Rep,
  device: DeviceSnapshot,
  state: ServerState,
  slotId: string,
): void {
  const set = live.snapshotSet();
  if (set === undefined || set.watch === undefined) {
    return;
  }
  const actualReps = finalizedIndex + 1;
  // Baseline = highest peak concentric velocity across all finalized reps
  // up to and INCLUDING the just-finalized rep. This intentionally folds
  // the new rep into the baseline candidate set: when it's the new max,
  // baseline equals current and loss = 0% so nothing fires. That's the
  // desired behavior — a stronger rep should not trigger a loss event for
  // any prior threshold.
  const finalizedReps = set.reps.slice(0, finalizedIndex + 1);
  const baseline = peakConcentricBaseline(finalizedReps);
  const current = finalizedRep.concentric.peakVelocity;

  let stopFired = false;
  let stopCause: string | undefined;

  const evaluateSpec = (spec: TriggerSpec, isStopOn: boolean): void => {
    // Only the synchronous specs run in the rep_finalized loop. The
    // idle_timeout_ms spec arms a watchdog at set.start (commit 2) and
    // does not participate in this evaluator.
    if (spec.type === 'idle_timeout_ms') return;
    const key = triggerDedupeKey(spec);

    if (spec.type === 'rep_count_reached') {
      if (actualReps !== spec.value) return;
      if (!live.tryFireTrigger(key)) return;
      const payload = buildSetTargetReachedPayload(set, device, spec.value, actualReps, isStopOn);
      channels.publish(payload);
      if (isStopOn) {
        stopFired = true;
        stopCause = stopCause ?? spec.type;
      }
      return;
    }

    if (spec.type === 'velocity_loss_exceeded') {
      // baseline must be a real positive velocity for loss% to be defined.
      // current >= baseline ⇒ loss <= 0 ⇒ no fire (covers the just-set-a-
      // new-max case explicitly).
      if (baseline <= 0 || current >= baseline) return;
      const lossPct = (100 * (baseline - current)) / baseline;
      if (lossPct < spec.pct) return;
      if (!live.tryFireTrigger(key)) return;
      const baselineRepNumber = baselineRepNumberFor(finalizedReps);
      const payload = buildVelocityLossExceededPayload(
        set,
        device,
        spec.pct,
        lossPct,
        baseline,
        current,
        baselineRepNumber,
        actualReps,
        isStopOn,
      );
      channels.publish(payload);
      if (isStopOn) {
        stopFired = true;
        stopCause = stopCause ?? spec.type;
      }
      return;
    }
  };

  for (const spec of set.watch.notifyOn) {
    evaluateSpec(spec, false);
  }
  for (const spec of set.watch.stopOn) {
    evaluateSpec(spec, true);
  }

  if (stopFired && stopCause !== undefined) {
    void finalizeSet(state, slotId, {
      cause: 'tool',
      disengageMotor: true,
      partialReason: 'auto_stopped',
      auto_stop_cause: stopCause,
    }).catch((err) => {
      log.warn('event-bridge: trigger DSL auto-stop finalize failed', err);
    });
  }
}

/**
 * Highest peak concentric velocity across a rep array. Returns 0 when the
 * array is empty or no rep has a positive concentric peak.
 */
function peakConcentricBaseline(reps: readonly Rep[]): number {
  let max = 0;
  for (const rep of reps) {
    if (rep.concentric.peakVelocity > max) {
      max = rep.concentric.peakVelocity;
    }
  }
  return max;
}

/**
 * Rep number (1-indexed) at which the velocity-loss baseline was set —
 * the rep with the highest peak concentric velocity. Ties prefer the
 * earlier rep so the model can reason "baseline came from rep 1, current
 * from rep 8" without ambiguity.
 */
function baselineRepNumberFor(reps: readonly Rep[]): number {
  let best = 0;
  let idx = 0;
  for (let i = 0; i < reps.length; i++) {
    if (reps[i].concentric.peakVelocity > best) {
      best = reps[i].concentric.peakVelocity;
      idx = i;
    }
  }
  // repNumber is canonical when present; fall back to 1-indexed array
  // position for analytics' immutable rep shape.
  return reps[idx]?.repNumber ?? idx + 1;
}

/**
 * Map an SDK settings-update payload onto the `DeviceSnapshot` shape used by
 * `LiveState`. Coerces `battery: null → undefined` per critic FIX #6 (the
 * JSON output schema for `DeviceSnapshot` forbids null). The `weight` /
 * `baseWeight` and `mode` / `trainingMode` aliases reflect the dual naming
 * across `VoltraDeviceSettings` (high-level) and the protocol-layer
 * `DeviceSettings` notification payload.
 */
/**
 * Ensure a session and a set are open in `LiveState` for the supplied slot
 * so subsequent rep_boundary / set_boundary frames during a guided-load
 * flow have a real attribution target. Closes Bugs 28 + 29 (orphan rep
 * boundaries during direct-load) by giving the bridge an autonomous
 * session/set bootstrap path it can drive from the Phase 1g state machine.
 *
 * Persists a `StoredSession` row asynchronously (fire-and-forget) so the
 * sync mutator order — `live.startSession` → `live.startSet` — is not
 * gated on disk I/O. SQLite errors are logged but otherwise non-fatal:
 * the LiveState mutation already succeeded and the bridge's downstream
 * consumers (channels + resources) can keep running.
 *
 * Idempotent: a no-op when a session AND set are already active. When a
 * session is active but no set is, only the set is created (caller
 * already started a session via `session.start`). Mirrors the same
 * randomUUID + `state.setStartDeviceSnapshots` plumbing that the explicit
 * `set.start` tool uses so the finalize path's snapshot lookup behaves
 * identically.
 */
function ensureGuidedLoadSessionAndSet(state: ServerState, slot: SlotState, slotId: string): void {
  if (slot.live.session === undefined) {
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    slot.live.startSession({
      sessionId,
      startedAt,
      setIds: [],
      status: 'active',
      exerciseName: 'Guided Load (auto)',
    });
    // Persist the row so a downstream `metrics.compute` / `session.list`
    // can find it. Errors are logged; the in-memory session is the
    // source of truth for live attribution.
    void state.store
      .putSession({
        id: sessionId,
        startedAt,
        exerciseName: 'Guided Load (auto)',
      })
      .catch((err) => {
        log.warn('event-bridge: guided-load auto session persist failed', err);
      });
  }

  if (slot.live.set === undefined) {
    const session = slot.live.snapshotSession();
    if (session === undefined) return; // belt-and-braces; startSession just ran
    const setId = randomUUID();
    const startedAt = new Date().toISOString();
    slot.live.startSet({
      setId,
      sessionId: session.sessionId,
      startedAt,
      reps: [],
      status: 'active',
    });
    state.setStartDeviceSnapshots.set(setId, slot.live.snapshotDevice());
    void slotId; // slotId reserved for future per-slot channel notification
  }
}

/**
 * Synthesize `settings_update` channel events for each state-dump field that
 * transitioned. Called once per `onStateDump` after `applyStateDump` so the
 * live snapshot is already current when the payload's `__all` block is built.
 *
 * assistMode=8 is the firmware's idle sentinel (no active fitness mode); it
 * is reported as-is in the payload so consumers can distinguish "assist off"
 * (0) from "device idle" (8) if needed.
 */
function synthStateDumpTransitions(
  dump: SdkStateDump,
  prev: {
    lastAssistMode: number | undefined;
    lastChainsActive: number | undefined;
    lastChainTargetTenths: number | undefined;
  },
  knownDamperLevel: number | undefined,
  live: LiveState,
  channels: ChannelPublisher,
): void {
  const device = live.snapshotDevice();
  const all: SettingsUpdateAll = {
    assistMode: dump.assistMode,
    chainsActive: dump.chainsActive,
    chainTargetTenths: dump.chainTargetTenths,
  };
  if (device.weightLbs !== undefined) all.weightLbs = device.weightLbs;
  if (device.trainingMode !== undefined) all.trainingMode = device.trainingMode;
  if (device.batteryPercent !== undefined) all.batteryPercent = device.batteryPercent;
  if (knownDamperLevel !== undefined) all.damperLevel = knownDamperLevel;

  publishIfTransition('assistMode', dump.assistMode, prev.lastAssistMode, all, channels);
  publishIfTransition('chainsActive', dump.chainsActive, prev.lastChainsActive, all, channels);
  publishIfTransition(
    'chainTargetTenths',
    dump.chainTargetTenths,
    prev.lastChainTargetTenths,
    all,
    channels,
  );
}

function publishIfTransition(
  field: SettingsUpdateField,
  current: number,
  prev: number | undefined,
  all: SettingsUpdateAll,
  channels: ChannelPublisher,
): void {
  if (current === prev) return;
  channels.publish(buildSettingsUpdatePayload(field, current, all));
}

export function settingsToSnapshot(s: SdkSettingsUpdate): Partial<DeviceSnapshot> {
  const out: Partial<DeviceSnapshot> = {};
  const weight = s.weight ?? s.baseWeight;
  if (typeof weight === 'number') {
    out.weightLbs = weight;
  }
  const mode = s.mode ?? s.trainingMode;
  if (typeof mode === 'number') {
    out.trainingMode = TrainingModeNames[mode] ?? String(mode);
  }
  if (s.battery !== null && s.battery !== undefined) {
    out.batteryPercent = s.battery;
  }
  if (typeof s.damperLevel === 'number') {
    out.damperLevel = s.damperLevel;
  }
  return out;
}
