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

import { SlotIdSchema } from './common.js';

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
  slot: SlotIdSchema,
});

/**
 * Input for `device.set_mode` — string name from the SDK's `TrainingMode`
 * enum. The handler maps the name back to the numeric enum value before
 * calling `client.setMode()`.
 */
export const DeviceSetModeInput = z.object({
  mode: z.enum(SELECTABLE_MODE_NAMES),
  slot: SlotIdSchema,
});

// ── SDK 0.6.0 mode-config setters (validated on-device 2026-05-06) ────────
//
// MCP-side schemas keep numeric ranges intentionally permissive — the SDK's
// command-builder rejects out-of-band values with `InvalidSettingError`,
// and that rejection is the authoritative range gate. MCP just sanity-bounds
// the input so an obviously bogus value doesn't reach the BLE write path.
// String-union setters are exhaustive at the schema layer (no SDK round-trip
// needed to enumerate valid values).

/** Input for `device.set_damper_level` — int 0..9 (UI shows N+1 ⇒ 1..10). */
export const DeviceSetDamperLevelInput = z.object({
  level: z.number().int().min(0).max(9),
  slot: SlotIdSchema,
});

/** Input for `device.set_assist_mode` — toggle on/off. */
export const DeviceSetAssistModeInput = z.object({
  mode: z.enum(['off', 'on']),
  slot: SlotIdSchema,
});

/** Input for `device.set_band_max_force` — pounds; SDK valid range 15..70. */
export const DeviceSetBandMaxForceInput = z.object({
  lbs: z.number().int().min(0).max(100),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_target_speed` — mm/s; SDK requires step-of-10. */
export const DeviceSetIsokineticTargetSpeedInput = z.object({
  mmPerSec: z.number().int().min(0).max(2000),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_ecc_mode` — eccentric mode for isokinetic. */
export const DeviceSetIsokineticEccModeInput = z.object({
  mode: z.enum(['isokinetic', 'constant']),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_ecc_speed_limit` — mm/s; 0 = auto. */
export const DeviceSetIsokineticEccSpeedLimitInput = z.object({
  mmPerSec: z.number().int().min(0).max(2000),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_ecc_const_weight` — pounds. Device beeps. */
export const DeviceSetIsokineticEccConstWeightInput = z.object({
  lbs: z.number().int().min(0).max(200),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_ecc_overload_weight` — pounds. Device beeps. */
export const DeviceSetIsokineticEccOverloadWeightInput = z.object({
  lbs: z.number().int().min(0).max(200),
  slot: SlotIdSchema,
});

// <Bug-22> Rowing two-stage entry — replaces set_mode(Rowing).
/** Input for `device.enter_row_mode` — opens the rowing sub-menu. */
export const DeviceEnterRowModeInput = z.object({
  slot: SlotIdSchema,
});

/**
 * Distance-preset names accepted by `device.start_row`. The wire-byte
 * mapping lives in `@voltras/node-sdk`; the SDK's `RowingDistancePreset`
 * type is the source of truth. Re-declared here as a literal because
 * importing a type union as a runtime value isn't possible — when adding
 * presets, update both lists.
 *
 * Only `JustRow` and `M50` are independently verified against iPad
 * sysdiagnose; the 100/500/1000/2000/5000 m codes are inferred and
 * pending on-device validation.
 */
export const ROWING_DISTANCE_PRESETS = [
  'JustRow',
  'M50',
  'M100',
  'M500',
  'M1000',
  'M2000',
  'M5000',
] as const;

/** Input for `device.start_row` — commits the rowing session. */
export const DeviceStartRowInput = z.object({
  distance: z.enum(ROWING_DISTANCE_PRESETS).optional(),
  slot: SlotIdSchema,
});
// </Bug-22>

/**
 * Input for `device.start_guided_load` (Phase 1g, @experimental).
 *
 * Triggers the firmware direct-load (`0xAA 0x12`) flow at the supplied
 * target weight. The SDK polls the 4 status registers every 500ms for
 * 18 seconds post-trigger; both intervals are overridable for diagnostics
 * but rarely need adjustment. `targetWeightLbs` reuses the SDK's standard
 * BP_BASE_WEIGHT range (5..200).
 */
export const DeviceStartGuidedLoadInput = z.object({
  targetWeightLbs: z.number().int().min(5).max(200),
  pollIntervalMs: z.number().int().min(100).max(2000).optional(),
  pollDurationMs: z.number().int().min(1000).max(60000).optional(),
  slot: SlotIdSchema,
});

// ── device.send_raw (diagnostic-only) ─────────────────────────────────────
//
// DIAGNOSTIC tool — writes arbitrary bytes to the device's BLE write
// characteristic via `client.getAdapter().write(...)`. The MCP layer is
// intentionally a generic byte-pipe: it does NOT validate against known
// opcodes or "safe" patterns. The caller (typically a human running an
// on-device validation campaign) owns byte semantics.
//
// `confirm: true` is required to invoke. The literal-true gate forces a
// caller to acknowledge that this is a diagnostic write that can put the
// device in unexpected state.
//
// The window for `expectResponse` is bounded to keep the call latency
// predictable; 500ms matches the device's typical settings-update echo
// cadence under steady-state load.

const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const MAX_RAW_BYTES = 244; // ATT_MTU upper bound on a single BLE write.
const RESPONSE_WINDOW_MIN_MS = 0;
const RESPONSE_WINDOW_MAX_MS = 5_000;
const RESPONSE_WINDOW_DEFAULT_MS = 500;

/**
 * Input for `device.send_raw`.
 *
 * `bytes` accepts either a hex string (`"AA811001020304"`) or an array of
 * integers in 0–255. The handler converts to `Uint8Array` internally and
 * rejects out-of-range values or odd-length hex with `INVALID_INPUT`.
 *
 * `confirm` MUST be the literal `true`. This is intentional friction: the
 * tool is a generic BLE write-pipe with no opcode validation, so the caller
 * has to acknowledge each invocation.
 */
export const DeviceSendRawInput = z.object({
  bytes: z.union([
    z
      .string()
      .min(2)
      .max(MAX_RAW_BYTES * 2)
      .regex(HEX_PATTERN, 'bytes hex string must contain only [0-9a-fA-F]'),
    z.array(z.number().int().min(0).max(255)).min(1).max(MAX_RAW_BYTES),
  ]),
  expectResponse: z.boolean().optional().default(false),
  responseWindowMs: z
    .number()
    .int()
    .min(RESPONSE_WINDOW_MIN_MS)
    .max(RESPONSE_WINDOW_MAX_MS)
    .optional()
    .default(RESPONSE_WINDOW_DEFAULT_MS),
  confirm: z.literal(true, {
    message:
      'device.send_raw requires `confirm: true` — diagnostic write to BLE; caller acknowledges device-state risk.',
  }),
  slot: SlotIdSchema,
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
  damperLevel: z.number().int().min(0).max(9).optional(),
  isRowingActive: z.boolean().optional(),
  /**
   * Raw assist-mode value from the last cmd=0x07 state-dump. 0 = off, 2 = on,
   * 8 = device idle sentinel. Absent until the first state-dump has fired.
   */
  assistMode: z.number().int().optional(),
  /** Chains-active count (0..7) from the last state-dump. Absent until first state-dump. */
  chainsActive: z.number().int().min(0).max(7).optional(),
  /**
   * Raw u16 at bytes [6-7] of the cmd=0x07 inner `aa 80 25` envelope, in
   * tenths of pounds.
   *
   * **WARNING — decoder bug:** on-device testing 2026-05-07 (Bug 23
   * retest) showed bytes [6-7] track `weight × 10`, NOT chain force at the
   * cable (the actual effective force is at bytes [8-9]). Field is
   * preserved for back-compat; consumers should treat it as unreliable
   * until the cmd=0x07 layout-discriminator fix lands (Option C in
   * `voltra-private/research/HANDOFF-2026-05-08-post-0.7.2-followups.md`).
   *
   * Prefer `chainSettingLbs` for the user's chains setting in lbs.
   *
   * @deprecated Decoder reads the wrong byte offset; use `chainSettingLbs`.
   */
  chainTargetTenths: z.number().int().min(0).optional(),
  /**
   * User's chains setting in pounds, sourced from the cmd=0x10 cascade
   * `chains` field on `onSettingsUpdate`. This is the value the firmware
   * accepted after its silent chains≤weight cap (a `set_chains(60)` write
   * against `weightLbs=50` surfaces here as 50). On-device testing
   * 2026-05-07 confirmed this is reliable. Absent until the first cmd=0x10
   * cascade carrying the `chains` field has fired.
   */
  chainSettingLbs: z.number().min(0).optional(),
});
