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

import { LiveState, type DeviceSnapshot } from './live-state.js';
import { wireBridgeForSlot } from './event-bridge.js';
import { ModeRevertGuard } from './mode-revert-guard.js';
import { CoercionWatch } from './coercion-watch.js';
import { PRIMARY_SLOT, MAX_SLOTS, type ServerState, type SlotState } from './server-state.js';
import { isPhysicalSide, type SlotBindingUpdate } from './slot-bindings.js';

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
  const slot: SlotState = {
    slotId,
    client,
    live: new LiveState(),
    modeRevertGuard: new ModeRevertGuard(),
    coercionWatch: new CoercionWatch(),
  };
  state.slots.set(slotId, slot);
  slot.unwireBridge = wireBridgeForSlot(state, slot);
  seedConnectedState(slot);
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
  // Defensive dispose: even if the BLE-level disconnect path didn't reach
  // this client (manager.disconnect skipped, adapter teardown errored), the
  // disposed flag prevents subsequent stray writes from routing through a
  // stale adapter handle. Dispose is idempotent — if a prior path already
  // disposed, this is a no-op. Slot-routing bug fix — see
  // `sources/audits/ble-slot-routing-2026-05-08.md`.
  try {
    slot.client.dispose();
  } catch {
    // Non-fatal — dispose is documented as idempotent.
  }
  state.slots.delete(slotId);
}

/**
 * Soft-reset the primary slot ahead of the next connect cycle. Swaps in a
 * fresh `VoltraClient` (so `device.connect` can rebind), but PRESERVES the
 * existing `LiveState` instance — only marking it stale via
 * `markDisconnected` so the next resource read returns the last-known
 * device snapshot tagged with `staleSinceDisconnect`. The bridge clears
 * staleness on the first device push after reconnect (Phase 0.5.1 soft-
 * reset; replaces the prior LiveState wipe that returned a blank snapshot
 * during the reconnect window).
 *
 * Unwires the existing bridge before swapping the client so listeners on
 * the old handle can't fire mid-rebind, then re-wires against the fresh
 * client. The `slot.unwireBridge` field is replaced with the new tear-down
 * hook. The mode-revert guard is replaced so a stale latched abort can't
 * block the first set.start of the new connection.
 */
export function resetPrimarySlot(state: ServerState): void {
  const slot = state.slots.get(PRIMARY_SLOT);
  if (!slot) {
    throw new Error(`Primary slot is missing — bootstrap was never run.`);
  }
  slot.unwireBridge?.();
  // Defensive dispose of the outgoing client before swapping in the fresh
  // one. Same rationale as `removeSlot`: ensures no stale adapter/writeChar
  // can route a stray write after the slot has been swapped. Idempotent.
  // Slot-routing bug fix — see
  // `sources/audits/ble-slot-routing-2026-05-08.md`.
  try {
    slot.client.dispose();
  } catch {
    // Non-fatal — dispose is documented as idempotent.
  }
  slot.client = new VoltraClient();
  slot.live.markDisconnected(new Date().toISOString());
  slot.modeRevertGuard = new ModeRevertGuard();
  // Drop any pending coercion checks from the outgoing client so they can't
  // fire against a state-dump on the fresh one. The new connection's first
  // setter call will re-register from scratch.
  slot.coercionWatch.clear();
  slot.unwireBridge = wireBridgeForSlot(state, slot);
  seedConnectedState(slot);
}

/**
 * Seed LiveState with `{connected, deviceId}` if the slot's client is
 * already connected at slot-creation time. The bridge's
 * `onConnectionStateChange` listener is wired AFTER the SDK's initial
 * connect event has already fired, so without this seed LiveState never
 * sees the initial transition and `snapshotDevice().connected` stays
 * `false`. The field shape mirrors the `settingsDelta` produced in
 * `event-bridge.ts` (search for `onConnectionStateChange`).
 *
 * Called by `createSlot` (new slot) and by `device.connect`'s
 * primary-slot rebind path (see device-tools.ts) — both wire the bridge
 * after the initial connect, so both need the seed.
 *
 * VMCP-01.26 (F12).
 */
export function seedConnectedState(slot: SlotState): void {
  const { client, live } = slot;
  if (!client.isConnected) return;
  const initial: Partial<DeviceSnapshot> = { connected: true };
  if (typeof client.connectedDeviceId === 'string') {
    initial.deviceId = client.connectedDeviceId;
  }
  live.applySettings(initial);
}

/**
 * Swap the device bindings between the two connected slots in place.
 *
 * Use case: the side-ID ritual reveals that `'primary'` is bound to the
 * device the user wants on the other slot (and vice versa). Without this
 * helper the only fix is `device.disconnect` both → re-scan → re-connect
 * in opposite order: ~5-6 tool calls and ~15-20s of BLE churn. This helper
 * collapses that into one in-memory mutation — no SDK calls, no BLE writes.
 *
 * The slot keys in `state.slots` (and each entry's `slotId` field) are
 * preserved; only the slot-scoped bindings — `client`, `live`,
 * `modeRevertGuard` and `coercionWatch` — are
 * exchanged. The event bridge is unwired from each
 * slot before the swap and re-wired against the post-swap clients so the
 * `slot.slotId` captured in the bridge's closures continues to label
 * outbound channel events with the slot key the consumer expects (the slot
 * that *now* owns the device).
 *
 * Preconditions: exactly two slots whose client is `isConnected` must be
 * present. The count is intentionally over *connected* slots, not all
 * entries in `state.slots`, because bootstrap leaves an unconnected
 * `'primary'` placeholder behind when the user runs `device.connect`
 * against explicit `'left'` + `'right'` slot ids (F1 / VMCP-01.18). The
 * placeholder gives the implicit-primary flow a target to bind into and
 * must not be allowed to block a swap of the two real connections.
 *
 * A swap against fewer (or more) than two connected slots is a no-op the
 * caller would misinterpret as "swap succeeded," so we throw with a
 * structured `SWAP_REQUIRES_TWO_SLOTS` code that the tool layer surfaces
 * as a typed error — the message reports the connected-slot count so
 * callers who pre-allocated slot ids aren't surprised by a "found 3"-
 * style message that ignored their unconnected entries.
 *
 * The persisted `~/.voltras/slot-bindings.json` mapping is updated in the
 * same operation (VMCP-04.10). A swap that moved only the in-memory slots
 * left the on-disk deviceId → side mapping asserting the pre-swap sides, so
 * every later `device.connect {slot: 'auto'}` re-created the wrong mapping
 * and any left/right series crossing the swap was sign-flipped with nothing
 * erroring. The persisted side is anchored to `deviceId`, never to the slot
 * key — a slot id is a position at a moment, not an identity.
 */
export function swapSlots(state: ServerState): void {
  const connected = [...state.slots.values()].filter((s) => s.client.isConnected);
  if (connected.length !== 2) {
    throw makeCodedError(
      'SWAP_REQUIRES_TWO_SLOTS',
      `slot.swap requires exactly two connected slots; found ${connected.length} connected.`,
    );
  }
  const [a, b] = connected;
  // Persist BEFORE touching memory. The disk write is the only step here
  // that can realistically fail, so doing it first means a failure aborts
  // the swap with both halves still consistent (nothing moved) rather than
  // leaving memory swapped and disk stale — the exact divergence this fix
  // exists to remove. `reassign` is a single atomic tmp+rename, so the two
  // devices never disagree on disk even momentarily.
  const updates = planBindingUpdates(a, b);
  const rollback = currentBindings(state, updates);
  state.slotBindings.reassign(updates);
  try {
    applySwap(state, a, b);
  } catch (err) {
    // Memory swap failed after the write landed — put the persisted sides
    // back so the two never diverge. Best-effort: if the restore write also
    // fails we surface the original error, which is the actionable one.
    try {
      state.slotBindings.reassign(rollback);
    } catch {
      // Swallowed deliberately — see above.
    }
    throw err;
  }
}

/**
 * Exchange the slot-scoped bindings in place. Split out of `swapSlots` so
 * the persistence step can wrap it in a rollback without the failure
 * handling obscuring the mutation itself.
 */
function applySwap(state: ServerState, a: SlotState, b: SlotState): void {
  // Unwire BOTH bridges before mutating either slot — a half-swapped state
  // (one bridge unwired, one still firing against its old client) would let
  // a stray notification land mid-rebind and route to the wrong slot.
  a.unwireBridge?.();
  b.unwireBridge?.();
  const tmpClient = a.client;
  const tmpLive = a.live;
  const tmpGuard = a.modeRevertGuard;
  const tmpWatch = a.coercionWatch;
  a.client = b.client;
  a.live = b.live;
  a.modeRevertGuard = b.modeRevertGuard;
  a.coercionWatch = b.coercionWatch;
  b.client = tmpClient;
  b.live = tmpLive;
  b.modeRevertGuard = tmpGuard;
  b.coercionWatch = tmpWatch;
  a.unwireBridge = wireBridgeForSlot(state, a);
  b.unwireBridge = wireBridgeForSlot(state, b);
}

/**
 * Work out the persisted-binding changes a swap of `a` ↔ `b` implies.
 *
 * The device currently in slot `a` ends up in slot `b`, so its persisted
 * side becomes `b`'s slot key — and vice versa. Two deliberate omissions:
 *
 *   * A slot key that is not a physical side (`'primary'`) yields
 *     `physicalSide: null`, which REMOVES the binding rather than inventing
 *     one. Primary is a bookkeeping position with no left/right meaning, so
 *     after the swap that device's side is genuinely unknown; a gap is
 *     detectable downstream, a plausible guess is not. The side-ID ritual
 *     re-establishes it.
 *   * A client with no `connectedDeviceId` contributes no update at all.
 *     Bindings key on device identity, and we have none to key on.
 */
function planBindingUpdates(a: SlotState, b: SlotState): SlotBindingUpdate[] {
  const updates: SlotBindingUpdate[] = [];
  addBindingUpdate(updates, a.client.connectedDeviceId, b.slotId);
  addBindingUpdate(updates, b.client.connectedDeviceId, a.slotId);
  return updates;
}

function addBindingUpdate(
  updates: SlotBindingUpdate[],
  deviceId: string | null | undefined,
  destinationSlotId: string,
): void {
  if (typeof deviceId !== 'string' || deviceId.length === 0) return;
  updates.push({
    deviceId,
    physicalSide: isPhysicalSide(destinationSlotId) ? destinationSlotId : null,
  });
}

/**
 * Snapshot the persisted side of every device a plan touches, shaped as an
 * inverse plan. Applying it restores the pre-swap file exactly (a device
 * that had no binding maps back to `null`, i.e. removed again).
 */
function currentBindings(state: ServerState, updates: SlotBindingUpdate[]): SlotBindingUpdate[] {
  return updates.map(({ deviceId }) => ({
    deviceId,
    physicalSide: state.slotBindings.get(deviceId)?.physicalSide ?? null,
  }));
}

/**
 * Build an `Error` carrying a structured `code` field. The tool layer's
 * `wrapHandler` → `mapSdkError` chain passes a `code` property through
 * unchanged when it appears on a thrown error, surfacing it as the tool
 * response's structured error code.
 */
function makeCodedError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
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
