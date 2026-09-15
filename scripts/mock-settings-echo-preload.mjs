// mock-settings-echo-preload: let a `VOLTRA_ADAPTER=mock` run record the load
// and training mode its sets were performed at.
//
// Loaded into the MCP server process with
// `node --import <this file> dist/bin.js` by `scripts/dashboard-mock-drive.mjs`
// (every mode, `--dual` included). Nothing in `src/` changes.
//
// Why it is needed ──────────────────────────────────────────────────────────
// A stored set takes its `weightLbs` / `trainingMode` from the slot's device
// snapshot (`buildStoredSet`, src/tools/set-tools.ts), and that snapshot is
// only ever filled from the device's own settings echo (`onSettingsUpdate` ->
// `settingsToSnapshot`, src/state/event-bridge.ts). The SDK's mock adapter
// answers a weight write with nothing at all, so every set a stock mock run
// records is missing both fields — which is why `goal.propose_targets` came
// back NOT_FOUND ("no working set on record") for a lift driven entirely
// through the mock, and why the `#/goals` PR star could never fire off one
// (VW-384).
//
// What this patches (and what it deliberately does NOT) ─────────────────────
//   * `VoltraClient.prototype.setWeight` / `.setMode` — each calls through to
//     the real implementation first, then replays the accepted value back to
//     that client's own settings listeners, which is what a real Voltra does a
//     few milliseconds after the write lands.
//   * Nothing else. No frame is synthesized and no decoder is touched: the
//     stand-in starts at the SDK's already-decoded settings boundary, the one
//     layer the mock leaves empty. The event bridge, LiveState, the set
//     writer and every MCP tool run exactly as they do against hardware.

import { VoltraClient } from '@voltras/node-sdk';

/**
 * Replay `settings` to one client's settings listeners, the way the SDK's own
 * notification decoder does. The cached cascade is updated first so a listener
 * that attaches later gets the same bootstrap replay hardware would give it.
 */
function echoSettings(client, settings) {
  const merged = { ...(client._lastDeviceSettings ?? {}), ...settings };
  client._lastDeviceSettings = merged;
  client.syncSettingsFromDevice?.(merged);
  for (const listener of client.settingsUpdateListeners ?? []) listener(merged);
}

const setWeight = VoltraClient.prototype.setWeight;
VoltraClient.prototype.setWeight = async function patchedSetWeight(lbs) {
  await setWeight.call(this, lbs);
  echoSettings(this, { baseWeight: lbs });
};

const setMode = VoltraClient.prototype.setMode;
VoltraClient.prototype.setMode = async function patchedSetMode(mode) {
  await setMode.call(this, mode);
  echoSettings(this, { trainingMode: mode });
};

process.stderr.write('[mock-settings-echo] weight and mode writes will echo back as settings\n');
