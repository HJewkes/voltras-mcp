// VMCP-02.70 — active-mode derivation keys on the settings-update echo.
//
// `active_mode` used to be derived from `DeviceSnapshot.trainingModeRaw` (a
// state-dump field). The 2026-07-07 bench work proved that field is NOT the
// applied training mode — it reports *engagement*, not mode. It cannot
// represent Damper as a mode, goes transiently unset on every switch, and only
// reflects a fitness value while a set is active. Reading it as the applied
// mode reported Damper as "Weight Training".
//
// The reliable current-mode signal is the settings-update echo (the device's
// acknowledgement of a mode write, observed on `onSettingsUpdate`), already
// surfaced as `DeviceSnapshot.trainingMode`. `active_mode` now keys on it, so
// it equals `requested_mode` — there is only one reliable mode signal, not a
// distinct requested-vs-applied pair. The old `mode_diverged` event (which
// compared the echo against this non-mode field and produced false positives
// for Damper) was removed alongside this change.
//
// `trainingModeRaw` is still carried on `DeviceSnapshot` and surfaced by
// `device.get_state` for diagnostics. The write-echo is only as fresh as the
// last observed transition; a proactive on-demand mode read is tracked in
// SDK-01.14.

import type { DeviceSnapshot } from './live-state.js';

/**
 * The device's current training mode name, keyed on the settings-update echo
 * (`DeviceSnapshot.trainingMode`). Returns `null` when no mode has been
 * observed yet (fresh connect before any mode write / cascade replay).
 *
 * Equal to `requested_mode` by construction (VMCP-02.70): the echo is the
 * single reliable mode signal. Kept as a named helper so the sourcing decision
 * lives in one documented place across every payload that reports `active_mode`.
 */
export function activeMode(device: DeviceSnapshot): string | null {
  return device.trainingMode ?? null;
}
