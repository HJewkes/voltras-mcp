// Wait for the device to echo a requested training mode (VW-162, VMCP-02.90).
//
// Moved from `tools/device-handler-helpers.ts` (VW-857) so `state/` callers
// such as `bilateral-cascade.ts` need not import the tools layer.

import type { TrainingMode } from '@voltras/node-sdk';

import { MODE_REVERT_WINDOW_MS, type ModeRevertGuard } from './mode-revert-guard.js';

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
