// Independently-testable helpers extracted from the `device.*` tool handlers in
// `device-tools.ts`. Keeping these out of the handler bodies keeps each handler
// under the 30-line budget and lets the decision logic be exercised in
// isolation (no MCP server, no BLE stack, no live snapshot wiring).
//
// These are behaviour-preserving extractions — the logic mirrors the handler
// code exactly. See the anchor comments in `device-tools.ts` for the firmware
// rationale behind each decision.

import type { TrainingMode } from '@voltras/node-sdk';

import type { TrainingModeName } from '../schemas/common.js';
import type { DeviceSnapshot } from '../state/live-state.js';
import type { TrackedFieldSpec } from '../state/coercion-watch.js';
import { MODE_REVERT_WINDOW_MS, type ModeRevertGuard } from '../state/mode-revert-guard.js';
import { log } from '../logger.js';

/**
 * VMCP-02.45 cold-boot Idle preflight decision (extracted from
 * `device.start_guided_load`). Returns `true` when the guided-load entry must
 * first drive the device into WeightTraining and skip the Workout.STOP unload.
 *
 * `requestedMode` is the REQUESTED mode carried on the settings-update echo,
 * and is `undefined` until the first echo fires. On a fresh boot/wake no requested
 * mode has been observed yet, so an unknown/absent requested mode is treated
 * the same as explicit Idle (#83 cold-boot fix — preserved verbatim).
 */
export function shouldPreflightWeightTraining(
  requestedMode: TrainingModeName | undefined,
): boolean {
  return requestedMode === 'Idle' || requestedMode === undefined;
}

/**
 * How often {@link waitForModeEcho} re-reads the guard's last echo. The echo
 * arrives on the bridge's settings_update callback, so polling is only the
 * observation mechanism — 25ms keeps the added latency under a typical BLE
 * round-trip without spinning.
 */
export const MODE_ECHO_POLL_MS = 25;

/** Tunable bounds for the mode-echo wait. Defaults are the production values. */
export interface ModeEchoWaitOptions {
  /**
   * Bound on the wait for the device to echo the requested mode. Defaults to
   * `MODE_REVERT_WINDOW_MS`: past that the mode-revert guard has stopped
   * evaluating divergence for this write, so a longer wait would report a
   * confirmation the safety guard no longer stands behind.
   */
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
}

/**
 * Poll the guard's last echo until it reports `mode`. Returns the elapsed
 * milliseconds, or `null` on timeout. The guard is left armed either way, so
 * an echo that lands after we gave up still clears its latch.
 *
 * Shared by `bilateral.cascade` (VW-162) and the `device.start_guided_load`
 * auto-switch (VMCP-02.90): both hold a device write until the mode that write
 * depends on is confirmed, and one implementation keeps them from drifting.
 */
export async function waitForModeEcho(
  guard: Pick<ModeRevertGuard, 'echoedMode'>,
  mode: TrainingMode,
  options: ModeEchoWaitOptions = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? MODE_REVERT_WINDOW_MS;
  const pollMs = options.pollMs ?? MODE_ECHO_POLL_MS;
  const startedAt = Date.now();
  for (;;) {
    if (guard.echoedMode() === mode) return Date.now() - startedAt;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsed)));
  }
}

/**
 * Builds the F3 coercion-tracked field specs for `device.start_guided_load`.
 *
 * `baseWeight` always tracks in `exact` mode against the caller's explicit
 * target. `chains` and `eccentricPercentTenths` track in `guard` mode against
 * the user's PRIOR configured value, and are only included when a prior value
 * exists (no requested-baseline → nothing for the bridge to compare against).
 */
export function buildGuidedLoadTrackedFields(
  targetWeightLbs: number,
  preDevice: Pick<DeviceSnapshot, 'chainSettingLbs' | 'eccentricPercentTenths'>,
): TrackedFieldSpec[] {
  const fields: TrackedFieldSpec[] = [
    { field: 'baseWeight', requested: targetWeightLbs, mode: 'exact' },
  ];
  if (typeof preDevice.chainSettingLbs === 'number') {
    fields.push({ field: 'chains', requested: preDevice.chainSettingLbs, mode: 'guard' });
  }
  if (typeof preDevice.eccentricPercentTenths === 'number') {
    fields.push({
      field: 'eccentricPercentTenths',
      requested: preDevice.eccentricPercentTenths,
      mode: 'guard',
    });
  }
  return fields;
}

/**
 * Belt-and-suspenders BLE resource teardown for `device.disconnect`, run after
 * the manager-disconnect path. Force-closes a captured adapter (W3C
 * `device.gatt.disconnect()` is fire-and-forget; the SimpleBLE handle map can
 * leak) and then disposes the slot client (idempotent).
 *
 * Both steps are best-effort: a failure is logged at info level and swallowed
 * so slot bookkeeping still reaches a clean terminal state (mirrors the sibling
 * `setMode(Idle)` best-effort log). Previously these two catches were silent.
 */
export async function teardownBleResources(
  adapterRef: { disconnect: () => Promise<void> } | null,
  client: { dispose: () => void },
): Promise<void> {
  if (adapterRef !== null) {
    try {
      await adapterRef.disconnect();
    } catch (e) {
      log.info('device.disconnect: adapter force-close failed (best-effort, proceeding)', e);
    }
  }
  try {
    client.dispose();
  } catch (e) {
    log.info('device.disconnect: client dispose failed (best-effort, proceeding)', e);
  }
}

/**
 * VW-178: will the next `set.start` refuse over a latched mode revert?
 *
 * Two independent views of the same settings-update echo must both say the revert is
 * still live: the guard's own last settings_update (`stillRevertedPerGuard`
 * from `ModeRevertGuard.isStillReverted()`) and the LiveState snapshot every
 * other mode surface reads (`echoedModeName`). Since VW-178 nothing clears the
 * latch on read, so requiring both keeps one stale view from turning a resolved
 * revert into a permanent block. A snapshot with no mode at all cannot vouch
 * for recovery, so the guard's view stands.
 *
 * `revertedToModeName` is the display name of the abort's `actual` mode.
 */
export function isModeRevertStillActive(
  stillRevertedPerGuard: boolean,
  revertedToModeName: string | undefined,
  echoedModeName: string | undefined,
): boolean {
  if (!stillRevertedPerGuard) return false;
  if (echoedModeName === undefined) return true;
  return echoedModeName === revertedToModeName;
}
