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
// `state.channels.forSlot(...)`) and the autonomous device-signal finalize
// knows which slot's set to close.
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
//                                 The pre-noble heuristic ("first
//                                 onInProgress after the grace window
//                                 finalizes the set") was retired —
//                                 onInProgress now only refreshes
//                                 LiveState's `latestInProgress` for
//                                 `set.live_metrics` reads. Canonical
//                                 per-set close in WT/RB/Damper flows
//                                 through `onSetSummary` (`aa 85 5f`)
//                                 and emits `set_ended` with
//                                 `meta.closed_by='device'`. (Critic gap
//                                 Q6.)
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
//                                 (assistMode, trainingModeRaw,
//                                 chainTargetForceTenths, weightLbsTenths,
//                                 eccentricPercentTenths). Frames where
//                                 `trainingMode === Idle (0)` are dropped
//                                 entirely — these are the transitional
//                                 mid-mode-switch frames that produce
//                                 `assistMode 2↔0↔2` burst noise without
//                                 carrying any stable post-switch state.
//                                 assistMode=8 is the device's idle sentinel
//                                 (no active fitness mode) — surfaced as-is in
//                                 channel events and `device.get_state` so
//                                 consumers can distinguish `0` (off) /
//                                 `2` (on) / `8` (idle) (Bug 26).
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
  SetSummaryEvent,
  SummaryEvent,
  TelemetryFrame,
} from '@voltras/node-sdk';
import { TrainingMode, TrainingModeNames } from '@voltras/node-sdk';
import type { Rep, WorkoutSample } from '@voltras/workout-analytics';
import { randomUUID } from 'node:crypto';

import type { LiveState, DeviceSnapshot } from './live-state.js';
import { getDebugBuffers } from './debug-buffer.js';
import type { ChannelPublisher } from './channel-publisher.js';
import {
  buildConnectionChangedPayload,
  buildPendingDisconnectNotice,
  buildGuidedLoadStatePayload,
  buildModeDivergedPayload,
  buildIdleRepPayload,
  buildIdleRepSummaryPayload,
  buildRepFinalizedPayload,
  buildSetPreSummaryPayload,
  buildSetTargetReachedPayload,
  buildSettingCoercedPayload,
  buildSettingsUpdatePayload,
  buildVelocityLossExceededPayload,
  baselineRepNumberFor,
  peakConcentricBaseline,
  triggerDedupeKey,
  type ActiveSetAtDisconnect,
  type CoercionSetContext,
  type SettingsUpdateAll,
  type SettingsUpdateField,
} from './channel-payloads.js';
import { activeModeName } from './active-mode.js';
import type { ModeDivergence } from './mode-divergence-watch.js';
import type { CoercionWatch } from './coercion-watch.js';
import type { ServerState, SlotState } from './server-state.js';
import { armIdleWatchdog, finalizeSet, resetIdleWatchdog } from '../tools/set-tools.js';
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
// 0x0351.
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

// Structural mirror of SDK 0.7.x's `StateDumpEvent` (from the internal
// `src/voltra/protocol/types.ts`). Not imported from the public entry
// because `StateDumpEvent` is not re-exported from `@voltras/node-sdk`'s
// root `index.ts` — the bridge only consumes it via the `onStateDump`
// callback, so the structural alias is sufficient and keeps the bridge
// decoupled from the SDK's private module paths.
//
// Field offsets validated on-device in session E (2026-05-07); see
// `voltra-private/research/cmd-0x07-variable-layout-fix-2026-05-08.md`.
// `trainingMode` here is a raw byte (0 = transitional / mid-mode-switch,
// 1 = WeightTraining, 2 = ResistanceBand); the bridge uses the SDK's
// numeric `TrainingMode` enum for typed comparisons.
interface SdkStateDump {
  trainingMode: TrainingMode;
  assistMode: number;
  weightLbsTenths: number;
  chainTargetForceTenths: number;
  eccentricPercentTenths: number;
  raw: Uint8Array;
}

const DEVICE_URI = 'voltra://device/current';
const SESSION_URI = 'voltra://session/active';
const SET_URI = 'voltra://set/active';

// Per-slot URI builders. The legacy static URIs above remain as
// primary-slot aliases (Phase 0.5.2 backwards-compat); every notify also
// fans out to the templated `voltra://<kind>/{slot}/<sub>` form so
// bilateral consumers subscribing to the templated URI receive pushes too.
const deviceUriForSlot = (slotId: string): string => `voltra://device/${slotId}/current`;
const sessionUriForSlot = (slotId: string): string => `voltra://session/${slotId}/active`;
const setUriForSlot = (slotId: string): string => `voltra://set/${slotId}/active`;

/**
 * Inactivity safety-net: the bridge finalizes an active set as `partial` /
 * `inactivity_timeout` if no SDK activity (`onInProgress` / `onSetSummary` /
 * WA rep boundary) lands on it for this many milliseconds. 90s is wide
 * enough to cover heavy slow lifts (15s+ per rep) plus a brief mid-set
 * pause, but short enough that a forgotten or disconnected set surfaces
 * before the user starts a new session.
 *
 * In WT/RB/Damper modes the device's `onSetSummary` (`aa 85 5f`) is the
 * canonical per-set close marker and the watchdog rarely fires. Modes that
 * don't emit a per-set close (rowing, iso, custom-curves) fall through to
 * this watchdog for v1.
 *
 * Replaces the legacy `SET_START_GRACE_MS = 500` heuristic, which used the
 * first `onInProgress` outside a 500ms window after `set.start` as the
 * close signal — wrong on noble + fast-tempo WT (the device fires
 * `onInProgress` continuously during workout mode, so the post-grace event
 * arrives well before the user finishes reps). See
 * `coordination/integration-plans/mcp-rep-count-fix-2026-05-09.md` and
 * `voltra-private/captures/sessions/validation-phase-6-set-boundaries-2026-05-06T20-12-57.events.json`.
 */
const SET_INACTIVITY_TIMEOUT_MS = 90_000;

/**
 * Polling cadence for the inactivity watchdog (per slot). 10s is far below
 * the 90s timeout so worst-case detection latency is one tick. Cheap because
 * we run it once per slot and it only inspects the active set's
 * `lastActivityAt` field.
 */
const SET_INACTIVITY_POLL_MS = 10_000;

/**
 * Cadence for the batched `idle_rep_summary` channel event (VMCP-02.11).
 * The bridge accumulates idle-rep boundaries detected while no MCP set is
 * armed and emits a single summary per window so the channel doesn't drown
 * in per-rep noise during long rests. Empty windows are skipped — the
 * timer fires every 5s but only publishes when at least one idle rep was
 * recorded in the window.
 *
 * Verbose mode (`session.start { verboseIdleReps: true }`) bypasses the
 * batch entirely and emits per-occurrence `idle_rep` events as before.
 */
const IDLE_REP_SUMMARY_WINDOW_MS = 5_000;

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
  // Per-slot accumulator for the batched `idle_rep_summary` emission
  // (VMCP-02.11). `sinceMs` is set when the first rep of a window lands
  // (Date.now() at that moment); the timer below reads + resets the batch
  // every IDLE_REP_SUMMARY_WINDOW_MS. Verbose mode bypasses the accumulator
  // entirely (count stays 0).
  const idleRepBatch = { count: 0, sinceMs: 0 };
  // Latest known state-dump values; transitions synthesize `settings_update`
  // channel events (Bug 26 / C1). Initialised to `undefined` so the first
  // state-dump frame always emits a baseline event.
  //
  // VMCP-02.40: `chainTargetForceTenths` and `weightLbsTenths` are no longer
  // tracked here — they were the firmware's lazily-computed effective-force
  // values, false-positive on the Damper→WeightTraining mode-bounce and stale
  // across cmd=0x10 cascade writes. User-facing chain/weight transitions are
  // now sourced from the cmd=0x10 cascade (see `lastChainSettingLbs` /
  // `lastBaseWeight` below).
  let lastAssistMode: number | undefined = undefined;
  let lastTrainingModeRaw: number | undefined = undefined;
  let lastEccentricPercentTenths: number | undefined = undefined;
  // VMCP-02.40: cmd=0x10 cascade-sourced user-set values. Transition publish
  // for `settings_update` channel events lives in the `onSettingsUpdate`
  // handler below — fires when the cmd=0x10 echo carries a new value, which
  // is the reliable per-write signal (state-dump's offset 5-6 / offset 3-4
  // are lazy and unsuitable for this purpose).
  let lastChainSettingLbs: number | undefined = undefined;
  let lastBaseWeight: number | undefined = undefined;
  // VMCP-02.03: last guided-load phase published to the channel. The SDK
  // re-fires `onGuidedLoadState` on every countdown tick; gating the channel
  // publish on a phase change collapses intra-countdown spam to one event per
  // transition (the debug event still records every tick).
  let lastGuidedLoadPhase: string | undefined = undefined;

  // VMCP-02.09c: publish a `mode_diverged` channel event when the slot's
  // ModeDivergenceWatch reports a persistent requested≠applied disagreement.
  // Names are read from the live snapshot at emit time (the same fields
  // surfaced as requested_mode / active_mode by VMCP-02.09a), which the
  // triggering settings_update / state_dump has just refreshed.
  const publishModeDivergence = (div: ModeDivergence): void => {
    const device = live.snapshotDevice();
    const set = live.snapshotSet();
    const session = live.snapshotSession();
    slotChannels.publish(
      buildModeDivergedPayload({
        requestedMode: device.trainingMode ?? null,
        activeMode: activeModeName(device.trainingModeRaw),
        divergedForMs: div.divergedForMs,
        setId: set?.setId,
        sessionId: session?.sessionId ?? set?.sessionId,
      }),
    );
  };

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

      const phase = frame.phase as unknown as number;
      if (phase === SDK_PHASE_UNKNOWN) return;

      const sample: WorkoutSample = {
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        phase: phase as unknown as WorkoutSample['phase'],
        position: frame.position,
        velocity: frame.velocity,
        force: frame.force,
      };

      // ── Idle-arm rep detection ────────────────────────────────────────────
      // When no MCP set is active, route frames through the idle analytics
      // pipeline. A rep boundary in the idle pipeline means the user lifted
      // a rep that will NOT be captured by any `set.start`/`set.end` pair.
      // We record it on LiveState so the PT skill can detect the gap and
      // surface it to the user.
      //
      // Emission policy (VMCP-02.11):
      //   * Default: accumulate into `idleRepBatch`; the 5s timer below
      //     publishes a single `idle_rep_summary` per window.
      //   * Verbose (`session.start { verboseIdleReps: true }`): emit a
      //     per-occurrence `idle_rep` event as before AND suppress the
      //     summary path (the batch counter stays at 0 so the timer
      //     no-ops). Single source of truth: the session's
      //     `verboseIdleReps` flag read fresh on every rep so a future
      //     mid-session toggle would take effect immediately.
      if (live.set === undefined) {
        const idleRep = live.processIdleSample(sample);
        if (idleRep !== null) {
          const entry = live.recordIdleRep(idleRep, slotId);
          if (live.session?.verboseIdleReps === true) {
            slotChannels.publish(buildIdleRepPayload(entry, live.idleRepCount));
          } else {
            if (idleRepBatch.count === 0) {
              idleRepBatch.sinceMs = Date.now();
            }
            idleRepBatch.count += 1;
          }
        }
        return;
      }

      const previousRepCount = live.snapshotSet()?.reps.length ?? 0;
      live.processSample(sample);
      const nextRepCount = live.snapshotSet()?.reps.length ?? 0;
      if (nextRepCount !== previousRepCount) {
        notifySlot(server, slotId, SET_URI, setUriForSlot);
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
          // finalized rep. F14/F15 rewrite: triggers are advisory cues
          // only — they publish channel events so the model can voice-
          // coach the user, but they never force-close the set. The
          // canonical set close comes from the device's `aa 85 5f`
          // disengage signal or the user's explicit `set.end` tool call.
          evaluateRepTriggers(live, slotChannels, finalizedIndex, finalizedRep, device);
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
    client.onSetSummary((payload: SetSummaryEvent) => {
      // Vendor `aa 85 5f` set-summary frame — emitted by the device per-set
      // in WT/RB/Damper after all reps complete (renamed from `preSummary`
      // in SDK 0.9.0; the legacy "fires ~3s before final rep" docstring was
      // a misnomer — see voltra-private/research/aa-subtype-catalog-2026-05-07-android-deep.md
      // §7.5). Publishes the `set_pre_summary` channel event so PT Claude
      // can hand the rest-period coaching prompt right at set close.
      // Ghost setSummary after `set.end` already closed the set: silent
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
      // Capture the typed payload onto the active set + close immediately.
      // `aa 85 5f` is the canonical per-set close marker in WT/RB/Damper —
      // it fires after all reps complete with the final rep count, not
      // before. `finalizeSet` reads `consumeLatestSetSummary()` and threads
      // the device's repCount/repDurationMs/targetWeightTenths into the
      // persisted `set_ended` event payload (with `meta.closed_by='device'`).
      //
      // Modes that don't emit a per-set close (rowing, iso, custom-curves)
      // fall through to the inactivity watchdog defined below
      // (`SET_INACTIVITY_TIMEOUT_MS`).
      live.applySetSummary(payload);
      notifySlot(server, slotId, SET_URI, setUriForSlot);
      void finalizeSet(state, slotId, { cause: 'device_signal', disengageMotor: false }).catch(
        (err) => {
          log.warn('event-bridge: set_ended_by_device finalize failed', err);
        },
      );
    }),
  );

  pushUnsub(
    unsubs,
    client.onInProgress((payload: InProgressEvent) => {
      // Device emits this continuously during workout mode (~1 Hz
      // heartbeat). The bridge no longer treats `onInProgress` as a
      // close signal — that heuristic (`SET_START_GRACE_MS = 500ms`)
      // terminated fast-tempo WT sets prematurely under noble (sets
      // ended at 1–3s capturing 0–2 of 8–12 actual reps). Per-set
      // close in WT/RB/Damper now flows through `onSetSummary`
      // (`aa 85 5f`); modes without a per-set close marker fall
      // through to the inactivity watchdog.
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
      // surfaces the explicit set.end race-condition guard.
      const activeSession = live.snapshotSession();
      if (activeSession === undefined) {
        return;
      }
      // Apply the payload to live state so `set.live_metrics` reflects
      // the freshest peak-force / velocity / target-weight tick.
      const activeSet = live.snapshotSet();
      if (activeSet !== undefined) {
        live.applyInProgress(payload, Date.now());
        // Activity bump for the inactivity watchdog. Reset on every
        // tick during an active set so the 90s timer effectively
        // measures gap-since-last-frame, not gap-since-set-start.
        live.markActivity(Date.now());
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
    }),
  );

  // Inactivity watchdog: per-slot polling timer that finalizes the active
  // set as `partial` / `inactivity_timeout` if no SDK activity has landed
  // for `SET_INACTIVITY_TIMEOUT_MS`. Activity = onInProgress, onSetSummary,
  // or any WA rep boundary (each bumps `live.markActivity`). Fires on
  // every tick of `SET_INACTIVITY_POLL_MS`; the test layer can replace
  // `setInterval` via dependency injection if a deterministic clock is
  // needed. Cleanup goes through the slot's `unsubs` list.
  const inactivityTimer = setInterval(() => {
    const set = live.snapshotSet();
    if (set === undefined || set.lastActivityAt === undefined) {
      return;
    }
    if (Date.now() - set.lastActivityAt < SET_INACTIVITY_TIMEOUT_MS) {
      return;
    }
    void finalizeSet(state, slotId, {
      cause: 'tool',
      disengageMotor: true,
      partialReason: 'inactivity_timeout',
    }).catch((err) => {
      log.warn('event-bridge: inactivity-timeout finalize failed', err);
    });
  }, SET_INACTIVITY_POLL_MS);
  unsubs.push(() => clearInterval(inactivityTimer));

  // Idle-rep summary timer (VMCP-02.11). Fires every
  // IDLE_REP_SUMMARY_WINDOW_MS; emits a single `idle_rep_summary` channel
  // event when `idleRepBatch.count > 0`, then resets the counter. Empty
  // windows are intentionally silent (no zero-count summaries) so a long
  // rest produces one summary per active 5s segment, not a steady stream
  // of empties. The verbose path never increments `count` so this timer
  // stays a quiet no-op when `verboseIdleReps` is on.
  const idleRepSummaryTimer = setInterval(() => {
    if (idleRepBatch.count === 0) {
      return;
    }
    const now = Date.now();
    const payload = buildIdleRepSummaryPayload({
      slot: slotId,
      count: idleRepBatch.count,
      idleRepCount: live.idleRepCount,
      sinceMs: idleRepBatch.sinceMs,
      untilMs: now,
      windowMs: IDLE_REP_SUMMARY_WINDOW_MS,
    });
    slotChannels.publish(payload);
    idleRepBatch.count = 0;
    idleRepBatch.sinceMs = 0;
  }, IDLE_REP_SUMMARY_WINDOW_MS);
  unsubs.push(() => clearInterval(idleRepSummaryTimer));

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
        // Auto-create a session+set on the "device is in the direct-load
        // state machine" phases — `idle`/`exited`/`timeout` carry no
        // attribution requirement. We do not auto-tear-down on
        // `exited`/`timeout`: the explicit `session.end`/`set.end` tools
        // remain authoritative for ending the auto-created bookkeeping,
        // which keeps the bridge's tear-down policy uniform across
        // explicit and auto-created sessions. Runs before the channel
        // publish so the `armed` event already carries the new set_id.
        if (
          gls.phase === 'armed' ||
          gls.phase === 'countdown' ||
          gls.phase === 'engaging' ||
          gls.phase === 'active'
        ) {
          ensureGuidedLoadSessionAndSet(state, slot, slotId);
        }

        // VMCP-02.03: promote the phase machine to a first-class channel
        // event, published once per phase transition. `idle` is the baseline
        // resting state and carries no coaching signal, so it is not
        // published; every other phase (including the terminal `exited` /
        // `timeout`) emits so agents can branch on `outcome` in real time.
        if (gls.phase !== 'idle' && gls.phase !== lastGuidedLoadPhase) {
          const guidedSession = slot.live.snapshotSession();
          const guidedSet = slot.live.snapshotSet();
          slotChannels.publish(
            buildGuidedLoadStatePayload({
              phase: gls.phase,
              countdownRemainingMs: gls.countdownRemainingMs,
              requestedTargetLbs: slot.pendingGuidedLoadTargetLbs,
              setId: guidedSet?.setId,
              sessionId: guidedSession?.sessionId ?? guidedSet?.sessionId,
            }),
          );
        }
        lastGuidedLoadPhase = gls.phase;

        // VMCP-02.03: clear the requested-target stash on the terminal phases
        // so a stale target can't leak into a later guided-load flow on this
        // slot. (The exercise/inactivity stashes are single-shot-cleared on
        // consume; this one is read on every transition, so it clears here.)
        if (gls.phase === 'exited' || gls.phase === 'timeout') {
          delete slot.pendingGuidedLoadTargetLbs;
        }
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
      const wasStale = live.isStale();
      live.applySettings(settingsToSnapshot(settings));
      notifySlot(server, slotId, DEVICE_URI, deviceUriForSlot);

      // Phase 0.5.1 soft-reset: the first device push after a reconnect
      // clears the staleness flag and emits a `connection_changed` event
      // with the freshly-confirmed device snapshot. Distinguishes "we have
      // a live cable" from "we cached pre-disconnect state".
      if (wasStale) {
        live.clearStaleness();
        const refreshedDevice = live.snapshotDevice();
        const payload = buildConnectionChangedPayload('connected', refreshedDevice, null);
        slotChannels.publish(payload);
      }

      // Feed the mode-revert guard. The guard ignores updates that don't
      // carry a trainingMode field; this call is safe to invoke
      // unconditionally regardless of which paramIDs the cascade actually
      // surfaced. `mode` and `trainingMode` are aliases at the wire layer
      // (different SDK versions used different field names); we collapse
      // them here for the guard.
      const incomingMode = settings.mode ?? settings.trainingMode;
      slot.modeRevertGuard.onSettingsUpdate(incomingMode);

      // VMCP-02.09c: feed the requested side of the divergence watch. Emits a
      // `mode_diverged` event if this requested mode disagrees with the last
      // applied (cmd=0x07) mode past the debounce window.
      const requestedDivergence = slot.modeDivergenceWatch.onRequested(incomingMode);
      if (requestedDivergence !== null) {
        publishModeDivergence(requestedDivergence);
      }

      // Synthesize `settings_update` channel events when the cmd=0x10
      // cascade carries a new value for any of the user-set fields the
      // bridge surfaces. The `__all` block in the payload snapshots every
      // monitored field at emission time so consumers don't have to merge
      // against a prior settings_update.
      //
      // VMCP-02.40: chain + base-weight transitions publish from this
      // handler (not from `synthStateDumpTransitions`), so the channel
      // event reflects the user-set value as soon as the cmd=0x10 echo
      // lands. The state-dump's `chainTargetForceTenths` /
      // `weightLbsTenths` were the prior source but are firmware-internal
      // lazy values; sourcing here removes the false-positive class.
      const incomingWeight = settings.weight ?? settings.baseWeight;
      if (settings.damperLevel !== undefined && settings.damperLevel !== lastDamperLevel) {
        lastDamperLevel = settings.damperLevel;
        publishCmd10SettingsUpdate('damperLevel', settings.damperLevel, live, slotChannels);
      }
      if (typeof settings.chains === 'number' && settings.chains !== lastChainSettingLbs) {
        lastChainSettingLbs = settings.chains;
        publishCmd10SettingsUpdate('chainSettingLbs', settings.chains, live, slotChannels);
      }
      if (typeof incomingWeight === 'number' && incomingWeight !== lastBaseWeight) {
        lastBaseWeight = incomingWeight;
        publishCmd10SettingsUpdate('weightLbs', incomingWeight, live, slotChannels);
      }

      // F2/F3 coercion correlation: walk every field the SDK surfaced and
      // ask the slot's CoercionWatch whether it matches a recently-fired
      // setter at a coerced value. VMCP-02.40 routes chain + weight
      // coercion-watch through this cmd=0x10 cascade path (the only frame
      // that reliably reflects the post-write user-set value); only ecc
      // and assistMode remain observed in `onStateDump` below.
      observeSettingsUpdateCoercions(settings, slot.coercionWatch, live, slotChannels, slotId);
    }),
  );

  // cmd=0x07 state-dump — exposes assist mode, active training mode, weight,
  // effective chain target force, and eccentric overload. SDK 0.7.0+ routes
  // this through `onStateDump`. `onStateDump` is absent on older builds; the
  // optional-chain guard keeps backward compatibility with any pre-0.7.0
  // test fixtures.
  //
  // Mode-switch bursts emit ~4 cmd=0x07 frames in ~130ms; two carry the new
  // mode value, two carry transitional `trainingMode=0` (Idle) frames with
  // assistMode flicker. Suppress the transitional frames entirely (no
  // LiveState mutation, no channel events, no resource notify) so consumers
  // never see the `assistMode 2↔0↔2` oscillation. Investigation:
  // voltra-private/research/cmd-0x07-variable-layout-fix-2026-05-08.md.
  if (typeof client.onStateDump === 'function') {
    pushUnsub(
      unsubs,
      client.onStateDump((dump: SdkStateDump) => {
        debug.events.push({
          capturedAt: Date.now(),
          type: 'state_dump',
          payload: {
            assistMode: dump.assistMode,
            trainingMode: dump.trainingMode,
            weightLbsTenths: dump.weightLbsTenths,
            chainTargetForceTenths: dump.chainTargetForceTenths,
            eccentricPercentTenths: dump.eccentricPercentTenths,
          },
        });

        // Drop transitional / mid-mode-switch burst frames before any
        // observable side effect. The next ~130ms will carry the stable
        // post-switch frame; suppressing here keeps `device.get_state`
        // and the `voltra://device/current` resource showing the last
        // stable state instead of momentarily flipping to zeroes.
        if (dump.trainingMode === TrainingMode.Idle) {
          return;
        }

        live.applyStateDump({
          assistMode: dump.assistMode,
          trainingModeRaw: dump.trainingMode,
          weightLbsTenths: dump.weightLbsTenths,
          chainTargetForceTenths: dump.chainTargetForceTenths,
          eccentricPercentTenths: dump.eccentricPercentTenths,
        });
        notifySlot(server, slotId, DEVICE_URI, deviceUriForSlot);

        // VMCP-02.09c: feed the applied side of the divergence watch (the
        // transitional Idle frame was already dropped above). Emits a
        // `mode_diverged` event if this applied mode disagrees with the last
        // requested (cmd=0x10) mode past the debounce window.
        const appliedDivergence = slot.modeDivergenceWatch.onApplied(dump.trainingMode);
        if (appliedDivergence !== null) {
          publishModeDivergence(appliedDivergence);
        }

        synthStateDumpTransitions(
          dump,
          {
            lastAssistMode,
            lastTrainingModeRaw,
            lastEccentricPercentTenths,
          },
          lastDamperLevel,
          live,
          slotChannels,
        );
        lastAssistMode = dump.assistMode;
        lastTrainingModeRaw = dump.trainingMode;
        lastEccentricPercentTenths = dump.eccentricPercentTenths;

        // F2/F3 coercion correlation for state-dump fields. Run after
        // applyStateDump so the device snapshot embedded in the published
        // payload reflects post-frame state.
        observeStateDumpCoercions(dump, slot.coercionWatch, live, slotChannels, slotId);
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
      // Capture the device id alongside `connected: true` so the resource
      // and `device.get_state` can surface which device was last bound to
      // this slot even after `resetPrimarySlot` swaps in a fresh client and
      // wipes `client.connectedDeviceId`. On 'disconnected' we leave the
      // last-known id in place — the snapshot is explicitly stale.
      const settingsDelta: Partial<DeviceSnapshot> = {
        connected: connState === 'connected',
      };
      if (connState === 'connected' && typeof client.connectedDeviceId === 'string') {
        settingsDelta.deviceId = client.connectedDeviceId;
      }
      live.applySettings(settingsDelta);
      notifySlot(server, slotId, DEVICE_URI, deviceUriForSlot);
      if (connState === 'disconnected') {
        live.markDisconnected(new Date().toISOString());
        notifySlot(server, slotId, SESSION_URI, sessionUriForSlot);
        notifySlot(server, slotId, SET_URI, setUriForSlot);
        // VMCP-02.08: kill any in-flight rest_status timer for this slot —
        // the trainer is no longer in a rest period if the device is gone.
        // Idempotent no-op when no rest was active.
        state.restTimers.cancel(slotId, 'disconnect');
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
      // VMCP-02.32: stash a one-shot advisory for the tool-return path so the
      // agent still learns of a drop that lands while push channels are off —
      // drained onto the next device.get_state / bilateral.cascade. Advisory
      // only; the bridge never force-stops the set here.
      if (connState === 'disconnected') {
        live.recordPendingDisconnectNotice(
          buildPendingDisconnectNotice(live.snapshotDevice(), activeSetForPayload),
        );
      }
      slotChannels.publish(payload);
    }),
  );

  // SDK 0.7.1+ replays the cached settings cascade through `onSettingsUpdate`
  // at listener-attach time, so the bridge does not need an explicit
  // `client.settings` read here — every fresh wire-up receives the last-
  // known cascade through the standard event path.

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
 * Fire a resource-updated hint for the slot's templated URI AND, when
 * `slotId === 'primary'`, also for the legacy static URI alias. This lets
 * pre-Phase-0.5.2 callers that subscribed to `voltra://device/current`
 * keep receiving pushes while bilateral consumers of
 * `voltra://device/{slot}/current` get a per-slot push.
 */
function notifySlot(
  server: McpServer | undefined,
  slotId: string,
  legacyUri: string,
  buildSlotUri: (slotId: string) => string,
): void {
  notify(server, buildSlotUri(slotId));
  if (slotId === 'primary') {
    notify(server, legacyUri);
  }
}

/**
 * Evaluate the active set's `watch.notifyOn` config against the just-
 * finalized rep. Publishes one channel event per matching spec (deduped
 * via the active set's `firedTriggers` ledger). Does NOT finalize the set.
 *
 * F14/F15 rewrite: in the prior design, `stopOn` specs auto-finalized the
 * set when matched. Hardware capture 2026-05-11 showed this racing with
 * user motion — a `rep_count_reached: 5` trigger fired after rep 5,
 * wrote `Workout.STOP` mid-rep-6, and ripped the cable mid-eccentric.
 * The user dropped the auto-stop semantics entirely; triggers are now
 * advisory cues. The model voice-coaches the user to "rack it — that's
 * your 5", the user finishes their cycle naturally, and the device's
 * `aa 85 5f` disengage signal becomes the canonical set close.
 *
 * Synchronous trigger types only: `rep_count_reached` and
 * `velocity_loss_exceeded`. Inactivity timeout is handled via the
 * watchdog wired in `set-tools.ts:startSet` — that's still a force-close
 * because abandonment frees server resources.
 */
function evaluateRepTriggers(
  live: LiveState,
  channels: ChannelPublisher,
  finalizedIndex: number,
  finalizedRep: Rep,
  device: DeviceSnapshot,
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

  for (const spec of set.watch.notifyOn) {
    const key = triggerDedupeKey(spec);

    if (spec.type === 'rep_count_reached') {
      if (actualReps !== spec.value) continue;
      if (!live.tryFireTrigger(key)) continue;
      const payload = buildSetTargetReachedPayload(set, device, spec.value, actualReps);
      channels.publish(payload);
      continue;
    }

    if (spec.type === 'velocity_loss_exceeded') {
      // baseline must be a real positive velocity for loss% to be defined.
      // current >= baseline ⇒ loss <= 0 ⇒ no fire (covers the just-set-a-
      // new-max case explicitly).
      if (baseline <= 0 || current >= baseline) continue;
      const lossPct = (100 * (baseline - current)) / baseline;
      if (lossPct < spec.pct) continue;
      if (!live.tryFireTrigger(key)) continue;
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
      );
      channels.publish(payload);
      continue;
    }
  }
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
    // VMCP-02.13: inherit the exercise identity the `start_guided_load` tool
    // stashed (single-shot), so the auto-session is filterable by exercise.
    // Fall back to the generic label when the caller supplied no name.
    const exerciseName = slot.pendingGuidedLoadExerciseName ?? 'Guided Load (auto)';
    const exerciseId = slot.pendingGuidedLoadExerciseId;
    delete slot.pendingGuidedLoadExerciseName;
    delete slot.pendingGuidedLoadExerciseId;
    slot.live.startSession({
      sessionId,
      startedAt,
      setIds: [],
      status: 'active',
      exerciseName,
      ...(exerciseId !== undefined ? { exerciseId } : {}),
      autoCreatedBy: 'guided_load',
    });
    // Persist the row so a downstream `metrics.compute` / `session.list`
    // can find it. Errors are logged; the in-memory session is the
    // source of truth for live attribution.
    void state.store
      .putSession({
        id: sessionId,
        startedAt,
        exerciseName,
        ...(exerciseId !== undefined ? { exerciseId } : {}),
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
    // F4 (VMCP-01.19): the start-snapshot is captured here but the
    // device's `weightLbs` hasn't yet propagated from the guided-load
    // target write — settings_update lands a tick or two later. The
    // exit-reap path in `device.exit_guided_load` lazily re-snapshots
    // from `slot.live.snapshotDevice()` so the persisted row reflects
    // the target weight, not the pre-guided-load value.
    state.setStartDeviceSnapshots.set(setId, slot.live.snapshotDevice());
    // VMCP-02.15: arm a tight per-set inactivity watchdog so a failed
    // guided-load engagement reaps quickly instead of leaving a zombie
    // set sitting for ~90s (the bridge's default safety net) or 120s+
    // (legacy default). The threshold is the value the `start_guided_load`
    // tool stashed on `slot.pendingGuidedLoadInactivityMs` (defaults to
    // 30s, caller-overridable). Single-shot — clear after consumption so
    // a subsequent set.start on this slot uses its own watch config.
    // When the field is absent (rare path: armed-without-tool, e.g.
    // user triggered guided load directly on the unit), fall back to no
    // extra watchdog — the bridge's default `SET_INACTIVITY_TIMEOUT_MS`
    // safety net still applies.
    const guidedInactivityMs = slot.pendingGuidedLoadInactivityMs;
    if (typeof guidedInactivityMs === 'number') {
      armIdleWatchdog(
        state,
        setId,
        startedAt,
        { notifyOn: [], inactivityTimeoutMs: guidedInactivityMs },
        slotId,
      );
      delete slot.pendingGuidedLoadInactivityMs;
    }
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
    lastTrainingModeRaw: number | undefined;
    lastEccentricPercentTenths: number | undefined;
  },
  knownDamperLevel: number | undefined,
  live: LiveState,
  channels: ChannelPublisher,
): void {
  const device = live.snapshotDevice();
  // VMCP-02.40: state-dump-derived `chainTargetForceTenths` and
  // `weightLbsTenths` are kept in the `__all` block for diagnostic context
  // but no longer drive per-field `settings_update` channel events — those
  // transitions now publish from `onSettingsUpdate` (cmd=0x10 cascade)
  // under `chainSettingLbs` / `weightLbs`, where the values reflect the
  // user-set state per-write instead of the firmware's lazy effective
  // force.
  const all: SettingsUpdateAll = {
    assistMode: dump.assistMode,
    trainingModeRaw: dump.trainingMode,
    chainTargetForceTenths: dump.chainTargetForceTenths,
    weightLbsTenths: dump.weightLbsTenths,
    eccentricPercentTenths: dump.eccentricPercentTenths,
  };
  if (device.weightLbs !== undefined) all.weightLbs = device.weightLbs;
  if (device.trainingMode !== undefined) all.trainingMode = device.trainingMode;
  if (device.batteryPercent !== undefined) all.batteryPercent = device.batteryPercent;
  if (knownDamperLevel !== undefined) all.damperLevel = knownDamperLevel;
  if (device.chainSettingLbs !== undefined) all.chainSettingLbs = device.chainSettingLbs;

  publishIfTransition('assistMode', dump.assistMode, prev.lastAssistMode, all, channels);
  publishIfTransition(
    'trainingModeRaw',
    dump.trainingMode,
    prev.lastTrainingModeRaw,
    all,
    channels,
  );
  publishIfTransition(
    'eccentricPercentTenths',
    dump.eccentricPercentTenths,
    prev.lastEccentricPercentTenths,
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

/**
 * VMCP-02.40: publish a `settings_update` channel event for a cmd=0x10
 * cascade-sourced field transition (damperLevel, chainSettingLbs, weightLbs).
 * Composes the `__all` block from the just-updated LiveState snapshot so
 * consumers see the post-write value for the changed field alongside the
 * latest known values for the other tracked fields.
 */
function publishCmd10SettingsUpdate(
  field: SettingsUpdateField,
  current: number,
  live: LiveState,
  channels: ChannelPublisher,
): void {
  const device = live.snapshotDevice();
  const all: SettingsUpdateAll = {};
  if (device.damperLevel !== undefined) all.damperLevel = device.damperLevel;
  if (device.chainSettingLbs !== undefined) all.chainSettingLbs = device.chainSettingLbs;
  if (device.weightLbs !== undefined) all.weightLbs = device.weightLbs;
  if (device.trainingMode !== undefined) all.trainingMode = device.trainingMode;
  if (device.batteryPercent !== undefined) all.batteryPercent = device.batteryPercent;
  channels.publish(buildSettingsUpdatePayload(field, current, all));
}

/**
 * Walk an `onSettingsUpdate` payload's coercion-eligible fields and ask the
 * slot's CoercionWatch whether any of them matches a recently-fired setter
 * at a coerced value. Publishes one `setting_coerced` channel event per hit.
 *
 * VMCP-02.40: chain + base-weight coercion observation lives here (cmd=0x10
 * cascade is the only frame that reliably reflects the user-set chain /
 * weight per-write). The state-dump-derived `chainTargetForceTenths` and
 * `weightLbsTenths` are the firmware's lazily-computed effective force at
 * the cable — observed against requested user values they false-positive on
 * mode-bounce transients and stale across writes. The diagnostic at
 * `coordination/HANDOFF-2026-05-21-coercion-watch-field-source.md` carries
 * the byte-level evidence.
 *
 * Fields observed here (all cmd=0x10-sourced, whole-pound units):
 *   * `damperLevel` — direct passthrough (no unit conversion).
 *   * `chains` — user-set chain force in lbs.
 *   * `baseWeight` — user-set base weight in lbs.
 *
 * State-dump-only fields (`assistMode`, `eccentricPercentTenths`) are still
 * observed in the `onStateDump` handler — they have no cmd=0x10 echo today
 * (eccentric may move here in a follow-up once a cmd=0x10 source is wired).
 */
function observeSettingsUpdateCoercions(
  settings: SdkSettingsUpdate,
  watch: CoercionWatch,
  live: LiveState,
  channels: ChannelPublisher,
  slotId: string,
): void {
  if (typeof settings.damperLevel === 'number') {
    observeCoercion('damperLevel', settings.damperLevel, watch, live, channels, slotId);
  }
  if (typeof settings.chains === 'number') {
    observeCoercion('chains', settings.chains, watch, live, channels, slotId);
  }
  const weight = settings.weight ?? settings.baseWeight;
  if (typeof weight === 'number') {
    observeCoercion('baseWeight', weight, watch, live, channels, slotId);
  }
}

/**
 * Walk an `onStateDump` payload's coercion-eligible fields. Publishes one
 * `setting_coerced` event per hit.
 *
 * VMCP-02.40: chain + weight observations moved to
 * `observeSettingsUpdateCoercions` (cmd=0x10 path). Only `assistMode` and
 * `eccentricPercentTenths` remain here — they have no cmd=0x10 echo today.
 * Eccentric's `eccentricPercentTenths` has the documented 80→320→0
 * transient burst defused by the 2-of-2 stability counter; a follow-up may
 * route eccentric through cmd=0x10 too.
 */
function observeStateDumpCoercions(
  dump: SdkStateDump,
  watch: CoercionWatch,
  live: LiveState,
  channels: ChannelPublisher,
  slotId: string,
): void {
  observeCoercion(
    'eccentricPercentTenths',
    dump.eccentricPercentTenths,
    watch,
    live,
    channels,
    slotId,
  );
  observeCoercion('assistMode', dump.assistMode, watch, live, channels, slotId);
}

/**
 * Single-field coercion observation step. Sweeps expired checks, asks the
 * watch whether `deviceValue` matches a pending setter at a coerced value,
 * and on a hit publishes the channel event with set/session context pulled
 * from the slot's LiveState.
 */
function observeCoercion(
  field: string,
  deviceValue: number,
  watch: CoercionWatch,
  live: LiveState,
  channels: ChannelPublisher,
  slotId: string,
): void {
  const now = Date.now();
  const hits = watch.observe(field, deviceValue, now);
  if (hits.length === 0) return;
  const set = live.snapshotSet();
  const session = live.snapshotSession();
  const context: CoercionSetContext = {
    slotId,
    setId: set?.setId ?? null,
    sessionId: session?.sessionId ?? null,
  };
  const device = live.snapshotDevice();
  for (const hit of hits) {
    channels.publish(buildSettingCoercedPayload(hit, deviceValue, now, device, context));
  }
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
  if (typeof s.chains === 'number') {
    out.chainSettingLbs = s.chains;
  }
  return out;
}
