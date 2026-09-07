// The `VoiceWeightContext` the local weight fast-path drives (VMCP-02.87).
//
// Split from `voice-weight.ts` on purpose: `server-state.ts` imports
// `voice-tools.ts` (for the listener holder), so anything reachable from the
// fast-path orchestration must stay clear of `device-tools.ts` or the module
// graph closes a cycle through the device schemas. Only `client-connection`
// builds this, and only it pays that import cost.

import type { ServerState } from '../state/server-state.js';
import { setSlotWeight } from './device-tools.js';
import type { VoiceWeightContext } from './voice-weight.js';

/**
 * Build the fast-path hooks over live server state. Weight writes go through
 * the same coercion-tracked setter as `device.set_weight` so a firmware
 * rewrite still surfaces as `setting_coerced`.
 */
export function makeVoiceWeight(state: ServerState): VoiceWeightContext {
  return {
    slots: () =>
      [...state.slots.values()]
        .filter((slot) => slot.client.isConnected)
        .map((slot) => ({
          slot: slot.slotId,
          activeSetStartedAtMs: activeSetStartedAtMs(slot.live.snapshotSet()),
          lastSetEndedAtMs: state.lastSetEndedAtMs.get(slot.slotId) ?? null,
          currentWeightLbs: slot.live.snapshotDevice().weightLbs ?? null,
        })),
    setWeight: (slotId, lbs) => setSlotWeight(state, slotId, lbs),
  };
}

function activeSetStartedAtMs(
  set: { status: string; startedAt: string } | undefined,
): number | null {
  if (set === undefined || set.status !== 'active') return null;
  const ms = Date.parse(set.startedAt);
  return Number.isNaN(ms) ? null : ms;
}
