// Slot lifecycle helpers — Step 3 of P0 dual-Voltras support.
//
// `createSlot` / `removeSlot` / `resetPrimarySlot` are the pure-data
// mutators that back `device.connect` / `device.disconnect` once an
// explicit `slot` argument is in play. The helpers are tested at the
// state layer (rather than only through the device tools) so the
// invariants — fresh LiveState per slot, primary-slot persistence,
// soft cap of MAX_SLOTS — stay locked down even if the tool layer is
// later refactored.

import { describe, expect, it, vi } from 'vitest';

// SDK stub — `VoltraClient` is constructed by `resetPrimarySlot` and
// instantiated directly by the test bodies; the real class would pull in
// the BLE adapter chain, which we don't need here. `isConnected` is part
// of the structural surface the slot-cap policy reads (Step 4 of P0
// dual-Voltras counts only connected slots), so the stub exposes it as
// a writable boolean.
vi.mock('@voltras/node-sdk', () => ({
  VoltraClient: class {
    isConnected = false;
  },
  VoltraManager: class {},
  TrainingMode: { Idle: 0 },
  VoltraSDKError: class extends Error {},
}));

const { VoltraClient } = await import('@voltras/node-sdk');
const { LiveState } = await import('../live-state.js');
const { createSlot, removeSlot, resetPrimarySlot, getSlot, PRIMARY_SLOT, MAX_SLOTS } =
  await import('../server-state.js');

/** Build a connected `VoltraClient` stub (matches the slot-cap policy's
 * isConnected check). Slot-cap tests need slots whose clients claim to be
 * connected so the cap actually triggers. */
function connectedClient(): InstanceType<typeof VoltraClient> {
  const c = new VoltraClient() as InstanceType<typeof VoltraClient> & { isConnected: boolean };
  c.isConnected = true;
  return c;
}

import type { ServerState } from '../server-state.js';

function makeStateWithPrimary(opts: { primaryConnected?: boolean } = {}): ServerState {
  const slots = new Map();
  const client = opts.primaryConnected === true ? connectedClient() : new VoltraClient();
  slots.set(PRIMARY_SLOT, {
    slotId: PRIMARY_SLOT,
    client,
    live: new LiveState(),
  });
  return { slots } as unknown as ServerState;
}

describe('createSlot', () => {
  it('adds a new slot with its own LiveState (isolated from other slots)', () => {
    const state = makeStateWithPrimary();
    const client = new VoltraClient();
    const slot = createSlot(state, 'left', client);

    expect(slot.slotId).toBe('left');
    expect(slot.client).toBe(client);
    expect(slot.live).toBeInstanceOf(LiveState);
    expect(state.slots.get('left')).toBe(slot);
    // Distinct LiveState per slot — frames on `left` must not mutate
    // primary's pipeline.
    expect(slot.live).not.toBe(getSlot(state).live);
  });

  it('errors when the slot id is already taken', () => {
    const state = makeStateWithPrimary();
    expect(() => createSlot(state, PRIMARY_SLOT, new VoltraClient())).toThrow(/already exists/i);
  });

  it('enforces the MAX_SLOTS soft cap on CONNECTED slots (two devices in this release)', () => {
    // Step 4 of P0 dual-Voltras: the cap counts slots with
    // `client.isConnected === true`, so primary's bootstrap stub
    // (isConnected=false) is invisible. We have to use already-connected
    // primary + connected-left to fill the cap; an unconnected stub
    // would let createSlot succeed past the second slot.
    const state = makeStateWithPrimary({ primaryConnected: true });
    createSlot(state, 'left', connectedClient());
    expect(() => createSlot(state, 'right', connectedClient())).toThrow(/Maximum of 2 slots/i);
  });

  it('does NOT count an idle bootstrap primary against the cap (allows true bilateral)', () => {
    // Inverse case: when primary stays at its bootstrap shape
    // (isConnected=false), allocating both `'left'` and `'right'`
    // succeeds even though the slots map ends up at size 3. The cap is
    // about live device connections, not about slot-map bookkeeping.
    const state = makeStateWithPrimary();
    createSlot(state, 'left', connectedClient());
    createSlot(state, 'right', connectedClient());
    expect(state.slots.size).toBe(3);
    expect(MAX_SLOTS).toBe(2);
  });
});

describe('removeSlot', () => {
  it('removes a non-primary slot from the map', () => {
    const state = makeStateWithPrimary();
    createSlot(state, 'left', new VoltraClient());
    expect(state.slots.has('left')).toBe(true);

    removeSlot(state, 'left');
    expect(state.slots.has('left')).toBe(false);
    // Primary stays put.
    expect(state.slots.has(PRIMARY_SLOT)).toBe(true);
  });

  it("errors when called on 'primary' (use resetPrimarySlot instead)", () => {
    const state = makeStateWithPrimary();
    expect(() => removeSlot(state, PRIMARY_SLOT)).toThrow(/Cannot remove the primary slot/i);
    expect(state.slots.has(PRIMARY_SLOT)).toBe(true);
  });

  it('errors when the slot id is unknown', () => {
    const state = makeStateWithPrimary();
    expect(() => removeSlot(state, 'phantom')).toThrow(/Unknown slot/i);
  });
});

describe('resetPrimarySlot', () => {
  it("keeps 'primary' in the map but with a fresh client and fresh LiveState", () => {
    const state = makeStateWithPrimary();
    const original = getSlot(state);
    // Capture references *before* the reset — `original.client` /
    // `original.live` would otherwise see the post-reset values because
    // `resetPrimarySlot` mutates the SlotState wrapper in place.
    const priorClient = original.client;
    const priorLive = original.live;
    // Mutate primary's LiveState so we can verify the reset replaced it.
    priorLive.startSession({
      sessionId: 'sess-pre-reset',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
    });
    expect(priorLive.snapshotSession()?.sessionId).toBe('sess-pre-reset');

    resetPrimarySlot(state);

    const after = getSlot(state);
    expect(state.slots.has(PRIMARY_SLOT)).toBe(true);
    expect(after.slotId).toBe(PRIMARY_SLOT);
    // Same SlotState wrapper (we mutate fields in place) — so the
    // `getSlot(state)` reference held by callers stays valid.
    expect(after).toBe(original);
    // Fresh client — not the original VoltraClient instance.
    expect(after.client).not.toBe(priorClient);
    expect(after.client).toBeInstanceOf(VoltraClient);
    // Fresh LiveState — the pre-reset session is gone.
    expect(after.live).not.toBe(priorLive);
    expect(after.live.snapshotSession()).toBeUndefined();
  });
});
