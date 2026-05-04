// Input schemas for `device.*` tools and the output shape for
// `device.get_state`.
//
// `SELECTABLE_MODE_NAMES` is derived from the SDK's `TrainingMode` enum at
// runtime so the set stays in lockstep with the SDK. The CI assertion below
// fails the build if the enum ever flips to numeric-only or otherwise breaks
// derivation. `Idle` is excluded because it is never user-selectable.
//
// RSSI is intentionally omitted from `DeviceGetStateOutput`. Per
// critic-report.md, `VoltraDeviceSettings` exposes no `rssi` field, and
// `VoltraClient` has no separate RSSI getter — the only RSSI source in the
// SDK lives on `DiscoveredDevice` (a transient scan result, not a connected
// device state). When the SDK adds a runtime RSSI getter, restore the
// optional field here and update the `device.get_state` handler.

import { TrainingMode } from '@voltras/node-sdk';
import { z } from 'zod';

/**
 * Selectable training-mode names derived from the SDK enum.
 * Excludes `Idle` (not user-selectable) and any numeric reverse-mapping keys.
 */
const SELECTABLE_MODE_NAMES = Object.keys(TrainingMode).filter(
  (k) => isNaN(Number(k)) && k !== 'Idle',
) as [string, ...string[]];

// CI assertion: TS-enum reverse mapping changes or empty derivation will fail
// the server boot before any tool dispatch. Keeps schemas honest about the SDK.
if (SELECTABLE_MODE_NAMES.length === 0) {
  throw new Error('TrainingMode derivation produced empty array');
}

/**
 * Input for `device.scan`. `timeoutMs` defaults to 10s with a 1s minimum so
 * a misconfigured client cannot tight-loop the BLE adapter.
 */
export const DeviceScanInput = z.object({
  timeoutMs: z.number().int().min(1000).default(10000).optional(),
});

/** Input for `device.set_weight` — pounds, integer, SDK clamps to device range. */
export const DeviceSetWeightInput = z.object({
  lbs: z.number().int().min(5).max(200),
});

/**
 * Input for `device.set_mode` — string name from the SDK's `TrainingMode`
 * enum. The handler maps the name back to the numeric enum value before
 * calling `client.setMode()`.
 */
export const DeviceSetModeInput = z.object({
  mode: z.enum(SELECTABLE_MODE_NAMES),
});

/**
 * Output shape for `device.get_state`. The handler composes this from
 * individual `VoltraClient` getters — the SDK has no `getState()` method.
 *
 * `rssi` is omitted (see file header). When restored, it must come from a
 * verified SDK source, not from `client.settings`.
 */
export const DeviceGetStateOutput = z.object({
  connected: z.boolean(),
  connectionState: z.string(),
  deviceId: z.string().optional(),
  weightLbs: z.number().optional(),
  trainingMode: z.string().optional(),
  batteryPercent: z.number().optional(),
});
