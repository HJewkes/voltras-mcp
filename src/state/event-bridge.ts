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
//   onRepBoundary               → if active set: notify voltra://set/active.
//                                 If no set: log + drop (EC-11 stale rep).
//   onSetBoundary               → log + drop. The set lifecycle is owned by
//                                 the explicit `set.start`/`set.end` tools;
//                                 the autonomous device signal does not
//                                 mutate VMCP state. Subscribing keeps the
//                                 listener slot bound so the SDK does not
//                                 buffer events. (Critic gap Q6.)
//   onSettingsUpdate            → applySettings + notify voltra://device/current.
//   onConnectionStateChange     → applySettings({ connected }) + notify
//                                 voltra://device/current. On 'disconnected'
//                                 also markDisconnected and notify both
//                                 voltra://session/active and
//                                 voltra://set/active (R24).
//
// ── SDK signature divergence (briefing → reality) ─────────────────────────
//
// The Wave 2C briefing's pseudo-code subscribes `onRepBoundary(rep => ...)`
// — but the installed `@voltras/node-sdk` declares `onRepBoundary` as a
// `() => void` listener, so no `Rep` object is available at the boundary.
// Rep construction from the live frame stream is a Wave 3 concern (the
// frame listener will buffer samples into a `Rep` and call
// `live.appendRep` directly). The bridge's contract for the boundary signal
// is (1) drop when no active set (EC-11) and (2) emit the resource hint
// when one is active. `LiveState.appendRep` is intentionally NOT called
// here.
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
import { createRep, addSampleToRep } from '@voltras/workout-analytics';
import type { WorkoutSample } from '@voltras/workout-analytics';

import type { LiveState, DeviceSnapshot } from './live-state.js';
import { log } from '../logger.js';

// The SDK and analytics packages each declare a numeric `MovementPhase` enum
// with the same 0–3 values for IDLE/CONCENTRIC/HOLD/ECCENTRIC. The SDK adds
// UNKNOWN = -1; analytics doesn't. Frames carrying UNKNOWN are ignored at
// the buffer step. For the in-range values the runtime numbers are
// interchangeable; the cast is a structural-only no-op.
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
 */
export function wireEventBridge(client: VoltraClient, live: LiveState, server: McpServer): void {
  // Frame buffer for assembling a Rep on each onRepBoundary signal. The SDK's
  // RepBoundaryListener is `() => void` (no payload), so the bridge buffers
  // telemetry frames during an active set and slices them into a Rep at each
  // boundary using @voltras/workout-analytics's `createRep` + `addSampleToRep`
  // (those route samples to concentric/eccentric phases by `sample.phase`).
  let sampleBuffer: WorkoutSample[] = [];
  let nextRepNumber = 1;

  client.onFrame((frame: TelemetryFrame) => {
    if (live.snapshotSet() === undefined) return;
    if ((frame.phase as unknown as number) === SDK_PHASE_UNKNOWN) return;
    sampleBuffer.push({
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      phase: frame.phase as unknown as WorkoutSample['phase'],
      position: frame.position,
      velocity: Math.abs(frame.velocity),
      force: Math.abs(frame.force),
    });
  });

  client.onRepBoundary(() => {
    if (live.snapshotSet() === undefined) {
      log.debug('event-bridge: onRepBoundary with no active set — dropping (EC-11)');
      sampleBuffer = [];
      return;
    }
    if (sampleBuffer.length === 0) {
      log.debug('event-bridge: onRepBoundary with no buffered frames — dropping');
      return;
    }
    let rep = createRep(nextRepNumber);
    for (const sample of sampleBuffer) {
      rep = addSampleToRep(rep, sample);
    }
    live.appendRep(rep);
    nextRepNumber += 1;
    sampleBuffer = [];
    notify(server, SET_URI);
  });

  client.onSetBoundary(() => {
    // Reset the rep counter when the device signals a new set; mainly defensive
    // — the explicit set.start tool also bumps state, but if the device-side
    // set fires first the buffered frames belong to the old set.
    nextRepNumber = 1;
    sampleBuffer = [];
    log.debug(
      'event-bridge: onSetBoundary received — set lifecycle is owned by explicit tools, no action',
    );
  });

  client.onSettingsUpdate((settings: SdkSettingsUpdate) => {
    live.applySettings(settingsToSnapshot(settings));
    notify(server, DEVICE_URI);
  });

  client.onConnectionStateChange((state) => {
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
