// VMCP-02.09 — applied-mode name mapping.
//
// `DeviceSnapshot.trainingMode` is the *requested* mode (cmd=0x10 cascade
// echo, the user's intent). `DeviceSnapshot.trainingModeRaw` is the *applied*
// mode byte from the cmd=0x07 state-dump (what the device is actually doing).
// They diverge — see [[separate-user-setting-from-applied-state]]. This helper
// maps the applied byte to a name so every surface can report `active_mode`
// alongside `requested_mode` instead of leaking a raw integer.
//
// Hardware-verification gate: the cmd=0x07 byte values are only confirmed on
// hardware for `0` (transitional / mid-mode-switch), `1` (WeightTraining), and
// `2` (ResistanceBand) — see `live-state.ts` `trainingModeRaw`. The SDK casts
// the byte to the full `TrainingMode` enum, but the encodings for Isokinetic /
// Rowing / Damper / Isometric are NOT yet confirmed. Rather than guess a name
// for an unconfirmed byte, we render it as `unverified(<n>)` so the feature
// stays honest. The mode≥3 name mapping is unblocked by a one-set capture
// folded into the next bench/VW-10 session.

/**
 * cmd=0x07 byte → mode name, for the values whose encoding is confirmed on
 * hardware (1 = WeightTraining, 2 = ResistanceBand). Names match the SDK's
 * `TrainingModeNames` display form so `active_mode` and `requested_mode`
 * (sourced from `TrainingModeNames` via the cmd=0x10 cascade) share one naming
 * scheme. Intentionally hardcoded rather than imported from the SDK: the
 * verified set is tiny and stable, and keeping this module free of a
 * `@voltras/node-sdk` value-import means it never widens the SDK mock surface
 * that the tool tests stub. Bytes ≥3 stay `unverified(<n>)` until a hardware
 * capture (see module header).
 */
const HARDWARE_VERIFIED_ACTIVE_MODE_NAMES: Readonly<Record<number, string>> = {
  1: 'Weight Training',
  2: 'Resistance Band',
};

/**
 * Map an applied-mode raw byte (cmd=0x07 state-dump) to a name.
 *
 *   * `undefined` → `null` — no state-dump observed yet, applied mode unknown.
 *   * `0` → `'transitional'` — mid-mode-switch; the device has no active mode.
 *   * `1` / `2` → the confirmed mode name.
 *   * anything else → `'unverified(<n>)'` — the byte→mode encoding is not yet
 *     hardware-confirmed (see module header), so we surface the raw value
 *     rather than guess.
 */
export function activeModeName(raw?: number): string | null {
  if (raw === undefined) return null;
  if (raw === 0) return 'transitional';
  return HARDWARE_VERIFIED_ACTIVE_MODE_NAMES[raw] ?? `unverified(${raw})`;
}
