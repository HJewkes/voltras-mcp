// SDK event-bridge — funnels VoltraClient events into LiveState mutations
// and emits MCP `sendResourceUpdated` hints for the affected resource URIs.
//
// Wave 2C wiring (Task 09). Subscribes once per connect; the returned
// unsubscribe handles are intentionally discarded — the client is owned by
// `bootstrapState` for the lifetime of the process and is disposed via
// `manager.dispose()` at shutdown, which clears every listener.
//
// ── Event mapping ─────────────────────────────────────────────────────────
//
//   onFrame                     → buffer telemetry samples; detect rep cycle
//                                 completion via phase transitions; emit one
//                                 Rep at the *end* of each cycle.
//   onRepBoundary               → debug-only — the device fires this at every
//                                 phase transition (concentric→eccentric,
//                                 eccentric→idle), so it produces ~2 splits
//                                 per real rep. We log it to the debug event
//                                 buffer and otherwise ignore it. Subscribing
//                                 keeps the listener slot bound so the SDK
//                                 does not buffer events.
//   onSetBoundary               → suppressed within a SET_START_GRACE_MS
//                                 window of `set.start` (the device fires a
//                                 set_boundary in response to our Workout.GO
//                                 engage command, which would otherwise reset
//                                 the rep counter mid-set). Outside the grace
//                                 window the set lifecycle is owned by the
//                                 explicit `set.start`/`set.end` tools; the
//                                 autonomous device signal does not mutate
//                                 VMCP state. (Critic gap Q6.)
//   onSettingsUpdate            → applySettings + notify voltra://device/current.
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
import type { VoltraClient, TelemetryFrame } from '@voltras/node-sdk';
import { TrainingModeNames } from '@voltras/node-sdk';
import type { TrainingMode } from '@voltras/node-sdk';
import type { WorkoutSample } from '@voltras/workout-analytics';
import { getRepPeakVelocity } from '@voltras/workout-analytics';

import type { LiveState, DeviceSnapshot } from './live-state.js';
import { getDebugBuffers } from './debug-buffer.js';
import type { ChannelPublisher } from './channel-publisher.js';

// The SDK declares a numeric `MovementPhase` enum with UNKNOWN = -1; the
// analytics-set state machine doesn't model UNKNOWN. Frames carrying it are
// dropped before reaching `live.processSample`.
const SDK_PHASE_UNKNOWN = -1;

// The settings-update payload is the SDK's protocol-layer `DeviceSettings`.
// Re-declared structurally here to avoid pulling in the protocol module's
// type path (which is not exported from the package's public entry).
interface SdkSettingsUpdate {
  baseWeight?: number;
  weight?: number;
  chains?: number;
  inverseChains?: number;
  eccentric?: number;
  mode?: TrainingMode;
  trainingMode?: TrainingMode;
  battery?: number | null;
}

const DEVICE_URI = 'voltra://device/current';
const SESSION_URI = 'voltra://session/active';
const SET_URI = 'voltra://set/active';

/**
 * Subscribe `live` to the SDK events on `client` and emit the matching
 * resource-updated notifications via `server`. Idempotent at the type
 * level — caller is expected to invoke once per server lifetime.
 *
 * `channels` is invoked on rep finalization so the model wakes inline (via
 * `<channel>` tag delivery in Claude Code) rather than having to poll
 * `set.live_metrics`. Fire-and-forget: when the host wasn't launched with
 * `--channels`, publish is a no-op.
 */
export function wireEventBridge(
  client: VoltraClient,
  live: LiveState,
  server: McpServer,
  channels: ChannelPublisher,
): void {
  const debug = getDebugBuffers();

  // ── Sample-driven rep detection (canonical workout-analytics pipeline) ─
  //
  // Workout-analytics's `addSampleToSet` is the source of truth for
  // rep-boundary detection — it's what the mobile app uses, and it lives
  // inside `LiveState.processSample`. The bridge's only job here is to
  // convert each `TelemetryFrame` into a `WorkoutSample` and forward it.
  // The state machine (eccentric→concentric starts a new rep, IDLE folds
  // into hold time) is owned by the model. We do NOT subscribe to
  // `onRepBoundary` for state mutation — the device fires it at every
  // phase transition, which produces split reps. We do NOT subscribe to
  // `onSetBoundary` for state mutation either — the device emits it
  // continuously during workout mode, not just at end-of-set, and the set
  // lifecycle is owned by the explicit `set.start`/`set.end` tools.
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
      // Push a rep_finalized channel event so the model wakes on every
      // completed rep without polling. The most recently finalized rep is
      // the previously-final one (a new rep starts on each ECCENTRIC ->
      // CONCENTRIC transition, closing the prior rep), so the just-closed
      // rep sits at index `nextRepCount - 2` while a new in-progress rep
      // is at index `nextRepCount - 1`. When this is the very first rep
      // emission we fall back to the only rep present.
      const set = live.snapshotSet();
      if (set !== undefined && set.reps.length > 0) {
        const finalizedIndex = set.reps.length >= 2 ? set.reps.length - 2 : 0;
        const finalizedRep = set.reps[finalizedIndex];
        const peakVelocity = getRepPeakVelocity(finalizedRep);
        const meta: Record<string, string> = {
          source: 'voltras',
          event_type: 'rep_finalized',
          set_id: set.setId,
          rep_count: String(finalizedIndex + 1),
        };
        if (peakVelocity > 0) {
          meta.peak_velocity = peakVelocity.toFixed(3);
        }
        channels.publish({
          content: `Rep ${finalizedIndex + 1} complete on set ${set.setId.slice(0, 8)}.`,
          meta,
        });
      }
    }
  });

  client.onRepBoundary(() => {
    // Device fires this at every phase transition (concentric→eccentric,
    // eccentric→idle), so it is unreliable as a "rep complete" signal.
    // Logged for diagnostic visibility only — rep boundaries are detected
    // from frames in `LiveState.processSample`.
    debug.events.push({
      capturedAt: Date.now(),
      type: 'rep_boundary',
      payload: { repsSoFar: live.snapshotSet()?.reps.length ?? 0 },
    });
  });

  client.onSetBoundary(() => {
    // Device emits this continuously during workout mode — NOT just at
    // end-of-set. Logged for diagnostic visibility only; the set lifecycle
    // is owned by the explicit `set.start`/`set.end` tools.
    debug.events.push({
      capturedAt: Date.now(),
      type: 'set_boundary',
      payload: { hadActiveSet: live.snapshotSet() !== undefined },
    });
  });

  client.onSettingsUpdate((settings: SdkSettingsUpdate) => {
    debug.events.push({
      capturedAt: Date.now(),
      type: 'settings_update',
      payload: {
        weight: settings.weight ?? settings.baseWeight ?? null,
        mode: settings.mode ?? settings.trainingMode ?? null,
        battery: settings.battery ?? null,
      },
    });
    live.applySettings(settingsToSnapshot(settings));
    notify(server, DEVICE_URI);
  });

  client.onConnectionStateChange((state) => {
    debug.events.push({
      capturedAt: Date.now(),
      type: 'connection_state_change',
      payload: { state },
    });
    live.applySettings({ connected: state === 'connected' });
    notify(server, DEVICE_URI);
    if (state === 'disconnected') {
      live.markDisconnected(new Date().toISOString());
      notify(server, SESSION_URI);
      notify(server, SET_URI);
    }
  });
}

function notify(server: McpServer, uri: string): void {
  // Fire-and-forget: the notification is a best-effort poll hint per R14.
  void server.server.sendResourceUpdated({ uri });
}

/**
 * Map an SDK settings-update payload onto the `DeviceSnapshot` shape used by
 * `LiveState`. Coerces `battery: null → undefined` per critic FIX #6 (the
 * JSON output schema for `DeviceSnapshot` forbids null). The `weight` /
 * `baseWeight` and `mode` / `trainingMode` aliases reflect the dual naming
 * across `VoltraDeviceSettings` (high-level) and the protocol-layer
 * `DeviceSettings` notification payload.
 */
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
  return out;
}
