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
// All BLE interaction flows through `state.manager` and `state.client` —
// AC-14 forbids any direct BLE-adapter library references from this file.
//
// ── Connection model ──────────────────────────────────────────────────────
//
// `device.connect` uses `state.manager.connect(device)` (the SDK's idiomatic
// connection entry point). The manager creates an internal `VoltraClient`
// for each connected device — distinct from the parameter-less
// `state.client` allocated in `bootstrapState`. AC-26 specifies that
// `device.get_state` reads from `state.client.*` getters, and Wave 2's
// event-bridge subscribes to `state.client`. Reconciling the two clients
// (e.g., proxying manager events through `state.client`, or replacing
// `state.client` after connect with bridge re-wiring) is a Wave 4 concern;
// this module satisfies the AC-26 contract by reading exactly the documented
// getters and lets Wave 4 decide how `state.client` becomes connected.
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
import type { ServerState } from '../state/server-state.js';
import { wrapHandler, type ToolResult } from './helpers.js';

// Locally-scoped extra schemas — kept here rather than in `src/schemas/device.ts`
// to honor Task 10's file-ownership boundary (we may not modify Wave 1
// schemas). Each shape is small and tool-local; once Task 03 picks them up
// they can be moved.
const DeviceConnectInput = z.object({
  deviceId: z.string().min(1),
});

const DeviceDisconnectInput = z.object({}).strict();

const DeviceSetChainsInput = z.object({
  lbs: z.number().int().min(0).max(100),
});

const DeviceSetEccentricInput = z.object({
  percent: z.number().int().min(-195).max(195),
});

const DeviceGetStateInput = z.object({}).strict();

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
function install(
  placeholders: Placeholders,
  name: string,
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
  reg.update({ callback: handler });
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
    wrapHandler(DeviceScanInput, async (input) => {
      const timeout = input.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
      const devices = await state.manager.scan({ timeout });
      return { devices };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.connect — looks up the previously-discovered device by id and
  // hands it to `manager.connect`. `ALREADY_CONNECTED` short-circuits when
  // `state.client` reports a live connection (EC-08).
  install(
    placeholders,
    'device.connect',
    wrapHandler(DeviceConnectInput, async (input) => {
      if (state.client.isConnected) {
        throwSdkLike('ALREADY_CONNECTED', 'A device is already connected.');
      }
      const device = state.manager.devices.find((d) => d.id === input.deviceId);
      if (device === undefined) {
        throwSdkLike(
          'DEVICE_NOT_FOUND',
          `No device with id ${JSON.stringify(input.deviceId)} in the last scan.`,
        );
      }
      await state.manager.connect(device);
      return { ok: true, deviceId: input.deviceId };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.disconnect — graceful no-op when nothing is connected, otherwise
  // routes through `manager.disconnect(deviceId)` (the SDK manages adapter
  // teardown). Does not call `manager.dispose()` — that would tear down the
  // shared adapter for every connection (and for future scans).
  install(
    placeholders,
    'device.disconnect',
    wrapHandler(DeviceDisconnectInput, async () => {
      const id = state.client.connectedDeviceId;
      if (state.client.isConnected && id !== null) {
        await state.manager.disconnect(id);
      }
      return { ok: true };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.set_weight — direct passthrough to the SDK; the schema clamps
  // input to the device-allowed range so the SDK never sees out-of-band lbs.
  install(
    placeholders,
    'device.set_weight',
    wrapHandler(DeviceSetWeightInput, async (input) => {
      await state.client.setWeight(input.lbs);
      return { ok: true };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.set_mode — input is the enum NAME; map back to the SDK numeric
  // value before calling. `Idle` is excluded by the schema (EC-05), so by
  // the time we reach the body the lookup is guaranteed to land on a
  // valid `TrainingMode` member.
  install(
    placeholders,
    'device.set_mode',
    wrapHandler(DeviceSetModeInput, async (input) => {
      const value = (TrainingMode as unknown as Record<string, number>)[input.mode];
      await state.client.setMode(value as TrainingMode);
      return { ok: true };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.set_chains — passthrough; schema enforces 0–100 lbs.
  install(
    placeholders,
    'device.set_chains',
    wrapHandler(DeviceSetChainsInput, async (input) => {
      await state.client.setChains(input.lbs);
      return { ok: true };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.set_eccentric — passthrough; schema enforces -195..+195 percent.
  install(
    placeholders,
    'device.set_eccentric',
    wrapHandler(DeviceSetEccentricInput, async (input) => {
      await state.client.setEccentric(input.percent);
      return { ok: true };
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
  );

  // device.get_state — composes the response from the four documented
  // getters (AC-26). Numeric `mode` is converted to its enum NAME via the
  // SDK's reverse mapping; an unknown value falls through as undefined.
  // `battery: null` from the SDK collapses to absent (FIX #6). RSSI is
  // omitted because the SDK has no RSSI getter on a connected client.
  install(
    placeholders,
    'device.get_state',
    wrapHandler(DeviceGetStateInput, async () => {
      const isConnected = state.client.isConnected;
      const connectionState = state.client.connectionState;
      const deviceId = state.client.connectedDeviceId;
      const settings = state.client.settings;
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
    }) as unknown as Parameters<RegisteredTool['update']>[0]['callback'] extends infer C
      ? C extends (...a: never[]) => unknown
        ? (args: unknown, extra?: unknown) => Promise<ToolResult>
        : never
      : never,
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
