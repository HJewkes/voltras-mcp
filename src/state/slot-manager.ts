// Slot lifecycle helpers — owns the create / remove / reset operations for
// `state.slots` plus the per-slot event-bridge wiring that pairs with each
// mutation.
//
// This module sits one layer above `server-state.ts` and `event-bridge.ts` and
// imports both. That ordering breaks the otherwise-circular dependency
// (`server-state` would otherwise need `event-bridge` for `wireBridgeForSlot`,
// and `event-bridge` already pulls in `set-tools` → `server-state`). Earlier
// iterations papered over the cycle with a `state.bridgeWirer` function-pointer
// indirection; this module replaces it with a clean topological split.
//
// Each helper guarantees that the per-slot listener subscription is in lockstep
// with the slot's presence in the map: `createSlot` wires the bridge before
// returning, `removeSlot` unwires before deleting, and `resetPrimarySlot`
// unwires the stale client's listeners before swapping in a fresh client +
// LiveState and re-wiring.
//
// Test fixtures construct `ServerState` directly (no `runServer`) and call
// `wireEventBridge(state)` themselves to populate `slot.unwireBridge` on the
// primary slot. Slots allocated through `createSlot` after that point pick up
// the wiring inline, no extra step needed.

import { VoltraClient } from '@voltras/node-sdk';

import { LiveState } from './live-state.js';
import { wireBridgeForSlot } from './event-bridge.js';
import { PRIMARY_SLOT, MAX_SLOTS, type ServerState, type SlotState } from './server-state.js';

/**
 * Allocate a brand-new slot. Each slot owns its own `LiveState` so the
 * session/set/rep pipelines run independently — sharing live state across
 * slots would let frames from one device mutate the other's set boundaries
 * and rep buffer. The supplied `client` becomes the slot's BLE handle; the
 * caller is responsible for having already connected it via
 * `manager.connect(device)`.
 *
 * After inserting the slot the helper subscribes the event bridge to the new
 * slot's client and stashes the unwire hook on the slot itself so a later
 * `removeSlot` / `resetPrimarySlot` can detach listeners from the stale
 * handle.
 */
export function createSlot(state: ServerState, slotId: string, client: VoltraClient): SlotState {
  if (state.slots.has(slotId)) {
    throw new Error(`Slot \`${slotId}\` already exists.`);
  }
  // The cap counts slots whose client is actually connected — the
  // bootstrap-only primary slot (parameter-less VoltraClient, never wired
  // to a device) does NOT count, so a true bilateral flow can allocate
  // both `'left'` and `'right'` even though primary is also present in
  // the map. Once the user binds a device to primary (single-device flow,
  // no explicit slot arg), primary's client.isConnected flips true and it
  // joins the count.
  if (countConnectedSlots(state) >= MAX_SLOTS) {
    throw new Error(`Maximum of ${MAX_SLOTS} slots supported in this release.`);
  }
  const slot: SlotState = { slotId, client, live: new LiveState() };
  state.slots.set(slotId, slot);
  slot.unwireBridge = wireBridgeForSlot(state, slot);
  return slot;
}

/**
 * Tear down a non-primary slot. The caller must have already issued the
 * BLE-level disconnect via `state.manager.disconnect(deviceId)` — this
 * helper handles only the in-memory removal so the disconnect path stays
 * idempotent against a half-torn-down adapter.
 *
 * Errors when called on `'primary'` because the primary slot must persist
 * across disconnects: re-connecting the primary device should not require
 * re-allocating the slot. Use `resetPrimarySlot` instead.
 */
export function removeSlot(state: ServerState, slotId: string): void {
  if (slotId === PRIMARY_SLOT) {
    throw new Error(`Cannot remove the primary slot — use resetPrimarySlot instead.`);
  }
  const slot = state.slots.get(slotId);
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  slot.unwireBridge?.();
  state.slots.delete(slotId);
}

/**
 * Reset the primary slot back to its bootstrap shape: a fresh
 * parameter-less `VoltraClient` (so `device.connect` can rebind it) and a
 * fresh `LiveState` (so a stale session/set from the prior connection can't
 * leak into the next one). The slot itself stays in `state.slots` because
 * a single-device flow never calls `device.connect` with an explicit slot
 * id, so the entry must remain resolvable for the default lookup.
 *
 * Unwires the existing bridge before swapping client / LiveState so listeners
 * on the old handle can't fire mid-rebind, then re-wires the bridge against
 * the fresh shape. The `slot.unwireBridge` field is replaced with the new
 * tear-down hook.
 */
export function resetPrimarySlot(state: ServerState): void {
  const slot = state.slots.get(PRIMARY_SLOT);
  if (!slot) {
    throw new Error(`Primary slot is missing — bootstrap was never run.`);
  }
  slot.unwireBridge?.();
  slot.client = new VoltraClient();
  slot.live = new LiveState();
  slot.unwireBridge = wireBridgeForSlot(state, slot);
}

/**
 * Count slots whose underlying client is actively connected to a device.
 * The bootstrap primary slot starts with a parameter-less `VoltraClient`
 * (`isConnected === false`), so it's invisible to the cap until the user
 * runs `device.connect` against it. A true bilateral allocation
 * (`'left'` + `'right'`) doesn't trip SLOT_LIMIT_EXCEEDED solely because
 * of primary's bookkeeping presence.
 */
function countConnectedSlots(state: ServerState): number {
  let count = 0;
  for (const slot of state.slots.values()) {
    if (slot.client.isConnected) {
      count += 1;
    }
  }
  return count;
}
