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
import { WatchConfig } from './set.js';

/**
 * Selectable training-mode names derived from the SDK enum.
 * Excludes `Idle` (not user-selectable) and any numeric reverse-mapping keys.
 */
export const SELECTABLE_MODE_NAMES = Object.keys(TrainingMode).filter(
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
// The SDK's command-builder is the authoritative gate: it maps each numeric
// setting through a discrete lookup table and throws `InvalidSettingError`
// for any value it can't resolve. Where the SDK's valid set is a simple
// contiguous range (e.g. weights, damper) the MCP schema stays lightly
// permissive and lets the SDK reject the edges. Where the SDK's valid set is
// narrower or stepped than a naive integer range — band max force (15..70),
// isokinetic speeds (0..2000 step 10) — the schema mirrors that exact
// contract so an off-range or off-step value fails fast at the tool boundary
// with a clear INVALID_INPUT instead of a late BLE-path SDK error. These
// bounds are derived from the SDK's own `getAvailable*` tables (verified
// on-device 2026-05-06); tighten only where the device genuinely rejects.
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

/**
 * Input for `device.set_band_max_force` — pounds. The SDK's valid set is every
 * integer 15..70 (`getAvailableBandMaxForce()`); the schema enforces that exact
 * range so sub-15 / above-70 values fail fast here rather than in the BLE path.
 */
export const DeviceSetBandMaxForceInput = z.object({
  lbs: z.number().int().min(15).max(70),
  slot: SlotIdSchema,
});

/**
 * Input for `device.set_isokinetic_target_speed` — mm/s. The SDK's valid set is
 * 0..2000 in steps of 10 (`getAvailableIsokineticTargetSpeeds()`); `.multipleOf(10)`
 * rejects off-step values (e.g. 1505) at the tool boundary. 0 is a valid multiple.
 */
export const DeviceSetIsokineticTargetSpeedInput = z.object({
  mmPerSec: z.number().int().min(0).max(2000).multipleOf(10),
  slot: SlotIdSchema,
});

/** Input for `device.set_isokinetic_ecc_mode` — eccentric mode for isokinetic. */
export const DeviceSetIsokineticEccModeInput = z.object({
  mode: z.enum(['isokinetic', 'constant']),
  slot: SlotIdSchema,
});

/**
 * Input for `device.set_isokinetic_ecc_speed_limit` — mm/s; 0 = auto. Same
 * discrete set as target speed: 0..2000 step 10
 * (`getAvailableIsokineticEccSpeedLimits()`). `.multipleOf(10)` rejects off-step
 * values at the tool boundary; 0 (auto) is a valid multiple.
 */
export const DeviceSetIsokineticEccSpeedLimitInput = z.object({
  mmPerSec: z.number().int().min(0).max(2000).multipleOf(10),
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

/**
 * Input for `device.configure_isokinetic` (VMCP-02.16) — sets the whole
 * isokinetic mode in one call, replacing the four individual setters.
 *
 * `targetSpeedMmPerSec` and `eccMode` are required; the three eccentric
 * tuning fields are optional and only written when supplied. `eccConstWeightLbs`
 * pairs with `eccMode: 'constant'`, `eccOverloadWeightLbs` with the overload
 * variant — both are accepted so a caller can stage either configuration, but
 * only the field the firmware reads for the selected mode takes effect.
 * Ranges and units match the per-field setters exactly (mm/s for speeds,
 * step-of-10; pounds for weights).
 */
export const DeviceConfigureIsokineticInput = z.object({
  targetSpeedMmPerSec: z.number().int().min(0).max(2000).multipleOf(10),
  eccMode: z.enum(['isokinetic', 'constant']),
  eccConstWeightLbs: z.number().int().min(0).max(200).optional(),
  eccOverloadWeightLbs: z.number().int().min(0).max(200).optional(),
  eccSpeedLimitMmPerSec: z.number().int().min(0).max(2000).multipleOf(10).optional(),
  slot: SlotIdSchema,
});

// <Bug-22> Rowing two-stage entry — replaces set_mode(Rowing).
/** Input for `device.enter_row_mode` — opens the rowing sub-menu. */
export const DeviceEnterRowModeInput = z.object({
  slot: SlotIdSchema,
});

/**
 * Distance-preset names accepted by `device.start_row`. The SDK owns the
 * mapping; its `RowingDistancePreset` type is the source of truth.
 * Re-declared here as a literal because importing a type union as a runtime
 * value isn't possible — when adding presets, update both lists.
 *
 * Only `JustRow` and `M50` are independently verified against a real unit.
 * Every longer preset is inferred and pending on-device validation.
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
 * Triggers the firmware direct-load flow at the supplied target weight. The
 * SDK polls device status every 500ms for 18 seconds post-trigger; both
 * intervals are overridable for diagnostics but rarely need adjustment.
 * `targetWeightLbs` reuses the SDK's standard base-weight range (5..200).
 *
 * `inactivityTimeoutSeconds` (VMCP-02.15) — the inactivity watchdog
 * threshold for the AUTO-CREATED set the bridge mints on `armed`.
 * Defaults to 30s: guided-load auto-sets are speculative, and a failed
 * engagement should reap quickly rather than leave a zombie set sitting
 * for ~90s (the bridge's normal safety net) or 120s+ (the value used in
 * 2026-05-12 captures). Manual `set.start` callers control their own
 * inactivity via `watch.inactivityTimeoutMs` and are unaffected. Range
 * matches `WatchConfig.inactivityTimeoutMs`: 1..600s.
 */
export const DeviceStartGuidedLoadInput = z.object({
  targetWeightLbs: z.number().int().min(5).max(200),
  pollIntervalMs: z.number().int().min(100).max(2000).optional(),
  pollDurationMs: z.number().int().min(1000).max(60000).optional(),
  inactivityTimeoutSeconds: z.number().int().min(1).max(600).optional(),
  /**
   * Skip the auto-unload that precedes the direct-load trigger (VMCP-02.06).
   * Default `false` — the tool auto-invokes the unload primitive because the
   * firmware ceremony requires a mechanically-unloaded cable. Set to `true`
   * for diagnostic flows that need to reproduce the no-unload short-circuit.
   */
  skipUnload: z.boolean().optional(),
  /**
   * Switch the device into Weight Training as part of engaging guided load
   * (VMCP-02.90). Default `false`: guided load only enters from Weight
   * Training, and from any other selectable mode the tool refuses with
   * `GUIDED_LOAD_MODE_MISMATCH` rather than change a mode the lifter chose on
   * the unit. Set to `true` to have the tool make the switch, wait for the
   * device to echo it, and then proceed; an echo that never lands fails with
   * `MODE_ECHO_TIMEOUT` and no trigger is written.
   */
  autoSwitchMode: z.boolean().optional(),
  /**
   * Exercise identity for the session the bridge auto-creates on `armed`
   * (VMCP-02.13). When supplied — and no session is already active on the
   * slot — the auto-session inherits this name/id instead of the generic
   * `'Guided Load (auto)'`, so the set is filterable by exercise post-hoc.
   * Ignored when an explicit `session.start` is already active (that session
   * is reused as-is). `exerciseId` without `exerciseName` is allowed but the
   * name is what analytics surfaces.
   */
  exerciseName: z.string().min(1).max(120).optional(),
  exerciseId: z.string().min(1).max(120).optional(),
  /**
   * Set-level intent for the set the bridge auto-creates on `armed`
   * (VW-168a). Same shape and meaning as `set.start`'s own options: the set
   * exists before any `set.start` can be made, so without these a guided-load
   * warm-up could not be flagged as one and a guided-load set could not carry
   * a watch at all. Ignored when a set is already recording on the slot.
   */
  isWarmup: z.boolean().optional(),
  watch: WatchConfig.optional(),
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
 * `bytes` accepts either an even-length hex string or an array of integers in
 * 0–255. The handler converts to `Uint8Array` internally and rejects
 * out-of-range values or odd-length hex with `INVALID_INPUT`.
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
 * Input for `device.set_passive_scan` (VMCP-02.19). Toggles the
 * background BLE scanner that emits `voltras_available` channel events
 * when newly-seen Voltras appear. Default is OFF on server start.
 *
 * `intervalSeconds` is the cadence between scans (clamped to 5-600s).
 * Omitting it on enable preserves the prior cadence (default 30s on a
 * fresh server). Each scan window is ~5s and is automatically SKIPPED
 * if any slot is currently connected (BLE conflict avoidance).
 */
export const DeviceSetPassiveScanInput = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(5).max(600).optional(),
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
   * Assist-mode value in the device's own encoding, reported uninterpreted
   * from its periodic state report. Absent until the first report has fired.
   */
  assistMode: z.number().int().optional(),
  /**
   * Active training mode in the device's own encoding, from its periodic
   * state report. The bridge drops transitional reports, so this field never
   * appears as 0 in the tool output. Distinct from `trainingMode` above,
   * which is the interpreted mode name taken off the settings-update echo and
   * is what a caller should read. Absent until the first stable report.
   */
  trainingModeRaw: z.number().int().min(0).optional(),
  /**
   * Effective chain target force at the cable in tenths of pounds, off the
   * device's periodic state report. Equals `min(chains, weight) × 10` — the
   * device caps chains at weight. For the user's chains setting in lbs prefer
   * `chainSettingLbs`.
   */
  chainTargetForceTenths: z.number().int().min(0).optional(),
  /**
   * Active weight setting in tenths of pounds, off the device's periodic
   * state report (mirrors `baseWeight × 10`). Zero in non-WeightTraining
   * modes.
   */
  weightLbsTenths: z.number().int().min(0).optional(),
  /**
   * Eccentric overload setting in tenths of percent, off the device's
   * periodic state report (mirrors `eccentric × 10`).
   */
  eccentricPercentTenths: z.number().int().min(0).optional(),
  /**
   * User's chains setting in pounds, from the `chains` field on the
   * settings-update echo (`onSettingsUpdate`). This is the value the firmware
   * accepted after its silent chains≤weight cap (a `set_chains(60)` write
   * against `weightLbs=50` surfaces here as 50). On-device testing
   * 2026-05-07 confirmed this is reliable. Absent until the first echo
   * carrying the `chains` field has fired.
   */
  chainSettingLbs: z.number().min(0).optional(),
});
