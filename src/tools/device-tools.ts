// `device.*` tool registry — Wave 3A.
//
// Wires the eight tools enumerated in spec R11 onto the running `McpServer`
// by hot-swapping the `STARTING` placeholder callbacks created during
// `runServer` (see `src/server.ts`). The placeholder map is threaded in so
// each tool keeps its existing `RegisteredTool` reference; we only update
// the `callback` field via `RegisteredTool.update({ callback })`. This keeps
// the registration list stable across the bootstrap → live transition and
// avoids the `tools/list_changed` notification that fresh `server.tool()`
// calls would emit.
//
// All BLE interaction flows through `state.manager` and the slot's `client`
// — AC-14 forbids any direct BLE-adapter library references from this file.
//
// ── Connection model ──────────────────────────────────────────────────────
//
// `device.connect` uses `state.manager.connect(device)` (the SDK's idiomatic
// connection entry point). The manager creates an internal `VoltraClient`
// for each connected device — distinct from the parameter-less client
// allocated for the slot in `bootstrapState`. AC-26 specifies that
// `device.get_state` reads from the slot's `client.*` getters, and Wave 2's
// event-bridge subscribes to that same client. Reconciling the two clients
// (e.g., proxying manager events through the slot's client, or replacing
// the slot's client after connect with bridge re-wiring) is a Wave 4
// concern; this module satisfies the AC-26 contract by reading exactly the
// documented getters and lets Wave 4 decide how the slot's client becomes
// connected.
//
// ── `device.scan` options shape ───────────────────────────────────────────
//
// `manager.scan` accepts `ScanOptions` (`{ timeout?: number; ... }`). We
// accept `timeoutMs` on the input schema (per spec R11) and forward it as
// the SDK's `timeout` field.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TrainingMode, TrainingModeNames } from '@voltras/node-sdk';
import type { GuidedLoadState } from '@voltras/node-sdk';
import { activeModeName } from '../state/active-mode.js';
import { z } from 'zod';

import {
  DeviceScanInput,
  DeviceSendRawInput,
  DeviceSetPassiveScanInput,
  DeviceSetWeightInput,
  DeviceSetModeInput,
  DeviceSetDamperLevelInput,
  DeviceSetAssistModeInput,
  DeviceSetBandMaxForceInput,
  DeviceSetIsokineticTargetSpeedInput,
  DeviceSetIsokineticEccModeInput,
  DeviceSetIsokineticEccSpeedLimitInput,
  DeviceSetIsokineticEccConstWeightInput,
  DeviceSetIsokineticEccOverloadWeightInput,
  DeviceConfigureIsokineticInput,
  DeviceStartGuidedLoadInput,
  // <Bug-22>
  DeviceEnterRowModeInput,
  DeviceStartRowInput,
  // </Bug-22>
  SELECTABLE_MODE_NAMES,
} from '../schemas/device.js';
import { SlotIdSchema } from '../schemas/common.js';
import { type ServerState, PRIMARY_SLOT, MAX_SLOTS, getSlot } from '../state/server-state.js';
import type { ActiveSet, DeviceSnapshot, PendingDisconnectNotice } from '../state/live-state.js';
import type { ModeRevertAbort } from '../state/mode-revert-guard.js';
import type { SlotBinding } from '../state/slot-bindings.js';
import { createSlot, removeSlot, resetPrimarySlot, swapSlots } from '../state/slot-manager.js';
import { wireBridgeForSlot } from '../state/event-bridge.js';
import { getDebugBuffers } from '../state/debug-buffer.js';
import {
  cascadeAcrossSlots,
  type CascadePlan,
  type SlotResult,
} from '../state/bilateral-cascade.js';
import {
  trackedSetterCall,
  COERCION_WINDOW_MS_GUIDED_LOAD,
  type TrackedFieldSpec,
} from '../state/coercion-watch.js';
import {
  makeManagerScan,
  startPassiveScan,
  stopPassiveScan,
  type PassiveScanContext,
} from '../state/passive-scanner.js';
import { buildVoltrasAvailablePayload } from '../state/channel-payloads.js';
import { wrapHandler, type ToolResult } from './helpers.js';
import {
  shouldPreflightWeightTraining,
  buildGuidedLoadTrackedFields,
  teardownBleResources,
} from './device-handler-helpers.js';
import { finalizeSet } from './set-tools.js';
import type { StoredSession } from '../store/types.js';
import { log } from '../logger.js';

// Locally-scoped extra schemas — kept here rather than in `src/schemas/device.ts`
// to honor Task 10's file-ownership boundary (we may not modify Wave 1
// schemas). Each shape is small and tool-local; once Task 03 picks them up
// they can be moved.
//
// `slot` is dual-Voltras Step 2 plumbing — every tool whose handler resolves
// the slot accepts an optional slot id and falls back to PRIMARY_SLOT.
// `device.disconnect` and `device.get_state` were `.strict()` before Step 2;
// they remain strict so unknown fields still fail INVALID_INPUT, and `slot`
// is the only non-error addition.
// `slot: 'auto'` (VMCP-02.05) — resolve the target slot id from the persisted
// deviceId ↔ physical-side bindings. The handler maps `physicalSide: 'left'`
// → slot id `'left'` and `'right'` → `'right'`. When no binding exists for
// the deviceId, the handler surfaces NO_PERSISTED_BINDING so the caller can
// fall back to the explicit slot-id flow (and the side-ID ritual).
const DeviceConnectInput = z.object({
  deviceId: z.string().min(1),
  slot: SlotIdSchema,
});

const DEVICE_CONNECT_DESCRIPTION =
  'Connect to a device discovered by a prior device.scan. `slot` identifies ' +
  "which slot the device binds to (default: 'primary'). Pass slot: 'auto' to " +
  'resolve the slot from the persisted deviceId ↔ physical-side binding ' +
  '(written by slot.bind) — the device routes to slot `left` or `right` ' +
  'based on the saved side. Returns NO_PERSISTED_BINDING when the deviceId ' +
  "has no saved binding and slot is 'auto'; fall back to an explicit slot id " +
  'plus the side-ID ritual in that case.';

const DeviceDisconnectInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

const DeviceSetChainsInput = z.object({
  lbs: z.number().int().min(0).max(100),
  slot: SlotIdSchema,
});

// `device.set_eccentric` — the underlying SDK call (`client.setEccentric`) takes
// a value in POUNDS, not percent. The historic param name `percent` was a
// misnomer carried over from the firmware doc; VMCP-02.04 renames to
// `overloadLbs` and keeps `percent` as a deprecated alias for one release so
// pre-rename callers continue to work with a logged warning.
const DeviceSetEccentricInput = z
  .object({
    overloadLbs: z.number().int().min(-195).max(195).optional(),
    percent: z.number().int().min(-195).max(195).optional(),
    slot: SlotIdSchema,
  })
  .refine((v) => v.overloadLbs !== undefined || v.percent !== undefined, {
    message: 'device.set_eccentric requires `overloadLbs` (preferred) or `percent` (deprecated).',
  });

const DeviceGetStateInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

/**
 * Default inactivity-watchdog threshold for guided-load AUTO-created sets
 * (VMCP-02.15). 30s is short enough to reap a failed engagement quickly
 * but accommodates the firmware's ~10-18s armed → active ceremony plus a
 * brief settle. Manual `set.start` callers control their own inactivity
 * via `watch.inactivityTimeoutMs` and remain unaffected.
 */
const GUIDED_LOAD_DEFAULT_INACTIVITY_MS = 30_000;

const DeviceUnloadInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

// ── bilateral.cascade input ───────────────────────────────────────────────
//
// Bundles all four device setters across one-or-more slots. VMCP-02.27:
// the cascade enforces a FULL-SETTINGS contract — every call MUST supply
// `mode`, `weightLbs`, `eccentricOverloadLbs` (or the deprecated
// `eccentricPercent` alias), AND `chainsLbs`. Omitting a setter used to
// leave that setting at its prior firmware value, which silently carried
// stale state across cascades (e.g. chains lingering after a weight-only
// call). Requiring the complete set makes the cascade idempotent and its
// applied state fully specified. The handler enforces this at runtime
// (see `buildCascadePlan`) so the INVALID_INPUT message can name exactly
// which setters are missing rather than emitting a generic zod error.
//
// Field unit notes:
//   * `eccentricPercent` mirrors the underlying `client.setEccentric(percent)`
//     SDK shape (-195..+195, integer). The briefing called this `eccentricLbs`
//     but the SDK setter is a percent — renaming aligns the MCP surface
//     with the device's actual eccentric-overload control.
//   * `chainsLbs` is pounds (0..100), same range as `device.set_chains`.
//   * `weightLbs` is pounds (5..200), same range as `device.set_weight`.
//
// `slots` lacks the per-element `SlotIdSchema` regex (we use a permissive
// `z.string()`) so an unknown-but-syntactically-valid slot id surfaces from
// the handler as an INVALID_INPUT with the unbound slot listed by name —
// more diagnostic than zod's per-element regex error.
//
// `eccentricOverloadLbs` (preferred) and `eccentricPercent` (deprecated alias
// kept for one release per VMCP-02.04) both forward to the same SDK call;
// both cannot be present simultaneously.
const BilateralCascadeInput = z
  .object({
    slots: z.array(z.string().min(1)).optional(),
    mode: z.enum(SELECTABLE_MODE_NAMES).optional(),
    weightLbs: z.number().int().min(5).max(200).optional(),
    eccentricOverloadLbs: z.number().int().min(-195).max(195).optional(),
    eccentricPercent: z.number().int().min(-195).max(195).optional(),
    chainsLbs: z.number().int().min(0).max(100).optional(),
    abortOnFirstFailure: z.boolean().optional().default(false),
  })
  .strict()
  .refine((v) => !(v.eccentricOverloadLbs !== undefined && v.eccentricPercent !== undefined), {
    message:
      'bilateral.cascade accepts `eccentricOverloadLbs` (preferred) OR `eccentricPercent` (deprecated), not both.',
  });

const BILATERAL_CASCADE_DESCRIPTION =
  'Apply all four device setters (mode, weight, eccentric, chains) across one or more bound slots in a single call. ' +
  'Full-settings contract: every call MUST supply `mode`, `weightLbs`, `eccentricOverloadLbs`, and `chainsLbs` — omitting any is rejected with INVALID_INPUT naming the missing setters. This is deliberate: a partial cascade would leave the unset settings at their prior firmware value, silently carrying stale state (e.g. chains lingering after a weight-only call). Requiring the complete set makes each cascade idempotent and its applied state fully specified. ' +
  'Within each slot the setters fire concurrently (no documented ordering dependency between them); slots also run concurrently with each other so a failure on slot A does not block slot B. ' +
  'When `abortOnFirstFailure: true`, setters within each slot run sequentially and the first rejection on any slot prevents subsequent setters from firing. ' +
  'Defaults `slots` to every currently-connected slot. Returns one `results[i]` entry per requested slot, with an `applied.<setter>` outcome for each of the four setters. ' +
  'Eccentric param: `eccentricOverloadLbs` is the preferred name (pounds added on the eccentric phase, -195..+195). The legacy alias `eccentricPercent` is accepted with a deprecation warning logged on use and will be removed in the next release.';

// `slot.swap` accepts no arguments — there are exactly two slot positions
// in the workspace today (PRIMARY_SLOT plus one user-allocated id), so the
// swap is unambiguous. `.strict()` rejects unknown fields so a typo like
// `{ slt: 'left' }` surfaces as INVALID_INPUT instead of being silently
// dropped.
const SlotSwapInput = z.object({}).strict();

/**
 * Default scan timeout when the input omits `timeoutMs`. Mirrors the schema
 * default (`DeviceScanInput.timeoutMs` defaults to 10000) but lives here as
 * a literal because zod's `.default()` only fires when the field is
 * omitted — `wrapHandler` calls `safeParse` which preserves explicit
 * `undefined` without coercion in some shapes. Centralising the constant
 * keeps the manager call site single-sourced.
 */
const DEFAULT_SCAN_TIMEOUT_MS = 10_000;

// ── Tool descriptions (SDK 0.6.0 mode-config setters) ────────────────────
//
// All 8 setters share two cross-cutting caveats from the on-device validation
// pass: (1) settings persist GLOBALLY across mode switches — flipping the
// device into a different training mode does not clear them — and (2) the
// underlying opcodes (0xa9/0xc7) do NOT trigger a `modeConfirmation`, so the
// `await client.setX(...)` resolves on adapter.write completion, not on a
// device acknowledgement. The const-weight and overload-weight setters cause
// an audible device beep — possibly a firmware safety/range cue.

const DAMPER_LEVEL_DESCRIPTION =
  'Set the damper-mode resistance level (0-9). UI displays the value as N+1 (1-10). Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ASSIST_MODE_DESCRIPTION =
  'Toggle assist mode on/off. UI affordance lives in the Settings menu, not the idle screen. Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const BAND_MAX_FORCE_DESCRIPTION =
  'Set the band-mode maximum-force ceiling (15-70 lbs). Pounds. Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

// VMCP-02.16: the five per-field isokinetic setters are @deprecated in favor
// of the single `device.configure_isokinetic` tool. They stay registered for
// one release so existing callers keep working; the deprecation prefix steers
// the model toward the combined tool (one description, one call per slot).
const ISOKINETIC_DEPRECATION = '@deprecated — prefer device.configure_isokinetic. ';

const ISOKINETIC_TARGET_SPEED_DESCRIPTION =
  ISOKINETIC_DEPRECATION +
  'Set the isokinetic target speed (0-2000 mm/s, step 10). Input is millimeters/second; the device UI displays the value in meters/second (input ÷ 1000). Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_MODE_DESCRIPTION =
  ISOKINETIC_DEPRECATION +
  'Set the isokinetic eccentric mode ("isokinetic" or "constant"). Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_SPEED_LIMIT_DESCRIPTION =
  ISOKINETIC_DEPRECATION +
  'Set the isokinetic eccentric speed limit (0-2000 mm/s, step 10). 0 = auto. Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_CONST_WEIGHT_DESCRIPTION =
  ISOKINETIC_DEPRECATION +
  'Set the isokinetic eccentric constant weight (0-200 lbs). Pounds. Note: the device emits an audible beep when this is set on a connected device — possibly a safety/range cue from the firmware; the command itself succeeds. Settings persist globally across mode switches. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_OVERLOAD_WEIGHT_DESCRIPTION =
  ISOKINETIC_DEPRECATION +
  'Set the isokinetic eccentric overload weight (0-200 lbs). Pounds. Note: the device emits an audible beep when this is set on a connected device — possibly a safety/range cue from the firmware; the command itself succeeds. Settings persist globally across mode switches. Validated on-device 2026-05-06.';

const CONFIGURE_ISOKINETIC_DESCRIPTION =
  'Configure isokinetic mode in one call (VMCP-02.16) — replaces the five per-field device.set_isokinetic_* setters. ' +
  '`targetSpeedMmPerSec` (0-2000, step 10) and `eccMode` ("isokinetic" | "constant") are required; ' +
  '`eccSpeedLimitMmPerSec` (0-2000, 0 = auto), `eccConstWeightLbs` (0-200), and `eccOverloadWeightLbs` (0-200) are optional and only written when supplied. ' +
  'Use `eccConstWeightLbs` with `eccMode: "constant"` and `eccOverloadWeightLbs` with the overload variant. Speeds are mm/s (UI shows m/s = input ÷ 1000); weights are pounds. ' +
  'Caveats (apply to every field): settings persist globally across mode switches and the firmware emits no modeConfirmation echo, so coercion checks expire silently. ' +
  'Setting either eccentric weight makes the device emit an audible beep — a firmware safety/range cue; the command still succeeds. Validated on-device 2026-05-06.';

const START_GUIDED_LOAD_DESCRIPTION =
  '@experimental — Trigger the firmware "direct-load" flow at the supplied target weight (5-200 lbs). The SDK writes BP_BASE_WEIGHT, sends the AA12 trigger, and polls the 4 status registers every 500ms for 18s post-trigger; transitions (armed → countdown → engaging → active) are surfaced via the bridge. The bridge also auto-creates a session+set on entry so subsequent rep_boundary / set_boundary frames are properly attributed (closes Bugs 28/29). Polling intervals can be overridden for diagnostics but rarely need adjustment.\n\n**Auto-unload (VMCP-02.06):** Before the direct-load trigger fires, this tool invokes the unload primitive (mode-bounce: Damper → WeightTraining) on the target slot. The firmware\'s direct-load flow only emits the visible countdown ceremony when the cable is fully unloaded at trigger time; pre-unloading is idempotent and ensures the ceremony fires regardless of the slot\'s prior state. To skip auto-unload (e.g., for diagnostics), pass `skipUnload: true`.\n\n**Idle preflight (VMCP-02.45):** if the device is in `Idle` (e.g. fresh boot/wake), this tool first issues `set_mode(WeightTraining)` and skips the unload — the firmware suppresses telemetry in Idle and the Workout.STOP unload does not establish a mode, so without this the trigger lands on a device that falls back to Idle and never engages (silent inactivity_timeout). A failed mode-set surfaces as a structured error instead.\n\nFailure detection: if `guided_load_state` emits `phase: active` immediately (no prior `countdown` or `engaging` event), the device skipped the ceremony despite the unload — call `device.unload` explicitly and re-trigger.\n\n**Exercise attribution (VMCP-02.13):** pass `exerciseName` (and optionally `exerciseId`) so the auto-created session is filterable by exercise post-hoc instead of the generic "Guided Load (auto)". Ignored when an explicit `session.start` is already active on the slot — that session is reused as-is.';

const EXIT_GUIDED_LOAD_DESCRIPTION =
  '@experimental — Exit the firmware "direct-load" flow. Writes the exit frame (0x0004 to the fitness-mode register) and stops the SDK polling loop. The bridge will emit a `guided_load_state` event with `phase: "exited"`. Returns NOT_IN_GUIDED_LOAD if the slot is not currently in an active guided-load phase (armed/countdown/engaging/active). Safe to call after a timeout — the SDK stops polling on its own but the exit frame cleans up the firmware state.';

const SET_ECCENTRIC_DESCRIPTION =
  'Set the eccentric overload weight on the device. `overloadLbs` is the additional pounds applied during the eccentric (return) phase of each rep, on top of the base `setWeight` value. Range -195..+195 in pound steps; positive values add load on the eccentric, negative values reduce it (assisted eccentric). ' +
  'The legacy `percent` param is accepted as a deprecated alias for one release and will be removed in the next major; the value semantics are identical (it was mis-named — the underlying SDK call has always taken pounds, not a percent of base weight). ' +
  "No `modeConfirmation` is emitted by the firmware; the call resolves on BLE-write completion. Field-level coercion is correlated against the device's `eccentricPercentTenths` echo within COERCION_WINDOW_MS.";

const UNLOAD_DESCRIPTION =
  'Drive the device into a fully-unloaded mechanical state by issuing a mode-bounce (Damper → WeightTraining). ' +
  "This is the prerequisite for `device.start_guided_load`'s visible countdown ceremony — `device.exit_guided_load` clears software-side guided-load state but does NOT physically release residual cable tension, so a subsequent `start_guided_load` short-circuits to `phase: active` with no countdown and no assisted-eccentric ramp. " +
  'Mechanism: writes two `BP_SET_FITNESS_MODE` frames back-to-back (Damper, then WeightTraining). The Damper write drives the firmware through its internal idle/unload transition and physically slackens the cable; the WeightTraining write returns the device to the normal strength-training screen. Validated on hardware 2026-05-12. ' +
  "A single `FITNESS_WORKOUT_STATE=0` write (used by rowing's `exitWorkout()` 5-write sequence) was considered but not chosen — the workout-state-zero shape has not been verified to physically unload the cable for non-rowing modes. " +
  'Idempotent — safe to call on an already-unloaded device. Note: `device.start_guided_load` auto-invokes unload before triggering the direct-load flow, so explicit `device.unload` is only needed for callers driving custom flows that bypass `start_guided_load`. ' +
  'When called while a guided-load flow is active (phase armed/countdown/engaging/active), this also drives `exitGuidedLoad` and reaps the auto-created session/set, so `device.get_state` reports `load_state: unloaded` / `guided_load.phase: exited` and a terminal `guided_load_state` channel event (outcome: ended) is published — no separate `device.exit_guided_load` call is needed (VMCP-02.41).';

const DeviceExitGuidedLoadInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

const GUIDED_LOAD_ACTIVE_PHASES = new Set(['armed', 'countdown', 'engaging', 'active']);

const SEND_RAW_DESCRIPTION =
  'DIAGNOSTIC ONLY. Writes arbitrary bytes to the connected device via the lowest-level BLE write. No opcode validation, no semantic checks — the caller owns byte semantics. Can put the device in unexpected state, drain battery, or cause unintended motor movement. Use ONLY with explicit user request, typically to drive an on-device validation campaign that needs bytes the high-level SDK does not expose. Requires `confirm: true`. Disabled in mock-adapter mode (returns MOCK_NOT_SUPPORTED). Each invocation is logged to the debug ring buffer (visible via debug.recent_events) with the hex echo for audit.';

type Placeholders = Map<string, RegisteredTool>;

/**
 * Swap the `STARTING` placeholder callback for `name` with `handler`. No-op
 * (with a warning that surfaces in tests) when the placeholder is absent —
 * Wave 4 may rearrange the bootstrap order, but the contract here is that a
 * missing placeholder is a bug, not a runtime crash.
 */
function install<S extends z.ZodObject>(
  placeholders: Placeholders,
  name: string,
  schema: S,
  handler: (args: unknown, extra?: unknown) => Promise<ToolResult>,
  description?: string,
): void {
  const reg = placeholders.get(name);
  if (reg === undefined) {
    // Logged at warn so the regression is surfaced in tests + production.
    // We intentionally do not throw — a missing placeholder for one tool
    // should not block registration of the rest. `no-console` permits
    // `console.warn` per `eslint.config.mjs`, so this is allowed.
    console.warn(`registerDeviceTools: no placeholder found for ${name}`);
    return;
  }
  // Pass the real `paramsSchema` alongside the callback. The bootstrap
  // placeholder schema (`z.object({}).passthrough().shape`) loses passthrough
  // semantics through `.shape`, so the SDK silently strips ANY input field
  // when the schema is left unchanged — every tool with a required arg
  // would fail with INVALID_INPUT until this swap runs.
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: handler as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  reg.update(updates as never);
}

/**
 * Register the eight `device.*` tools by hot-swapping their startup
 * placeholders. Pass-through type erasure on `update`'s callback parameter is
 * intentional: `wrapHandler` guarantees a `ToolResult`-shaped return, but
 * the SDK's `update<InputArgs>` is generic over a `ZodRawShape` we don't
 * thread through. Casting the handler at the install seam keeps the
 * tool-side code typed without bleeding SDK internals into every callsite.
 */
export function registerDeviceTools(
  _server: McpServer,
  state: ServerState,
  placeholders: Placeholders,
): void {
  // device.scan — manager-level discovery. Wraps the user's `timeoutMs` in
  // a `ScanOptions` object so the SDK is never called with a bare number.
  // Returns the discovered devices straight through.
  install(
    placeholders,
    'device.scan',
    DeviceScanInput,
    wrapHandler(DeviceScanInput, async (input) => {
      const timeout = input.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
      const devices = await state.manager.scan({ timeout });
      return { devices };
    }),
  );

  // device.set_passive_scan — toggle the background BLE scanner that
  // emits `voltras_available` channel events when newly-seen Voltras
  // appear (VMCP-02.19). Off-by-default at server start. Coexists with
  // the manual `device.scan` tool; the passive scanner skips its window
  // when any slot is currently connected (BLE-adapter conflict
  // avoidance — see passive-scanner.ts for rationale).
  install(
    placeholders,
    'device.set_passive_scan',
    DeviceSetPassiveScanInput,
    wrapHandler(DeviceSetPassiveScanInput, async (input) => {
      if (input.enabled) {
        const ctx: PassiveScanContext = {
          isAnyDeviceConnected: () => countConnectedSlots(state) > 0,
          scan: makeManagerScan(state.manager),
          onNewlySeen: (devices) => {
            state.channels.publish(buildVoltrasAvailablePayload(devices));
          },
        };
        const intervalMs =
          input.intervalSeconds !== undefined ? input.intervalSeconds * 1000 : undefined;
        startPassiveScan(state.passiveScan, ctx, intervalMs);
        return {
          ok: true,
          enabled: true,
          intervalSeconds: Math.round(state.passiveScan.intervalMs / 1000),
        };
      }
      stopPassiveScan(state.passiveScan);
      return { ok: true, enabled: false };
    }),
  );

  // device.connect — looks up the previously-discovered device by id and
  // hands it to `manager.connect`. Slot lifecycle (Step 3 of P0
  // dual-Voltras):
  //   * No `slot` arg: bind to PRIMARY_SLOT. ALREADY_CONNECTED if primary
  //     is live — the user must pass an explicit `slot` to bring up a
  //     second device.
  //   * Explicit `slot: 'primary'`: same rules as above.
  //   * Explicit `slot: <new-id>`: allocate the slot via `createSlot` so
  //     the new client gets its own LiveState (independent session/set/rep
  //     pipeline). Capped at MAX_SLOTS.
  //   * Explicit `slot: <existing-id>`: error — disconnect first or pick
  //     another slot.
  //
  // Known intermediate limitation: the event bridge is only re-wired for
  // PRIMARY_SLOT. Frames, rep boundaries, and connection events from
  // non-primary slots are NOT yet bridged. Step 4 fans the bridge out per
  // slot with channel-meta tagging.
  install(
    placeholders,
    'device.connect',
    DeviceConnectInput,
    wrapHandler(DeviceConnectInput, async (input) => {
      const slotId = resolveConnectSlotId(state, input.slot, input.deviceId);
      const isNewSlot = !state.slots.has(slotId);
      if (!isNewSlot) {
        const existing = getSlot(state, slotId);
        if (existing.client.isConnected) {
          if (slotId === PRIMARY_SLOT) {
            throwSdkLike(
              'ALREADY_CONNECTED',
              "Primary slot is already connected. Pass an explicit `slot` (e.g. 'left' or 'right') to connect a second device.",
            );
          }
          throwSdkLike(
            'ALREADY_CONNECTED',
            `Slot \`${slotId}\` is already connected. Use device.disconnect first or pick another slot.`,
          );
        }
      } else if (countConnectedSlots(state) >= MAX_SLOTS) {
        throwSdkLike(
          'SLOT_LIMIT_EXCEEDED',
          `Maximum of ${MAX_SLOTS} slots supported in this release.`,
        );
      }
      const device = state.manager.devices.find((d) => d.id === input.deviceId);
      if (device === undefined) {
        throwSdkLike(
          'DEVICE_NOT_FOUND',
          `No device with id ${JSON.stringify(input.deviceId)} in the last scan.`,
        );
      }
      // `manager.connect` returns the SDK's connected `VoltraClient`, which
      // is distinct from the parameter-less stub in the slot set at
      // bootstrap. For the primary slot we reassign and re-wire the event
      // bridge so onPerRep / onSettingsUpdate / onConnectionStateChange
      // land on the right object. For new slots we allocate via
      // `createSlot`, which self-wires the bridge against the new client
      // (see slot-manager.ts).
      const client = await state.manager.connect(device);
      if (isNewSlot) {
        createSlot(state, slotId, client);
      } else {
        const slot = getSlot(state, slotId);
        // Unwire the existing bridge before swapping clients so listeners
        // on the stale handle can't fire mid-rebind, then re-wire against
        // the freshly-connected client.
        slot.unwireBridge?.();
        slot.client = client;
        slot.unwireBridge = wireBridgeForSlot(state, slot);
      }
      // Refresh lastSeen on the persisted binding (if any) so a stale entry
      // surfaces in slot.bindings_list — VMCP-02.05.
      state.slotBindings.touch(input.deviceId);
      // For backwards compatibility we omit `slot` from the response when
      // the caller didn't pass `slot: 'auto'` — the existing single-device
      // contract was `{ ok: true, deviceId }`. The `auto` path surfaces the
      // resolved slot so the model can see which side the device routed to.
      if (input.slot === AUTO_SLOT) {
        return {
          ok: true,
          deviceId: input.deviceId,
          slot: slotId,
          resolvedFrom: 'persisted_binding',
        };
      }
      return { ok: true, deviceId: input.deviceId };
    }),
    DEVICE_CONNECT_DESCRIPTION,
  );

  // device.disconnect — graceful no-op when nothing is connected, otherwise
  // routes through `manager.disconnect(deviceId)` (the SDK manages adapter
  // teardown). Does not call `manager.dispose()` — that would tear down the
  // shared adapter for every connection (and for future scans).
  //
  // Slot lifecycle (Step 3 of P0 dual-Voltras):
  //   * No `slot` arg or `slot: 'primary'`: BLE-disconnect, then
  //     `resetPrimarySlot` so the slot persists with a fresh client + fresh
  //     LiveState (so the next single-device `device.connect` works).
  //   * `slot: <other>`: BLE-disconnect, then `removeSlot` — the slot
  //     ceases to exist, freeing the soft cap for a future allocation.
  install(
    placeholders,
    'device.disconnect',
    DeviceDisconnectInput,
    wrapHandler(DeviceDisconnectInput, async (input) => {
      const slotId = input.slot ?? PRIMARY_SLOT;
      const slot = getSlot(state, slotId);
      const id = slot.client.connectedDeviceId;
      const wasConnected = slot.client.isConnected && id !== null;
      // Capture the adapter reference BEFORE manager.disconnect runs.
      // `manager.disconnect(id)` calls `client.dispose()` internally, which
      // clears the adapter reference; capturing here lets us still force-close
      // the adapter even if the manager path errors mid-teardown. Slot-routing
      // bug fix — see
      // `coordination/bug-investigations/ble-slot-routing-2026-05-08.md` and
      // `sdk-slot-routing-code-trace-2026-05-08.md` "Fix A".
      const adapterRef = slot.client.getAdapter();
      // Best-effort: return the device to Idle before tearing down the BLE
      // link so the device exits any active workout and shows its home screen.
      // If the write fails (link already dead, device rejected it, etc.) we
      // log at info level and proceed — this must never block teardown.
      if (wasConnected) {
        try {
          await slot.client.setMode(TrainingMode.Idle);
        } catch (e) {
          log.info('device.disconnect: setMode(Idle) failed (best-effort, proceeding)', e);
        }
      }
      let managerDisconnectError: unknown = null;
      if (wasConnected) {
        try {
          await state.manager.disconnect(id);
        } catch (e) {
          // Swallow into the local var; we still want the defensive teardown
          // below to run so slot bookkeeping reaches a clean terminal state.
          // The error is rethrown after slot teardown so the tool still
          // surfaces failure to the caller.
          managerDisconnectError = e;
        }
      }
      // Belt-and-suspenders BLE teardown: force-close a captured adapter even
      // if `manager.disconnect` succeeded silently against a partial-disconnect
      // path (W3C `device.gatt.disconnect()` is fire-and-forget; the SimpleBLE
      // handle map can leak), then dispose the slot client (idempotent —
      // returns early if `manager.disconnect` already disposed it). Both steps
      // are best-effort and log-at-info on failure so slot bookkeeping below
      // still reaches a clean terminal state.
      await teardownBleResources(adapterRef, slot.client);
      // Slot teardown only runs when the slot was actually connected. A
      // disconnect against an idle primary slot stays a true no-op (the
      // existing test asserts manager.disconnect wasn't called); rebuilding
      // a fresh client in that case would churn references for no reason.
      // Non-primary slots are always removed when this tool is reached —
      // the slot's existence implies a successful prior `device.connect`,
      // so a `device.disconnect` on a non-primary slot is by definition a
      // teardown.
      if (slotId === PRIMARY_SLOT) {
        if (wasConnected) {
          resetPrimarySlot(state);
        }
      } else {
        removeSlot(state, slotId);
      }
      if (managerDisconnectError !== null) {
        throw managerDisconnectError;
      }
      return { ok: true };
    }),
  );

  // device.set_weight — direct passthrough to the SDK; the schema clamps
  // input to the device-allowed range so the SDK never sees out-of-band lbs.
  // Wrapped in `trackedSetterCall` so the bridge can correlate a subsequent
  // cmd=0x10 cascade echo at `baseWeight !== input.lbs` into a
  // `setting_coerced` channel event (F2/F3). VMCP-02.40: source from cmd=0x10
  // (`baseWeight`, whole lbs) rather than state-dump (`weightLbsTenths`, ×10,
  // lazily-refreshed firmware-internal effective-weight) — the cmd=0x10 echo
  // is the only frame that reliably reflects user-set weight per-write.
  install(
    placeholders,
    'device.set_weight',
    DeviceSetWeightInput,
    wrapHandler(DeviceSetWeightInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_weight',
        [{ field: 'baseWeight', requested: input.lbs }],
        () => slot.client.setWeight(input.lbs),
      );
      return { ok: true };
    }),
  );

  // device.set_mode — input is the enum NAME; map back to the SDK numeric
  // value before calling. `Idle` is excluded by the schema (EC-05), so by
  // the time we reach the body the lookup is guaranteed to land on a
  // valid `TrainingMode` member.
  //
  // <Bug-22> Per A10 mode-hierarchy research: the SDK encapsulates the
  // correct primitive for Rowing — `client.setMode(Rowing)` auto-routes
  // to enterRowMode + startRow (Just Row, no preset). MCP callers that
  // need a distance preset can still use `device.start_row` directly.
  // Either way, the strength-arm primitive (`BP_SET_FITNESS_MODE = 5`)
  // is NEVER written for Rowing — firmware would silently reinterpret
  // it as a strength session, reverting the rowing flow. HIGH safety.
  install(
    placeholders,
    'device.set_mode',
    DeviceSetModeInput,
    wrapHandler(DeviceSetModeInput, async (input) => {
      const value = (TrainingMode as unknown as Record<string, number>)[input.mode];
      await getSlot(state, input.slot).client.setMode(value as TrainingMode);
      return { ok: true };
    }),
  );

  // <Bug-22> Stage 1 of Rowing entry — opens the Just-Row / Distance
  // sub-menu without engaging resistance. The slot's client must be
  // connected; otherwise the SDK throws `NotConnectedError`, which
  // `wrapHandler` maps to a structured tool error.
  install(
    placeholders,
    'device.enter_row_mode',
    DeviceEnterRowModeInput,
    wrapHandler(DeviceEnterRowModeInput, async (input) => {
      await getSlot(state, input.slot).client.enterRowMode();
      return { ok: true };
    }),
    'Open the Voltra rowing sub-menu (stage 1 of 2). Must be followed by ' +
      'device.start_row to commit into a live rowing session. The cable will ' +
      'NOT engage between these two calls.',
  );

  // <Bug-22> Stage 2 of Rowing entry — commits via EP_SCR_SWITCH and
  // schedules SDK-side reasserts at +750/+1750/+3000 ms. `distance`
  // defaults to `'JustRow'` (free row, no preset).
  install(
    placeholders,
    'device.start_row',
    DeviceStartRowInput,
    wrapHandler(DeviceStartRowInput, async (input) => {
      await getSlot(state, input.slot).client.startRow(input.distance);
      return { ok: true };
    }),
    'Commit into a live rowing session (stage 2 of 2). Requires a prior ' +
      'device.enter_row_mode. Distance presets are iPad-side stroke targets — ' +
      'EP_SCR_SWITCH only selects the preset screen.',
  );
  // </Bug-22>

  // device.set_chains — passthrough; schema enforces 0–100 lbs. Wrapped in
  // `trackedSetterCall`: the firmware silently caps chains at weight, so a
  // request of 60 lbs against a 50-lb weight surfaces as `chains = 50` in the
  // cmd=0x10 cascade echo (not 60) — that mismatch is exactly the F3 coercion
  // signal. VMCP-02.40: source from cmd=0x10 (`chains`, whole lbs) rather than
  // state-dump (`chainTargetForceTenths`, ×10, lazily-refreshed
  // firmware-internal effective chain force).
  install(
    placeholders,
    'device.set_chains',
    DeviceSetChainsInput,
    wrapHandler(DeviceSetChainsInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_chains',
        [{ field: 'chains', requested: input.lbs }],
        () => slot.client.setChains(input.lbs),
      );
      return { ok: true };
    }),
  );

  // device.set_eccentric — passthrough; schema enforces -195..+195 in pound
  // steps. Wrapped in `trackedSetterCall` so a device-side coercion (firmware
  // safety ramp, etc.) surfaces as a `setting_coerced` channel event when
  // the post-write state-dump disagrees with the requested value. The
  // earlier "assistMode=on enforces an ecc floor" hypothesis (F2 original
  // PM finding) was retracted 2026-05-11 after hardware re-validation —
  // see VMCP-01.35.
  //
  // VMCP-02.04 — preferred input is `overloadLbs`; `percent` is accepted as
  // a deprecated alias for one release and logs a warning on use.
  install(
    placeholders,
    'device.set_eccentric',
    DeviceSetEccentricInput,
    wrapHandler(DeviceSetEccentricInput, async (input) => {
      const slot = getSlot(state, input.slot);
      const value = input.overloadLbs ?? (input.percent as number);
      if (input.overloadLbs === undefined && input.percent !== undefined) {
        log.warn(
          'device.set_eccentric: `percent` param is deprecated, use `overloadLbs` instead. The legacy alias will be removed in the next release.',
        );
      }
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_eccentric',
        [{ field: 'eccentricPercentTenths', requested: value * 10 }],
        () => slot.client.setEccentric(value),
      );
      return { ok: true };
    }),
    SET_ECCENTRIC_DESCRIPTION,
  );

  // ── SDK 0.6.0 mode-config setters ──────────────────────────────────────
  //
  // Each tool is a thin passthrough to the corresponding `client.setX`
  // method. SDK-side validation (range / step / mode-state) is the
  // authoritative gate: the MCP schema sanity-bounds the input, and any
  // rejection by the SDK surfaces through `wrapHandler`'s error mapping as
  // an `InvalidSettingError` (or `NotConnectedError` if disconnected).

  install(
    placeholders,
    'device.set_damper_level',
    DeviceSetDamperLevelInput,
    wrapHandler(DeviceSetDamperLevelInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_damper_level',
        [{ field: 'damperLevel', requested: input.level }],
        () => slot.client.setDamperLevel(input.level),
      );
      return { ok: true };
    }),
    DAMPER_LEVEL_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_assist_mode',
    DeviceSetAssistModeInput,
    wrapHandler(DeviceSetAssistModeInput, async (input) => {
      // Device reports assistMode as 0 (off) / 2 (on) / 8 (idle sentinel)
      // in state-dump frames. Translate the user enum to the device's
      // 0/2 representation so coercion comparison stays apples-to-apples.
      const slot = getSlot(state, input.slot);
      const requested = input.mode === 'on' ? 2 : 0;
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_assist_mode',
        [{ field: 'assistMode', requested }],
        () => slot.client.setAssistMode(input.mode),
      );
      return { ok: true };
    }),
    ASSIST_MODE_DESCRIPTION,
  );

  // band-max-force / isokinetic setters: the SDK explicitly notes the
  // device does NOT echo these in settings-update / state-dump frames
  // (see SDK voltra-client.d.ts comments on `setBandMaxForce`). The
  // tracked-setter call still registers a check so future protocol
  // versions that surface them would auto-light up; today the check
  // silently expires after `COERCION_WINDOW_MS`.
  install(
    placeholders,
    'device.set_band_max_force',
    DeviceSetBandMaxForceInput,
    wrapHandler(DeviceSetBandMaxForceInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_band_max_force',
        [{ field: 'bandMaxForceLbsTenths', requested: input.lbs * 10 }],
        () => slot.client.setBandMaxForce(input.lbs),
      );
      return { ok: true };
    }),
    BAND_MAX_FORCE_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_target_speed',
    DeviceSetIsokineticTargetSpeedInput,
    wrapHandler(DeviceSetIsokineticTargetSpeedInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_isokinetic_target_speed',
        [{ field: 'isokineticTargetSpeedMmPerSec', requested: input.mmPerSec }],
        () => slot.client.setIsokineticTargetSpeed(input.mmPerSec),
      );
      return { ok: true };
    }),
    ISOKINETIC_TARGET_SPEED_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_mode',
    DeviceSetIsokineticEccModeInput,
    wrapHandler(DeviceSetIsokineticEccModeInput, async (input) => {
      // Mode is an enum string. The CoercionWatch compares numeric
      // device values, so we use a fingerprint: 0 = 'isokinetic',
      // 1 = 'constant'. Device doesn't echo this today; the check
      // silently expires.
      const slot = getSlot(state, input.slot);
      const requested = input.mode === 'constant' ? 1 : 0;
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_isokinetic_ecc_mode',
        [{ field: 'isokineticEccMode', requested }],
        () => slot.client.setIsokineticEccMode(input.mode),
      );
      return { ok: true };
    }),
    ISOKINETIC_ECC_MODE_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_speed_limit',
    DeviceSetIsokineticEccSpeedLimitInput,
    wrapHandler(DeviceSetIsokineticEccSpeedLimitInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_isokinetic_ecc_speed_limit',
        [{ field: 'isokineticEccSpeedLimitMmPerSec', requested: input.mmPerSec }],
        () => slot.client.setIsokineticEccSpeedLimit(input.mmPerSec),
      );
      return { ok: true };
    }),
    ISOKINETIC_ECC_SPEED_LIMIT_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_const_weight',
    DeviceSetIsokineticEccConstWeightInput,
    wrapHandler(DeviceSetIsokineticEccConstWeightInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_isokinetic_ecc_const_weight',
        [{ field: 'isokineticEccConstWeightLbsTenths', requested: input.lbs * 10 }],
        () => slot.client.setIsokineticEccConstWeight(input.lbs),
      );
      return { ok: true };
    }),
    ISOKINETIC_ECC_CONST_WEIGHT_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_overload_weight',
    DeviceSetIsokineticEccOverloadWeightInput,
    wrapHandler(DeviceSetIsokineticEccOverloadWeightInput, async (input) => {
      const slot = getSlot(state, input.slot);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.set_isokinetic_ecc_overload_weight',
        [{ field: 'isokineticEccOverloadWeightLbsTenths', requested: input.lbs * 10 }],
        () => slot.client.setIsokineticEccOverloadWeight(input.lbs),
      );
      return { ok: true };
    }),
    ISOKINETIC_ECC_OVERLOAD_WEIGHT_DESCRIPTION,
  );

  // device.configure_isokinetic (VMCP-02.16) — one tool for the whole
  // isokinetic config. Registers every supplied field as a coercion check
  // under one setter name, then writes them in sequence inside a single
  // tracked call (mirrors start_guided_load's multi-field pattern). Required
  // fields first (target speed, ecc mode); optional ecc tuning fields only
  // when present.
  install(
    placeholders,
    'device.configure_isokinetic',
    DeviceConfigureIsokineticInput,
    wrapHandler(DeviceConfigureIsokineticInput, async (input) => {
      const slot = getSlot(state, input.slot);
      // Ecc mode is an enum string; the CoercionWatch compares numeric device
      // values, so fingerprint it (0 = 'isokinetic', 1 = 'constant') exactly
      // as device.set_isokinetic_ecc_mode does.
      const fields: TrackedFieldSpec[] = [
        { field: 'isokineticTargetSpeedMmPerSec', requested: input.targetSpeedMmPerSec },
        { field: 'isokineticEccMode', requested: input.eccMode === 'constant' ? 1 : 0 },
      ];
      if (typeof input.eccSpeedLimitMmPerSec === 'number') {
        fields.push({
          field: 'isokineticEccSpeedLimitMmPerSec',
          requested: input.eccSpeedLimitMmPerSec,
        });
      }
      if (typeof input.eccConstWeightLbs === 'number') {
        fields.push({
          field: 'isokineticEccConstWeightLbsTenths',
          requested: input.eccConstWeightLbs * 10,
        });
      }
      if (typeof input.eccOverloadWeightLbs === 'number') {
        fields.push({
          field: 'isokineticEccOverloadWeightLbsTenths',
          requested: input.eccOverloadWeightLbs * 10,
        });
      }
      await trackedSetterCall(
        slot.coercionWatch,
        'device.configure_isokinetic',
        fields,
        async () => {
          await slot.client.setIsokineticTargetSpeed(input.targetSpeedMmPerSec);
          await slot.client.setIsokineticEccMode(input.eccMode);
          if (typeof input.eccSpeedLimitMmPerSec === 'number') {
            await slot.client.setIsokineticEccSpeedLimit(input.eccSpeedLimitMmPerSec);
          }
          if (typeof input.eccConstWeightLbs === 'number') {
            await slot.client.setIsokineticEccConstWeight(input.eccConstWeightLbs);
          }
          if (typeof input.eccOverloadWeightLbs === 'number') {
            await slot.client.setIsokineticEccOverloadWeight(input.eccOverloadWeightLbs);
          }
        },
      );
      return { ok: true };
    }),
    CONFIGURE_ISOKINETIC_DESCRIPTION,
  );

  // device.unload (VMCP-02.06) — drives the device into a fully-unloaded
  // mechanical state via mode-bounce (Damper → WeightTraining). Required
  // before `device.start_guided_load` for the visible countdown ceremony to
  // fire; idempotent. `start_guided_load` auto-invokes this primitive by
  // default — explicit `device.unload` is for callers driving custom flows.
  install(
    placeholders,
    'device.unload',
    DeviceUnloadInput,
    wrapHandler(DeviceUnloadInput, async (input) => {
      const slotId = input.slot ?? PRIMARY_SLOT;
      const slot = getSlot(state, slotId);
      // VMCP-02.41: capture whether we are tearing down an active guided-load
      // flow BEFORE the mode-bounce. `unloadDevice()` physically drops the
      // cable but never touches the SDK's guided-load state machine, so
      // `guidedLoadState.phase` — and the `load_state` / `guided_load.phase`
      // that get_state derives from it — would stay stale at `active` /
      // `loaded` after the unload. When unload is the teardown for an active
      // flow, drive the SDK through `exitGuidedLoad()` too: that transitions
      // the phase to `exited` (refreshing get_state), fires onGuidedLoadState
      // so the bridge publishes the terminal `guided_load_state` channel event
      // (outcome: 'ended'), and lets us reap the auto-created scaffold —
      // automating the validated unload-then-exit_guided_load recovery.
      const wasGuidedLoadActive = GUIDED_LOAD_ACTIVE_PHASES.has(slot.client.guidedLoadState.phase);
      await slot.client.unloadDevice();
      if (wasGuidedLoadActive) {
        await slot.client.exitGuidedLoad();
        await reapGuidedLoadScaffold(state, slotId);
      }
      return { ok: true };
    }),
    UNLOAD_DESCRIPTION,
  );

  // device.start_guided_load (Phase 1g, @experimental) — wraps the SDK's
  // `startGuidedLoad`. Resolves once the trigger frame has been written and
  // the SDK's polling loop is armed; downstream phase transitions surface
  // through the event-bridge's `guided_load_state` debug events plus the
  // auto-created session/set context (closes Bugs 28/29).
  //
  // VMCP-02.06 — auto-invokes the unload mode-bounce before the trigger
  // unless `skipUnload: true`. The firmware ceremony short-circuits to
  // `phase: active` if the cable is mechanically loaded at trigger time;
  // pre-unloading is idempotent and makes the tool reliable from any slot
  // state. The unload is NOT routed through `trackedSetterCall` because
  // the two mode writes intentionally pass through the device's mode-echo
  // path — a guided-load-attributed coercion check would false-positive on
  // the transient Damper observation.
  install(
    placeholders,
    'device.start_guided_load',
    DeviceStartGuidedLoadInput,
    wrapHandler(DeviceStartGuidedLoadInput, async (input) => {
      const opts: {
        targetWeightLbs: number;
        pollIntervalMs?: number;
        pollDurationMs?: number;
      } = { targetWeightLbs: input.targetWeightLbs };
      if (typeof input.pollIntervalMs === 'number') {
        opts.pollIntervalMs = input.pollIntervalMs;
      }
      if (typeof input.pollDurationMs === 'number') {
        opts.pollDurationMs = input.pollDurationMs;
      }
      const slot = getSlot(state, input.slot);
      // VMCP-02.15: stash the requested inactivity timeout on the slot so
      // the bridge's auto-create path can pick it up when it mints the
      // guided-load set on the `armed` phase. Defaults to 30s — short
      // enough to reap a failed engagement quickly, long enough to cover
      // the firmware's 10-15s armed → countdown → engaging → active
      // ceremony. Cleared by the bridge once consumed (single-shot).
      slot.pendingGuidedLoadInactivityMs =
        typeof input.inactivityTimeoutSeconds === 'number'
          ? input.inactivityTimeoutSeconds * 1000
          : GUIDED_LOAD_DEFAULT_INACTIVITY_MS;
      // VMCP-02.13: stash the exercise identity so the bridge's auto-create
      // path names the session something filterable instead of the generic
      // "Guided Load (auto)". Single-shot — the bridge clears these once
      // consumed. Only takes effect when the bridge mints a NEW session; a
      // reused explicit session keeps its own name. Reset on every call
      // (deleting when absent) so a stale stash from a prior trigger that
      // never armed doesn't leak into this one.
      if (input.exerciseName !== undefined) {
        slot.pendingGuidedLoadExerciseName = input.exerciseName;
      } else {
        delete slot.pendingGuidedLoadExerciseName;
      }
      if (input.exerciseId !== undefined) {
        slot.pendingGuidedLoadExerciseId = input.exerciseId;
      } else {
        delete slot.pendingGuidedLoadExerciseId;
      }
      // VMCP-02.03: stash the requested target so the bridge can surface
      // `requested_target_lbs` on the first-class guided_load_state channel
      // event. NOT single-shot — the bridge reads it on every phase
      // transition and clears it on the terminal phase (exited/timeout).
      slot.pendingGuidedLoadTargetLbs = input.targetWeightLbs;
      // VMCP-02.45: from a cold Idle/no-mode start the firmware suppresses
      // state-dump telemetry AND the auto-unload (Workout.STOP) does not
      // establish a training mode — so BP_BASE_WEIGHT + the AA12 trigger land
      // on a device that falls straight back to Idle and never engages (the
      // user sees inactivity_timeout, 0 reps, and a silent channel). When the
      // device is in Idle, drive it into WeightTraining first so telemetry
      // resumes and the trigger sticks, and skip the Workout.STOP unload (the
      // cable is already slack in Idle, and STOP can knock the freshly-set
      // mode back to Idle). Mirrors the hardware-validated
      // set_mode(WeightTraining) → start_guided_load(skipUnload) recovery
      // (HANDOFF-2026-05-21-vmcp-02.29-phase-1-parity-data §'Engagement
      // journey'). A failed setMode propagates as a structured error rather
      // than the silent inactivity_timeout the bug produced.
      //
      // `trainingMode` is the REQUESTED mode echoed from the cmd=0x10 cascade
      // and is `undefined` until the first cascade fires. On a fresh boot/wake
      // — the exact cold-start this preflight targets — no requested mode has
      // been observed yet, so treat that unknown/absent requested mode the same
      // as explicit Idle: drive WeightTraining and skip the unload. (Requested
      // intent only; do NOT consult the applied-mode `trainingModeRaw` here.)
      const requestedMode = slot.live.snapshotDevice().trainingMode;
      if (shouldPreflightWeightTraining(requestedMode)) {
        await slot.client.setMode(TrainingMode.WeightTraining);
      } else if (input.skipUnload !== true) {
        // VMCP-02.06: drive the cable to a mechanically-unloaded state before
        // the trigger so the firmware emits the countdown ceremony. Caller
        // can opt out via `skipUnload` for diagnostic flows.
        await slot.client.unloadDevice();
      }
      // F3 coercion correlation: guided-load runs a firmware safety
      // sequence that can silently floor chains + eccentric to safe
      // minimums on a low target weight (e.g. 5 lb target → chains
      // capped at 2 lb, ecc capped at 8%). The setter writes the target
      // weight directly, so the chains/ecc "requested" values are
      // whatever the user had previously configured — read from the
      // live snapshot at call time. Fields with no prior configured
      // value are skipped (the bridge has no requested-baseline to
      // compare against).
      const preDevice = slot.live.snapshotDevice();
      // baseWeight uses 'exact' mode: the user's explicit target is the new
      // value the firmware should converge on. chains uses 'guard' mode: the
      // user's PRIOR setting is the baseline they expect to persist across
      // the guided-load entry, and the firmware ramping it to a safe minimum
      // (chains 100→20 at low targets — hardware capture 2026-05-11) is the
      // coercion we want to surface. The longer GUIDED_LOAD window
      // accommodates the firmware's ~10s internal safety-ramp settle.
      //
      // VMCP-02.40: baseWeight + chains source from cmd=0x10 cascade echo
      // (whole lbs, refreshed per-write). The earlier state-dump-sourced
      // `weightLbsTenths` / `chainTargetForceTenths` are lazily-updated
      // firmware-internal effective-force values and false-positive on the
      // Damper→WeightTraining mode-bounce transient. Eccentric remains on
      // the state-dump path with its existing 2-of-2 stability defense
      // (handles the documented 80→320→0 transient burst) until a separate
      // pass routes it through cmd=0x10 too.
      const fields = buildGuidedLoadTrackedFields(input.targetWeightLbs, preDevice);
      await trackedSetterCall(
        slot.coercionWatch,
        'device.start_guided_load',
        fields,
        () => slot.client.startGuidedLoad(opts),
        { windowMs: COERCION_WINDOW_MS_GUIDED_LOAD },
      );
      return { ok: true };
    }),
    START_GUIDED_LOAD_DESCRIPTION,
  );

  // device.exit_guided_load (Phase 1g, @experimental) — wraps the SDK's
  // `exitGuidedLoad`. Guards against calling exit when the device isn't in
  // an active guided-load phase so callers get a structured error rather than
  // a silent no-op write. The `onGuidedLoadState` bridge wiring already
  // surfaces the resulting `exited` phase transition as a `guided_load_state`
  // debug event, so no extra event emission is needed here.
  //
  // F4 (VMCP-01.19) — auto-reap the set the bridge minted on `armed`.
  // Without this, the set sits empty until the inactivity watchdog kills
  // it ~93s later. We finalize with `partialReason: 'guided_load_exited'`
  // and `disengageMotor: false` (the SDK's `exitGuidedLoad()` already
  // wrote the exit frame — re-firing `Workout.STOP` would be redundant).
  //
  // F8 (VMCP-01.24) — when the closed set leaves the auto-created
  // session empty, end it too. Without the reap, a stale "Guided Load
  // (auto)" session blocks the next `session.start` with
  // `SESSION_ALREADY_ACTIVE`. We only reap sessions tagged
  // `autoCreatedBy: 'guided_load'` so explicit sessions that happened
  // to be running during a guided-load demo are untouched.
  install(
    placeholders,
    'device.exit_guided_load',
    DeviceExitGuidedLoadInput,
    wrapHandler(DeviceExitGuidedLoadInput, async (input) => {
      const slotId = input.slot ?? PRIMARY_SLOT;
      const slot = getSlot(state, slotId);
      const { phase } = slot.client.guidedLoadState;
      if (!GUIDED_LOAD_ACTIVE_PHASES.has(phase)) {
        throwSdkLike(
          'NOT_IN_GUIDED_LOAD',
          `Slot \`${input.slot ?? PRIMARY_SLOT}\` is not in an active guided-load phase (current: "${phase}"). Call device.start_guided_load first.`,
        );
      }
      await slot.client.exitGuidedLoad();
      await reapGuidedLoadScaffold(state, slotId);
      return { ok: true };
    }),
    EXIT_GUIDED_LOAD_DESCRIPTION,
  );

  // device.send_raw — DIAGNOSTIC byte-pipe. Reaches through `client.getAdapter()`
  // (a public SDK method) to the BLE adapter's `write(Uint8Array)`. No opcode
  // validation, no semantic checks — the caller owns byte semantics.
  //
  // Mock-mode gate: returns a structured `MOCK_NOT_SUPPORTED` error. We never
  // pretend to succeed in mock mode because the only reason to invoke this
  // tool is to probe real-hardware behavior; a silent mock success would
  // mislead the caller into thinking a campaign step verified something it
  // did not.
  //
  // Audit trail: every invocation appends a `send_raw` event to the debug
  // ring buffer (visible via `debug.recent_events`) with the hex echo of the
  // bytes written, the slot, byte count, expectResponse flag, and (on
  // completion) the count of frames captured during the response window.
  // The event is always recorded — INVALID_INPUT failures, mock-mode
  // rejections, and write errors all leave a trace.
  install(
    placeholders,
    'device.send_raw',
    DeviceSendRawInput,
    wrapHandler(DeviceSendRawInput, async (input) => {
      const startedAt = new Date();
      const slotId = input.slot ?? PRIMARY_SLOT;

      // Mock-adapter gate (constraint: do NOT pretend to succeed in mock mode).
      if (state.config.adapter === 'mock') {
        recordSendRawEvent(startedAt.getTime(), {
          slot: slotId,
          bytesWritten: 0,
          bytesHex: '',
          expectResponse: input.expectResponse,
          outcome: 'mock_not_supported',
        });
        throwSdkLike(
          'MOCK_NOT_SUPPORTED',
          'device.send_raw is a diagnostic tool that requires real hardware. Run with VOLTRA_ADAPTER=node against a connected device.',
        );
      }

      const data = bytesToUint8Array(input.bytes);
      const bytesHex = uint8ArrayToHex(data);

      const slot = getSlot(state, slotId);
      const adapter = slot.client.getAdapter();
      if (adapter === null) {
        recordSendRawEvent(startedAt.getTime(), {
          slot: slotId,
          bytesWritten: data.length,
          bytesHex,
          expectResponse: input.expectResponse,
          outcome: 'no_adapter',
        });
        throwSdkLike(
          'NOT_CONNECTED',
          `Slot \`${slotId}\` has no BLE adapter — connect a device first via device.connect.`,
        );
      }
      if (!slot.client.isConnected) {
        recordSendRawEvent(startedAt.getTime(), {
          slot: slotId,
          bytesWritten: data.length,
          bytesHex,
          expectResponse: input.expectResponse,
          outcome: 'not_connected',
        });
        throwSdkLike(
          'NOT_CONNECTED',
          `Slot \`${slotId}\` is not connected — connect a device first via device.connect.`,
        );
      }

      // Pre-arm the response listener BEFORE the write so a fast device
      // reply arriving during the write's microtask is not lost. The
      // promise resolves when the window expires; the listener detaches
      // unconditionally inside the `finally`-equivalent path.
      const responseCollector = input.expectResponse
        ? collectResponses(adapter, input.responseWindowMs)
        : null;

      try {
        await adapter.write(data);
      } catch (err) {
        responseCollector?.cancel();
        recordSendRawEvent(startedAt.getTime(), {
          slot: slotId,
          bytesWritten: data.length,
          bytesHex,
          expectResponse: input.expectResponse,
          outcome: 'write_failed',
        });
        throw err;
      }

      const responses = responseCollector ? await responseCollector.done : undefined;

      recordSendRawEvent(startedAt.getTime(), {
        slot: slotId,
        bytesWritten: data.length,
        bytesHex,
        expectResponse: input.expectResponse,
        outcome: 'ok',
        responsesCaptured: responses?.length ?? 0,
      });

      const out: Record<string, unknown> = {
        ok: true,
        bytesWritten: data.length,
        bytesHex,
        timestamp: startedAt.toISOString(),
      };
      if (responses !== undefined) {
        out.responses = responses;
      }
      return out;
    }),
    SEND_RAW_DESCRIPTION,
  );

  // device.get_state — composes the response from `live.snapshotDevice()`
  // (the same source `voltra://device/{slot}/current` reads from) so the two
  // surfaces stay in lockstep across the disconnect window. Pre-Phase-0.5.2
  // this read fields directly off `slot.client.settings`, which the SDK
  // resets to defaults on cleanup — leaving the tool returning weightLbs:0
  // / trainingMode:"Idle" while the resource still served the preserved
  // last-known values (Bug filed 2026-05-08 dual-Voltra test).
  install(
    placeholders,
    'device.get_state',
    DeviceGetStateInput,
    wrapHandler(DeviceGetStateInput, async (input) => {
      const slot = getSlot(state, input.slot);
      // `connected` and `connectionState` reflect the LIVE client state — they
      // must flip to false/`disconnected` immediately on a drop, so we do not
      // route them through the preserved snapshot.
      const device = slot.live.snapshotDevice();
      // Persisted-binding lookup uses the preserved deviceId so the binding
      // remains visible across the disconnect window (matches the rest of
      // the response, which prefers preserved values for routability).
      const slotBinding =
        typeof device.deviceId === 'string' ? state.slotBindings.get(device.deviceId) : null;
      const response = buildDeviceGetStateResponse(
        slot.client.isConnected,
        slot.client.connectionState,
        slot.client.isRowingActive,
        slot.client.isRecording,
        slot.client.guidedLoadState,
        device,
        slot.modeRevertGuard.peekAbort(),
        slot.live.snapshotSet(),
        slotBinding,
      );
      // VMCP-02.32: drain any delayed disconnect advisory so the agent learns
      // of a drop that landed while push channels were off — before it acts on
      // the state. Drain-once: not re-delivered on the next get_state.
      const disconnectNotice = slot.live.takePendingDisconnectNotice();
      if (disconnectNotice !== undefined) {
        response.disconnect_notice = disconnectNotice;
      }
      return response;
    }),
  );

  // bilateral.cascade — bundle 1..4 device setters across 1..N slots into
  // one tool call. Replaces the 4-8 sequential setter calls a PT skill would
  // otherwise need to configure both Voltras at the start of a bilateral set.
  install(
    placeholders,
    'bilateral.cascade',
    BilateralCascadeInput,
    wrapHandler(BilateralCascadeInput, async (input) => {
      const targetSlotIds = resolveCascadeSlotIds(state, input.slots);
      const plan = buildCascadePlan(input);
      const targets = targetSlotIds.map((slotId) => {
        const slot = getSlot(state, slotId);
        return {
          slotId,
          client: slot.client,
          coercionWatch: slot.coercionWatch,
        };
      });
      const results = await cascadeAcrossSlots(targets, plan, input.abortOnFirstFailure);
      const out: Record<string, unknown> = { ok: cascadeAllOk(results), results };
      // VMCP-02.32: drain any delayed disconnect advisory for each target slot
      // (a slot that dropped mid-lull and reconnected still carries an
      // un-delivered notice while channels are off). Keyed by slot id, present
      // only when at least one target has a pending notice. A currently-
      // disconnected slot never reaches here — resolveCascadeSlotIds rejects it
      // up front, surfacing the drop through that INVALID_INPUT path instead.
      const disconnectNotices = drainCascadeDisconnectNotices(state, targetSlotIds);
      if (disconnectNotices !== undefined) {
        out.disconnect_notices = disconnectNotices;
      }
      return out;
    }),
    BILATERAL_CASCADE_DESCRIPTION,
  );

  // slot.swap — exchanges the device bindings between the two slots without
  // any BLE work. Use case: the side-ID ritual reveals the slot↔side mapping
  // is reversed; swapping in-memory collapses the otherwise ~6-call
  // disconnect/scan/reconnect sequence into one. See `swapSlots` in
  // `state/slot-manager.ts` for the mutation semantics.
  install(
    placeholders,
    'slot.swap',
    SlotSwapInput,
    wrapHandler(SlotSwapInput, async () => {
      swapSlots(state);
      return { ok: true, bindings: snapshotSlotBindings(state) };
    }),
    'Swap the device bindings between the two connected slots in place. No BLE writes, no SDK calls — pure in-memory mutation. Requires exactly two slots whose client is currently connected (unconnected placeholder slots are ignored). Returns the new binding map.',
  );
}

/**
 * Resolve the list of slot ids the cascade should fan out across. Throws a
 * structured INVALID_INPUT before any setter fires when:
 *   * the explicit list is empty (would make the tool a no-op);
 *   * any explicit slot id is not currently bound + connected.
 *
 * When `inputSlots` is omitted, returns every currently-connected slot in
 * natural map-iteration order (insertion order — primary first when bound,
 * then any explicit slots in the order they were allocated).
 */
/**
 * Drain the delayed disconnect advisory (VMCP-02.32) for each cascade target
 * slot, keyed by slot id. Returns `undefined` when no target had a pending
 * notice so the caller can omit the field entirely. Drain-once per slot.
 */
function drainCascadeDisconnectNotices(
  state: ServerState,
  slotIds: string[],
): Record<string, PendingDisconnectNotice> | undefined {
  const notices: Record<string, PendingDisconnectNotice> = {};
  for (const slotId of slotIds) {
    const notice = getSlot(state, slotId).live.takePendingDisconnectNotice();
    if (notice !== undefined) {
      notices[slotId] = notice;
    }
  }
  return Object.keys(notices).length > 0 ? notices : undefined;
}

function resolveCascadeSlotIds(state: ServerState, inputSlots: string[] | undefined): string[] {
  if (inputSlots === undefined) {
    const connected: string[] = [];
    for (const [slotId, slot] of state.slots) {
      if (slot.client.isConnected) connected.push(slotId);
    }
    if (connected.length === 0) {
      throwSdkLike(
        'INVALID_INPUT',
        'No slots are currently connected — connect at least one device via device.connect first, or pass an explicit `slots` list.',
      );
    }
    return connected;
  }
  if (inputSlots.length === 0) {
    throwSdkLike(
      'INVALID_INPUT',
      '`slots` cannot be empty — omit the field to fan out across every connected slot, or pass at least one slot id.',
    );
  }
  const unbound: string[] = [];
  for (const slotId of inputSlots) {
    const slot = state.slots.get(slotId);
    if (slot === undefined || !slot.client.isConnected) {
      unbound.push(slotId);
    }
  }
  if (unbound.length > 0) {
    throwSdkLike(
      'INVALID_INPUT',
      `Unbound or disconnected slot(s): ${unbound.map((s) => `\`${s}\``).join(', ')}. Connect each slot via device.connect before invoking bilateral.cascade.`,
    );
  }
  return inputSlots;
}

/**
 * Translate the validated tool input into a `CascadePlan` and enforce the
 * full-settings contract — every setter must be supplied (VMCP-02.27). The
 * mode-name → numeric-enum map mirrors `device.set_mode`'s handler so both
 * tools agree on the SDK-call shape.
 */
function buildCascadePlan(input: {
  mode?: string | undefined;
  weightLbs?: number | undefined;
  eccentricOverloadLbs?: number | undefined;
  eccentricPercent?: number | undefined;
  chainsLbs?: number | undefined;
}): CascadePlan {
  const plan: CascadePlan = {};
  if (input.mode !== undefined) {
    plan.mode = (TrainingMode as unknown as Record<string, number>)[input.mode] as TrainingMode;
  }
  if (input.weightLbs !== undefined) plan.weightLbs = input.weightLbs;
  // VMCP-02.04: prefer `eccentricOverloadLbs`; fall back to the deprecated
  // alias and log a warning. The CascadePlan's interior name remains
  // `eccentricPercent` for one release to avoid touching state/ + tests not
  // owned by this agent; the SDK call is the same regardless.
  if (input.eccentricOverloadLbs !== undefined) {
    plan.eccentricPercent = input.eccentricOverloadLbs;
  } else if (input.eccentricPercent !== undefined) {
    plan.eccentricPercent = input.eccentricPercent;
    log.warn(
      'bilateral.cascade: `eccentricPercent` param is deprecated, use `eccentricOverloadLbs` instead. The legacy alias will be removed in the next release.',
    );
  }
  if (input.chainsLbs !== undefined) plan.chainsLbs = input.chainsLbs;
  const missing = missingCascadeSetters(plan);
  if (missing.length > 0) {
    throwSdkLike(
      'INVALID_INPUT',
      `bilateral.cascade enforces a full-settings contract: every call must set all of \`mode\`, \`weightLbs\`, \`eccentricOverloadLbs\`, and \`chainsLbs\` so the applied device state is fully specified and no omitted setter carries a stale value from a prior cascade. Missing: ${missing.join(', ')}.`,
    );
  }
  return plan;
}

/**
 * List the cascade setters absent from a built plan, reported by their
 * PUBLIC param names (the internal `eccentricPercent` field surfaces as the
 * preferred `eccentricOverloadLbs`). Drives the full-settings contract: a
 * cascade must specify every setter so it fully overwrites device state
 * rather than leaving an omitted setter at its prior firmware value —
 * the stale-carryover bug from VMCP-02.27.
 */
function missingCascadeSetters(plan: CascadePlan): string[] {
  const missing: string[] = [];
  if (plan.mode === undefined) missing.push('mode');
  if (plan.weightLbs === undefined) missing.push('weightLbs');
  if (plan.eccentricPercent === undefined) missing.push('eccentricOverloadLbs');
  if (plan.chainsLbs === undefined) missing.push('chainsLbs');
  return missing;
}

/**
 * `ok: true` iff every slot succeeded on every requested setter. Iterates
 * the dense `applied` map (no fixed setter list) so adding a new setter
 * field later does not require updating this aggregator.
 */
function cascadeAllOk(results: SlotResult[]): boolean {
  for (const result of results) {
    for (const outcome of Object.values(result.applied)) {
      if (outcome === undefined) continue;
      if (!outcome.ok) return false;
    }
  }
  return true;
}

/**
 * Build a `{ [slotId]: { deviceId } }` map of the current slot bindings.
 * Returned by `slot.swap` so the caller can confirm the post-swap mapping
 * without a follow-up `device.get_state` per slot. Keyed by `slotId` (not
 * by an ordered array) so the caller does not have to remember which slot
 * key was at index 0 vs 1.
 */
function snapshotSlotBindings(state: ServerState): Record<string, { deviceId: string | null }> {
  const out: Record<string, { deviceId: string | null }> = {};
  for (const slot of state.slots.values()) {
    out[slot.slotId] = { deviceId: slot.client.connectedDeviceId };
  }
  return out;
}

/**
 * Compose the `device.get_state` tool response from a preserved
 * `DeviceSnapshot` plus the client's live transient fields and server-side
 * context. Mirrors the field shape of `voltra://device/{slot}/current` for
 * the preserved-state portion so callers get identical values across both
 * surfaces during the disconnect window (deviceId, weightLbs, trainingMode,
 * damperLevel, chainSettingLbs, plus the cmd=0x07 state-dump fields).
 *
 * Tool-only additions (transient, not preserved):
 *   * `connectionState`
 *   * `isRowingActive`
 *   * `is_recording` — `client.isRecording`, true between Workout.GO and STOP.
 *   * `guided_load` — `{ phase, countdown_remaining_ms, fitness_mode_raw }`
 *     from `client.guidedLoadState`. The phase is the firmware direct-load
 *     state machine: idle → armed → countdown → engaging → active → exited.
 *   * `load_state` — derived 'loaded' | 'unloaded' summary, true when the
 *     cable is physically engaged (guided-load phase 'engaging'/'active'
 *     or rowing two-stage active). Designed so a coach surface can ask
 *     "is the cable hot?" in one read, without reasoning about
 *     guided-load phase + rowing flag separately. VMCP-01.39.
 *   * `active_set` — `{ set_id, session_id, started_at, rep_count, status }`
 *     for the slot's currently-active set (null when no set is open).
 *     Lets the agent see whether the device is mid-set without a follow-up
 *     `set.get` call.
 *   * `slot_binding` — persisted `{ physical_side, bound_at, last_seen }`
 *     for the connected deviceId (null when unbound). Lets the agent
 *     decide whether the side-ID ritual is needed.
 *   * `mode_revert_latched` — VMCP-02.14: present when the mode-revert
 *     guard is holding a safety abort that will block the next set.start
 *     with SET_ABORTED_BY_MODE_REVERT. Absent ⇒ no abort latched.
 */
function buildDeviceGetStateResponse(
  isConnected: boolean,
  connectionState: string,
  isRowingActive: boolean,
  isRecording: boolean,
  guidedLoadState: GuidedLoadState,
  device: DeviceSnapshot,
  modeRevertLatched: ModeRevertAbort | null,
  activeSet: ActiveSet | undefined,
  slotBinding: SlotBinding | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    connected: isConnected,
    connectionState,
  };
  copyDefinedFields(out, device, [
    'deviceId',
    'weightLbs',
    'trainingMode',
    'batteryPercent',
    'damperLevel',
    'chainSettingLbs',
    'assistMode',
    'trainingModeRaw',
    'chainTargetForceTenths',
    'weightLbsTenths',
    'eccentricPercentTenths',
    'staleSinceDisconnect',
    'isStale',
    'disconnectedAt',
  ] as const);
  // VMCP-02.09: name the requested (cmd=0x10) vs applied (cmd=0x07) modes
  // explicitly so callers stop reading the requested `trainingMode` as if it
  // were the active one. `trainingMode` / `trainingModeRaw` stay as deprecated
  // aliases for one release.
  out.requested_mode = device.trainingMode ?? null;
  out.active_mode = activeModeName(device.trainingModeRaw);
  out.isRowingActive = isRowingActive;
  out.is_recording = isRecording;
  out.guided_load = {
    phase: guidedLoadState.phase,
    countdown_remaining_ms: guidedLoadState.countdownRemainingMs,
    fitness_mode_raw: guidedLoadState.fitnessModeRaw,
  };
  out.load_state = deriveLoadState(isConnected, guidedLoadState, isRowingActive);
  out.active_set =
    activeSet === undefined
      ? null
      : {
          set_id: activeSet.setId,
          session_id: activeSet.sessionId,
          started_at: activeSet.startedAt,
          rep_count: activeSet.reps.length,
          status: activeSet.status,
        };
  out.slot_binding =
    slotBinding === null
      ? null
      : {
          physical_side: slotBinding.physicalSide,
          bound_at: slotBinding.boundAt,
          last_seen: slotBinding.lastSeen ?? null,
        };
  if (modeRevertLatched !== null) {
    out.mode_revert_latched = {
      requested_mode:
        TrainingModeNames[modeRevertLatched.requested] ?? String(modeRevertLatched.requested),
      actual_mode: TrainingModeNames[modeRevertLatched.actual] ?? String(modeRevertLatched.actual),
      timestamp_ms: modeRevertLatched.timestampMs,
    };
  }
  return out;
}

/**
 * Map the slot's transient client state to a single `'loaded' | 'unloaded'`
 * verdict. Sources, in priority order:
 *   1. Disconnected → `'unloaded'` (no cable engaged from our POV).
 *   2. Guided-load phase is `'engaging'` or `'active'` → `'loaded'`
 *      (the firmware direct-load state machine has the cable hot).
 *   3. `isRowingActive` → `'loaded'` (rowing two-stage engaged).
 *   4. Otherwise → `'unloaded'`.
 *
 * The function deliberately ignores `isRecording` — Workout.GO can be live
 * across rests and short user pauses where the cable is slack, and the
 * coach surface should treat those moments as unloaded. Callers that need
 * a finer-grained answer can inspect `is_recording` + `guided_load.phase`
 * + telemetry force directly.
 */
function deriveLoadState(
  isConnected: boolean,
  guidedLoadState: GuidedLoadState,
  isRowingActive: boolean,
): 'loaded' | 'unloaded' {
  if (!isConnected) return 'unloaded';
  if (guidedLoadState.phase === 'engaging' || guidedLoadState.phase === 'active') return 'loaded';
  if (isRowingActive) return 'loaded';
  return 'unloaded';
}

/**
 * Copy each named field from `src` into `dst` only when the value is defined
 * (not null, not undefined). Keeps the response shape free of explicit
 * nulls — the tool's documented contract is "field absent when unknown",
 * matching the resource's `JSON.stringify(snapshot)` behavior which drops
 * undefined keys but would emit any null verbatim.
 */
function copyDefinedFields<K extends keyof DeviceSnapshot>(
  dst: Record<string, unknown>,
  src: DeviceSnapshot,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const value = src[key];
    if (value !== undefined && value !== null) {
      dst[key as string] = value;
    }
  }
}

/**
 * Synthesize an `Error` with a `code` field that `mapSdkError` will pass
 * through unchanged. Used for VMCP-internal preconditions (DEVICE_NOT_FOUND,
 * ALREADY_CONNECTED) that need to surface as structured tool errors without
 * importing the SDK's error class hierarchy directly here.
 */
function throwSdkLike(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  throw err;
}

/**
 * Sentinel `slot` value (`'auto'`) accepted by `device.connect` — resolves
 * the actual slot id from the persisted deviceId ↔ physical-side binding
 * (VMCP-02.05). Kept as a const so the comparison in
 * `resolveConnectSlotId` stays in lockstep with the description text.
 */
const AUTO_SLOT = 'auto' as const;

/**
 * Map a `device.connect` `slot` argument to the concrete slot id the
 * handler should bind into:
 *   * `undefined`            → `PRIMARY_SLOT` (single-device default).
 *   * any literal slot id    → that id verbatim.
 *   * `'auto'`               → resolved from the persisted binding for
 *                              `deviceId`. NO_PERSISTED_BINDING surfaces
 *                              when no binding exists, telling the caller
 *                              to fall back to an explicit slot + ritual.
 *
 * The physical-side → slot-id mapping is the natural identity (`'left'` →
 * slot `'left'`, `'right'` → slot `'right'`). The PT-session skill drives
 * bilateral sessions with those exact slot ids; if a future surface adopts
 * different slot keys it should set bindings against the same physicalSide
 * names and let this mapping convert.
 */
function resolveConnectSlotId(
  state: ServerState,
  inputSlot: string | undefined,
  deviceId: string,
): string {
  if (inputSlot === undefined) return PRIMARY_SLOT;
  if (inputSlot !== AUTO_SLOT) return inputSlot;
  const binding = state.slotBindings.get(deviceId);
  if (binding === null) {
    throwSdkLike(
      'NO_PERSISTED_BINDING',
      `Device ${JSON.stringify(deviceId)} has no persisted side binding. Connect with an explicit slot (e.g. \`slot: 'left'\`), run the side-ID ritual, then slot.bind to save it for next time.`,
    );
  }
  return binding.physicalSide;
}

/**
 * F4+F8 (VMCP-01.19 / VMCP-01.24) — reap the bridge-minted guided-load
 * scaffold after `device.exit_guided_load`.
 *
 * Order: set first, then session. Channels see `set_ended` and the
 * (eventual) session-ended event as separate signals — the brief
 * forbids bundling them.
 *
 * Set reap: `finalizeSet` with `partialReason: 'guided_load_exited'`
 * and `disengageMotor: false`. The SDK already wrote the exit frame;
 * a redundant `Workout.STOP` would just churn state. We pass `cause:
 * 'tool'` because the call originated in a tool handler — channel
 * subscribers reading the cause field see this as a tool-driven close,
 * consistent with the explicit `set.end` shape.
 *
 * Session reap: only fires when the active session is tagged
 * `autoCreatedBy: 'guided_load'` AND no other set is in flight. The
 * F14 `dropTrailingInProgress` predicate is intentionally NOT extended
 * to `'guided_load_exited'` — guided load has no in-flight rep at exit
 * time, and any reps that landed during the demo should persist.
 *
 * Errors in the persist path are caught + logged; the BLE write has
 * already succeeded by the time we run, so a SQLite failure shouldn't
 * fail the tool call.
 */
async function reapGuidedLoadScaffold(state: ServerState, slotId: string): Promise<void> {
  const slot = getSlot(state, slotId);

  if (slot.live.set !== undefined) {
    try {
      await finalizeSet(state, slotId, {
        cause: 'tool',
        disengageMotor: false,
        partialReason: 'guided_load_exited',
      });
    } catch (err) {
      log.warn('device.exit_guided_load: set reap failed', err);
    }
  }

  const session = slot.live.session;
  if (
    session !== undefined &&
    session.autoCreatedBy === 'guided_load' &&
    slot.live.set === undefined
  ) {
    const finalizedSession = slot.live.endSession();
    if (finalizedSession !== undefined) {
      const stored: StoredSession = {
        id: finalizedSession.sessionId,
        startedAt: finalizedSession.startedAt,
        endedAt: new Date().toISOString(),
        ...(finalizedSession.exerciseId !== undefined
          ? { exerciseId: finalizedSession.exerciseId }
          : {}),
        ...(finalizedSession.exerciseName !== undefined
          ? { exerciseName: finalizedSession.exerciseName }
          : {}),
      };
      try {
        await state.store.putSession(stored);
      } catch (err) {
        log.warn('device.exit_guided_load: session reap persist failed', err);
      }
    }
  }
}

/**
 * Count slots whose client is actively connected. Mirrors the helper in
 * `state/server-state.ts` but lives at the device-tools layer too so the
 * `device.connect` precondition reads the same policy without crossing
 * the abstraction boundary into state internals.
 */
function countConnectedSlots(state: ServerState): number {
  let count = 0;
  for (const slot of state.slots.values()) {
    if (slot.client.isConnected) {
      count += 1;
    }
  }
  return count;
}

// ── device.send_raw helpers ──────────────────────────────────────────────

/**
 * Convert the dual-form `bytes` input (hex string OR integer array) to a
 * `Uint8Array`. The schema has already enforced range and pattern, so this
 * is a pure structural conversion — but we re-check the hex length parity
 * because the schema's regex allows any positive even or odd length.
 */
function bytesToUint8Array(input: string | number[]): Uint8Array {
  if (typeof input === 'string') {
    if (input.length % 2 !== 0) {
      throwSdkLike(
        'INVALID_INPUT',
        'bytes hex string must have an even number of characters (each byte is two hex chars).',
      );
    }
    const out = new Uint8Array(input.length / 2);
    for (let i = 0; i < input.length; i += 2) {
      const byte = Number.parseInt(input.slice(i, i + 2), 16);
      // The regex on the schema guarantees `byte` is a valid 0..255 number,
      // but a defensive check costs nothing and makes the conversion total.
      if (!Number.isFinite(byte) || byte < 0 || byte > 255) {
        throwSdkLike(
          'INVALID_INPUT',
          `Invalid hex byte at offset ${i}: "${input.slice(i, i + 2)}"`,
        );
      }
      out[i / 2] = byte;
    }
    return out;
  }
  // Array form — schema already bounds each element to 0..255.
  return Uint8Array.from(input);
}

const HEX_DIGITS = '0123456789abcdef';

/**
 * Encode a `Uint8Array` as a lowercase hex string. Implemented inline so we
 * never reach for `Buffer.toString('hex')` — keeps `device-tools.ts` free of
 * a Node-specific `Buffer` reference and gives the function a stable shape
 * across runtimes.
 */
function uint8ArrayToHex(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i];
    out += HEX_DIGITS[(b >> 4) & 0x0f];
    out += HEX_DIGITS[b & 0x0f];
  }
  return out;
}

/**
 * Adapter-agnostic shape we need for `device.send_raw` response collection.
 * Mirrors the public BLEAdapter surface but typed locally so this file does
 * not need to import the SDK's adapter types directly.
 */
interface RawWriteAdapter {
  write(data: Uint8Array): Promise<void>;
  onNotification(callback: (data: Uint8Array) => void): () => void;
}

/**
 * Subscribe to BLE notifications for `windowMs`, capture every frame as
 * hex, and resolve with the collected list when the window expires (or
 * immediately if the caller invokes `cancel()`). The subscription is
 * detached unconditionally inside the resolution path — even on cancel —
 * so a stale listener cannot outlive the window.
 *
 * `windowMs === 0` resolves on the next microtask with an empty list. We
 * still arm the listener briefly to give the BLE layer a chance to flush a
 * synchronous reply, but in practice 0ms is "don't wait".
 */
function collectResponses(
  adapter: RawWriteAdapter,
  windowMs: number,
): { done: Promise<Array<{ bytesHex: string; capturedAt: string }>>; cancel: () => void } {
  const captured: Array<{ bytesHex: string; capturedAt: string }> = [];
  const unsubscribe = adapter.onNotification((data) => {
    captured.push({
      bytesHex: uint8ArrayToHex(data),
      capturedAt: new Date().toISOString(),
    });
  });
  let settled = false;
  let resolveFn: (v: typeof captured) => void = () => {};
  const done = new Promise<typeof captured>((resolve) => {
    resolveFn = resolve;
  });
  const finalize = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    resolveFn(captured);
  };
  const timer = setTimeout(finalize, windowMs);
  // Allow process exit / test teardown to proceed without blocking on this
  // timer when the host doesn't wait for the response (defensive — the
  // tool always awaits `done`, but unref keeps shutdowns clean).
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
    timer.unref();
  }
  return {
    done,
    cancel: () => {
      clearTimeout(timer);
      finalize();
    },
  };
}

/**
 * Append a `send_raw` event to the diagnostic ring buffer. Centralised so
 * every exit path through the handler — success, mock rejection, write
 * failure — leaves the same shape of audit record.
 */
function recordSendRawEvent(
  capturedAt: number,
  payload: {
    slot: string;
    bytesWritten: number;
    bytesHex: string;
    expectResponse: boolean;
    outcome: 'ok' | 'mock_not_supported' | 'no_adapter' | 'not_connected' | 'write_failed';
    responsesCaptured?: number;
  },
): void {
  getDebugBuffers().events.push({
    capturedAt,
    type: 'send_raw',
    payload: { ...payload },
  });
}
