// Pure, independently-testable helpers extracted from the `device.*` tool
// handlers in `device-tools.ts`. Keeping these out of the handler bodies keeps
// each handler under the 30-line budget and lets the decision logic be
// exercised in isolation (no MCP server, no BLE stack, no live snapshot wiring).
//
// These are behaviour-preserving extractions — the logic mirrors the handler
// code exactly. See the anchor comments in `device-tools.ts` for the firmware
// rationale behind each decision.

import type { TrainingModeName } from '../schemas/common.js';
import type { DeviceSnapshot } from '../state/live-state.js';
import type { TrackedFieldSpec } from '../state/coercion-watch.js';
import { log } from '../logger.js';

/**
 * VMCP-02.45 cold-boot Idle preflight decision (extracted from
 * `device.start_guided_load`). Returns `true` when the guided-load entry must
 * first drive the device into WeightTraining and skip the Workout.STOP unload.
 *
 * `requestedMode` is the REQUESTED mode echoed from the cmd=0x10 cascade and is
 * `undefined` until the first cascade fires. On a fresh boot/wake no requested
 * mode has been observed yet, so an unknown/absent requested mode is treated
 * the same as explicit Idle (#83 cold-boot fix — preserved verbatim).
 */
export function shouldPreflightWeightTraining(
  requestedMode: TrainingModeName | undefined,
): boolean {
  return requestedMode === 'Idle' || requestedMode === undefined;
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
