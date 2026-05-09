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
import { TrainingMode } from '@voltras/node-sdk';
import { z } from 'zod';

import {
  DeviceScanInput,
  DeviceSendRawInput,
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
  DeviceStartGuidedLoadInput,
  // <Bug-22>
  DeviceEnterRowModeInput,
  DeviceStartRowInput,
  // </Bug-22>
} from '../schemas/device.js';
import { SlotIdSchema } from '../schemas/common.js';
import { type ServerState, PRIMARY_SLOT, MAX_SLOTS, getSlot } from '../state/server-state.js';
import type { DeviceSnapshot } from '../state/live-state.js';
import { createSlot, removeSlot, resetPrimarySlot } from '../state/slot-manager.js';
import { wireBridgeForSlot } from '../state/event-bridge.js';
import { getDebugBuffers } from '../state/debug-buffer.js';
import { wrapHandler, type ToolResult } from './helpers.js';
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
const DeviceConnectInput = z.object({
  deviceId: z.string().min(1),
  slot: SlotIdSchema,
});

const DeviceDisconnectInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

const DeviceSetChainsInput = z.object({
  lbs: z.number().int().min(0).max(100),
  slot: SlotIdSchema,
});

const DeviceSetEccentricInput = z.object({
  percent: z.number().int().min(-195).max(195),
  slot: SlotIdSchema,
});

const DeviceGetStateInput = z
  .object({
    slot: SlotIdSchema,
  })
  .strict();

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

const ISOKINETIC_TARGET_SPEED_DESCRIPTION =
  'Set the isokinetic target speed (0-2000 mm/s, step 10). Input is millimeters/second; the device UI displays the value in meters/second (input ÷ 1000). Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_MODE_DESCRIPTION =
  'Set the isokinetic eccentric mode ("isokinetic" or "constant"). Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_SPEED_LIMIT_DESCRIPTION =
  'Set the isokinetic eccentric speed limit (0-2000 mm/s, step 10). 0 = auto. Settings persist globally across mode switches; no modeConfirmation is emitted by the device. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_CONST_WEIGHT_DESCRIPTION =
  'Set the isokinetic eccentric constant weight (0-200 lbs). Pounds. Note: the device emits an audible beep when this is set on a connected device — possibly a safety/range cue from the firmware; the command itself succeeds. Settings persist globally across mode switches. Validated on-device 2026-05-06.';

const ISOKINETIC_ECC_OVERLOAD_WEIGHT_DESCRIPTION =
  'Set the isokinetic eccentric overload weight (0-200 lbs). Pounds. Note: the device emits an audible beep when this is set on a connected device — possibly a safety/range cue from the firmware; the command itself succeeds. Settings persist globally across mode switches. Validated on-device 2026-05-06.';

const START_GUIDED_LOAD_DESCRIPTION =
  '@experimental — Trigger the firmware "direct-load" flow at the supplied target weight (5-200 lbs). The SDK writes BP_BASE_WEIGHT, sends the AA12 trigger, and polls the 4 status registers every 500ms for 18s post-trigger; transitions (armed → countdown → engaging → active) are surfaced via the bridge. The bridge also auto-creates a session+set on entry so subsequent rep_boundary / set_boundary frames are properly attributed (closes Bugs 28/29). Polling intervals can be overridden for diagnostics but rarely need adjustment.';

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
      const slotId = input.slot ?? PRIMARY_SLOT;
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
      return { ok: true, deviceId: input.deviceId };
    }),
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
      // Belt-and-suspenders: force-close the adapter even if `manager.disconnect`
      // succeeded silently against a partial-disconnect path (W3C
      // `device.gatt.disconnect()` is fire-and-forget; SimpleBLE handle map
      // can leak). If the adapter is already torn down this is a no-op.
      if (adapterRef !== null) {
        try {
          await adapterRef.disconnect();
        } catch {
          // Adapter teardown failures are non-fatal — the JS handles are
          // already nulled by `cleanup()` paths and the writeChar is gone.
        }
      }
      // Idempotent: dispose returns early if already disposed (e.g., by
      // `manager.disconnect`'s internal call). This catches the case where
      // the slot's client is held outside the manager.clients map (e.g.,
      // primary's bootstrap stub), or where `manager.disconnect` short-
      // circuited because the deviceId wasn't registered.
      try {
        slot.client.dispose();
      } catch {
        // Defensive — dispose is documented as idempotent and shouldn't
        // throw, but we don't want a slot teardown to fail the tool.
      }
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
  install(
    placeholders,
    'device.set_weight',
    DeviceSetWeightInput,
    wrapHandler(DeviceSetWeightInput, async (input) => {
      await getSlot(state, input.slot).client.setWeight(input.lbs);
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

  // device.set_chains — passthrough; schema enforces 0–100 lbs.
  install(
    placeholders,
    'device.set_chains',
    DeviceSetChainsInput,
    wrapHandler(DeviceSetChainsInput, async (input) => {
      await getSlot(state, input.slot).client.setChains(input.lbs);
      return { ok: true };
    }),
  );

  // device.set_eccentric — passthrough; schema enforces -195..+195 percent.
  install(
    placeholders,
    'device.set_eccentric',
    DeviceSetEccentricInput,
    wrapHandler(DeviceSetEccentricInput, async (input) => {
      await getSlot(state, input.slot).client.setEccentric(input.percent);
      return { ok: true };
    }),
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
      await getSlot(state, input.slot).client.setDamperLevel(input.level);
      return { ok: true };
    }),
    DAMPER_LEVEL_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_assist_mode',
    DeviceSetAssistModeInput,
    wrapHandler(DeviceSetAssistModeInput, async (input) => {
      await getSlot(state, input.slot).client.setAssistMode(input.mode);
      return { ok: true };
    }),
    ASSIST_MODE_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_band_max_force',
    DeviceSetBandMaxForceInput,
    wrapHandler(DeviceSetBandMaxForceInput, async (input) => {
      await getSlot(state, input.slot).client.setBandMaxForce(input.lbs);
      return { ok: true };
    }),
    BAND_MAX_FORCE_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_target_speed',
    DeviceSetIsokineticTargetSpeedInput,
    wrapHandler(DeviceSetIsokineticTargetSpeedInput, async (input) => {
      await getSlot(state, input.slot).client.setIsokineticTargetSpeed(input.mmPerSec);
      return { ok: true };
    }),
    ISOKINETIC_TARGET_SPEED_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_mode',
    DeviceSetIsokineticEccModeInput,
    wrapHandler(DeviceSetIsokineticEccModeInput, async (input) => {
      await getSlot(state, input.slot).client.setIsokineticEccMode(input.mode);
      return { ok: true };
    }),
    ISOKINETIC_ECC_MODE_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_speed_limit',
    DeviceSetIsokineticEccSpeedLimitInput,
    wrapHandler(DeviceSetIsokineticEccSpeedLimitInput, async (input) => {
      await getSlot(state, input.slot).client.setIsokineticEccSpeedLimit(input.mmPerSec);
      return { ok: true };
    }),
    ISOKINETIC_ECC_SPEED_LIMIT_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_const_weight',
    DeviceSetIsokineticEccConstWeightInput,
    wrapHandler(DeviceSetIsokineticEccConstWeightInput, async (input) => {
      await getSlot(state, input.slot).client.setIsokineticEccConstWeight(input.lbs);
      return { ok: true };
    }),
    ISOKINETIC_ECC_CONST_WEIGHT_DESCRIPTION,
  );

  install(
    placeholders,
    'device.set_isokinetic_ecc_overload_weight',
    DeviceSetIsokineticEccOverloadWeightInput,
    wrapHandler(DeviceSetIsokineticEccOverloadWeightInput, async (input) => {
      await getSlot(state, input.slot).client.setIsokineticEccOverloadWeight(input.lbs);
      return { ok: true };
    }),
    ISOKINETIC_ECC_OVERLOAD_WEIGHT_DESCRIPTION,
  );

  // device.start_guided_load (Phase 1g, @experimental) — wraps the SDK's
  // `startGuidedLoad`. Resolves once the trigger frame has been written and
  // the SDK's polling loop is armed; downstream phase transitions surface
  // through the event-bridge's `guided_load_state` debug events plus the
  // auto-created session/set context (closes Bugs 28/29).
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
      await getSlot(state, input.slot).client.startGuidedLoad(opts);
      return { ok: true };
    }),
    START_GUIDED_LOAD_DESCRIPTION,
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
      return buildDeviceGetStateResponse(
        slot.client.isConnected,
        slot.client.connectionState,
        slot.client.isRowingActive,
        slot.live.snapshotDevice(),
      );
    }),
  );
}

/**
 * Compose the `device.get_state` tool response from a preserved
 * `DeviceSnapshot` plus three transient client-only fields. Mirrors the
 * field shape of `voltra://device/{slot}/current` so callers get identical
 * preserved-state values across both surfaces during the disconnect window
 * (deviceId, weightLbs, trainingMode, damperLevel, chainSettingLbs, plus
 * the cmd=0x07 state-dump fields). Tool-only additions: `connectionState`
 * and `isRowingActive` (both transient, not preserved).
 */
function buildDeviceGetStateResponse(
  isConnected: boolean,
  connectionState: string,
  isRowingActive: boolean,
  device: DeviceSnapshot,
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
  out.isRowingActive = isRowingActive;
  return out;
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
