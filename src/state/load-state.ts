// Whether the cable is currently under load.
//
// Lifted out of `tools/device-tools.ts` (VMCP-01.61) so the state layer can
// consult it without importing the tool layer. Pure — a function of the SDK
// client's already-observed fields, no I/O.

import type { GuidedLoadState } from '@voltras/node-sdk';

/**
 * Coarse loaded/unloaded verdict for the coach surface.
 *
 * Deliberately coarse: `unloaded` reads during ordinary weight-training reps,
 * because the cable is genuinely slack across rests and short pauses and the
 * coach surface should treat those as unloaded. The `loaded` branch covers
 * guided-load and rowing, where the cable is continuously hot. Callers needing
 * a finer answer should inspect `is_recording` + `guided_load.phase` +
 * telemetry force directly.
 */
export function deriveLoadState(
  isConnected: boolean,
  guidedLoadState: GuidedLoadState,
  isRowingActive: boolean,
): 'loaded' | 'unloaded' {
  if (!isConnected) return 'unloaded';
  if (guidedLoadState.phase === 'engaging' || guidedLoadState.phase === 'active') return 'loaded';
  if (isRowingActive) return 'loaded';
  return 'unloaded';
}
