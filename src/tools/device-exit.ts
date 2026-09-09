// The device exit path: drop the load, end the guided-load flow (VW-200).
//
// Extracted from `device-tools.ts` so the callers that only need to STOP the
// machine — the lease surrender, the voice stop-phrase, an aborted isometric
// assessment — do not have to pull in the whole `device.*` tool surface (and
// its SDK enum imports) to do it. `device-tools.ts` re-exports `unloadSlot`,
// so every existing import site keeps working.

import { reapGuidedLoadScaffold } from '../state/guided-load-reap.js';
import { getSlot, type ServerState } from '../state/server-state.js';

/** Phases in which the SDK's guided-load state machine is still running. */
export const GUIDED_LOAD_ACTIVE_PHASES = new Set(['armed', 'countdown', 'engaging', 'active']);

/**
 * Reusable unload for a slot — single source of truth shared by the
 * `device.unload` tool AND the VMCP-02.78 voice safety fast-path (which must
 * unload WITHOUT the MCP/LLM round-trip, so it cannot go through the tool).
 *
 * VMCP-02.41: capture whether we are tearing down an active guided-load flow
 * BEFORE the mode-bounce. `unloadDevice()` physically drops the cable but never
 * touches the SDK's guided-load state machine, so `guidedLoadState.phase` — and
 * the `load_state` / `guided_load.phase` that get_state derives from it — would
 * stay stale at `active` / `loaded` after the unload. When unload is the
 * teardown for an active flow, drive the SDK through `exitGuidedLoad()` too:
 * that transitions the phase to `exited` (refreshing get_state), fires
 * onGuidedLoadState so the bridge publishes the terminal `guided_load_state`
 * channel event (outcome: 'ended'), and lets us reap the auto-created scaffold.
 */
export async function unloadSlot(state: ServerState, slotId: string): Promise<void> {
  const slot = getSlot(state, slotId);
  const wasGuidedLoadActive = GUIDED_LOAD_ACTIVE_PHASES.has(slot.client.guidedLoadState.phase);
  await slot.client.unloadDevice();
  if (wasGuidedLoadActive) {
    await slot.client.exitGuidedLoad();
    await reapGuidedLoadScaffold(state, slotId);
  }
}

/**
 * End an in-flight guided-load flow — the same `exitGuidedLoad` + scaffold reap
 * `device.exit_guided_load` performs, minus the tool's "you are not in guided
 * load" refusal. A no-op once the phase has left the active set, so it is safe
 * to call after another session's surrender already tore the flow down.
 */
export async function stopGuidedLoadPoll(state: ServerState, slotId: string): Promise<void> {
  const slot = getSlot(state, slotId);
  if (!GUIDED_LOAD_ACTIVE_PHASES.has(slot.client.guidedLoadState.phase)) return;
  await slot.client.exitGuidedLoad();
  await reapGuidedLoadScaffold(state, slotId);
}
