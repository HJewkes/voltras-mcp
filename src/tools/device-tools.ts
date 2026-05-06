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
// `manager.scan` accepts `ScanOptions` (`{ timeout?: number; ... }`). The
// critic FIX #9 wording said "wrap in `{ timeoutMs }`" — that property name
// is a typo against the actual SDK type. We accept `timeoutMs` on the input
// schema (per spec R11) and forward it as the SDK's `timeout` field.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TrainingMode } from '@voltras/node-sdk';
import { z } from 'zod';

import { DeviceScanInput, DeviceSetWeightInput, DeviceSetModeInput } from '../schemas/device.js';
import { SlotIdSchema } from '../schemas/common.js';
import { type ServerState, PRIMARY_SLOT, MAX_SLOTS, getSlot } from '../state/server-state.js';
import { createSlot, removeSlot, resetPrimarySlot } from '../state/slot-manager.js';
import { wireBridgeForSlot } from '../state/event-bridge.js';
import { wrapHandler, type ToolResult } from './helpers.js';

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
  reg.update({ paramsSchema: schema.shape, callback: handler as never });
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
  // a `ScanOptions` object so the SDK is never called with a bare number
  // (critic FIX #9). Returns the discovered devices straight through.
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
      if (wasConnected) {
        await state.manager.disconnect(id);
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

  // device.get_state — composes the response from the four documented
  // getters (AC-26). Numeric `mode` is converted to its enum NAME via the
  // SDK's reverse mapping; an unknown value falls through as undefined.
  // `battery: null` from the SDK collapses to absent (FIX #6). RSSI is
  // omitted because the SDK has no RSSI getter on a connected client.
  install(
    placeholders,
    'device.get_state',
    DeviceGetStateInput,
    wrapHandler(DeviceGetStateInput, async (input) => {
      const slot = getSlot(state, input.slot);
      const isConnected = slot.client.isConnected;
      const connectionState = slot.client.connectionState;
      const deviceId = slot.client.connectedDeviceId;
      const settings = slot.client.settings;
      const out: Record<string, unknown> = {
        connected: isConnected,
        connectionState,
      };
      if (deviceId !== null && deviceId !== undefined) {
        out.deviceId = deviceId;
      }
      if (settings) {
        if (typeof settings.weight === 'number') {
          out.weightLbs = settings.weight;
        }
        if (typeof settings.mode === 'number') {
          const name = (TrainingMode as unknown as Record<number, string>)[settings.mode];
          if (typeof name === 'string') {
            out.trainingMode = name;
          }
        }
        if (settings.battery !== null && settings.battery !== undefined) {
          out.batteryPercent = settings.battery;
        }
      }
      return out;
    }),
  );
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
