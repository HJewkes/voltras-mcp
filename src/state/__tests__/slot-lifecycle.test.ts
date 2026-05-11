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
    connectedDeviceId: string | null = null;
    disposed = false;
    dispose(): void {
      this.disposed = true;
    }
  },
  VoltraManager: class {},
  TrainingMode: { Idle: 0 },
  VoltraSDKError: class extends Error {},
}));

// Stub the per-slot event-bridge wirer. The slot-manager helpers call this
// to subscribe listeners on the slot's client; here we only care about
// slot-map invariants (creation / removal / primary reset), so a no-op
// wirer that returns a tracked unwire fn keeps the test layer-pure without
// pulling channel-publisher / debug-buffer / live-state plumbing into the
// fixture.
vi.mock('../event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { VoltraClient } = await import('@voltras/node-sdk');
const { LiveState } = await import('../live-state.js');
const { getSlot, PRIMARY_SLOT, MAX_SLOTS } = await import('../server-state.js');
const { createSlot, removeSlot, resetPrimarySlot, swapSlots } = await import('../slot-manager.js');
const { ModeRevertGuard } = await import('../mode-revert-guard.js');
const { CoercionWatch } = await import('../coercion-watch.js');

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
    modeRevertGuard: new ModeRevertGuard(),
    coercionWatch: new CoercionWatch(),
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

  // VMCP-01.26 (F12) — bridge listener is wired AFTER the SDK has already
  // fired its initial onConnectionStateChange('connected'), so createSlot
  // must seed LiveState from the already-connected client's getters or
  // `snapshotDevice().connected` stays false until the next change event
  // (which may never come, since the device is already in steady state).
  it('seeds LiveState from an already-connected client (initial connect event)', () => {
    const state = makeStateWithPrimary();
    const client = new VoltraClient() as InstanceType<typeof VoltraClient> & {
      isConnected: boolean;
      connectedDeviceId: string | null;
    };
    client.isConnected = true;
    client.connectedDeviceId = 'mock-device';

    const slot = createSlot(state, 'left', client);

    // Synchronous — no event-loop tick required.
    const snap = slot.live.snapshotDevice();
    expect(snap.connected).toBe(true);
    expect(snap.deviceId).toBe('mock-device');
  });

  it('does not seed LiveState when the client is not yet connected', () => {
    const state = makeStateWithPrimary();
    const slot = createSlot(state, 'left', new VoltraClient());
    expect(slot.live.snapshotDevice().connected).toBe(false);
  });

  it('omits deviceId from the seed when the client has no connectedDeviceId yet', () => {
    const state = makeStateWithPrimary();
    const client = new VoltraClient() as InstanceType<typeof VoltraClient> & {
      isConnected: boolean;
      connectedDeviceId: string | null;
    };
    client.isConnected = true;
    // connectedDeviceId stays null (matches SDK getter return for
    // a partially-bootstrapped client).
    const slot = createSlot(state, 'left', client);
    const snap = slot.live.snapshotDevice();
    expect(snap.connected).toBe(true);
    expect(snap.deviceId).toBeUndefined();
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

  // Slot-routing fix (2026-05-08) — defensive dispose. See
  // `coordination/bug-investigations/ble-slot-routing-2026-05-08.md`.
  it('disposes the slot client to prevent stray writes through stale handles', () => {
    const state = makeStateWithPrimary();
    const client = new VoltraClient() as InstanceType<typeof VoltraClient> & { disposed: boolean };
    createSlot(state, 'left', client);
    expect(client.disposed).toBe(false);

    removeSlot(state, 'left');
    expect(client.disposed).toBe(true);
  });
});

describe('resetPrimarySlot', () => {
  it("keeps 'primary' in the map with a fresh client and a soft-reset LiveState", () => {
    const state = makeStateWithPrimary();
    const original = getSlot(state);
    // Capture references *before* the reset — `original.client` would
    // otherwise see the post-reset value because `resetPrimarySlot` mutates
    // the SlotState wrapper in place.
    const priorClient = original.client;
    const priorLive = original.live;
    // Seed last-known settings on LiveState so we can verify the soft-reset
    // preserved them as cached pre-disconnect data.
    priorLive.applySettings({ connected: true, weightLbs: 50, damperLevel: 4 });

    resetPrimarySlot(state);

    const after = getSlot(state);
    expect(state.slots.has(PRIMARY_SLOT)).toBe(true);
    expect(after.slotId).toBe(PRIMARY_SLOT);
    expect(after).toBe(original);
    // Fresh client — not the original VoltraClient instance.
    expect(after.client).not.toBe(priorClient);
    expect(after.client).toBeInstanceOf(VoltraClient);
    // Same LiveState instance — soft-reset preserves last-known data.
    expect(after.live).toBe(priorLive);
    // The cached snapshot is still the pre-disconnect device state, but
    // marked stale so consumers can distinguish it from a fresh push.
    const snap = after.live.snapshotDevice();
    expect(snap.weightLbs).toBe(50);
    expect(snap.damperLevel).toBe(4);
    expect(snap.connected).toBe(false);
    expect(after.live.isStale()).toBe(true);
    expect(snap.staleSinceDisconnect).toBeDefined();
  });

  // VMCP-01.26 (F12) — resetPrimarySlot is the other path that swaps in a
  // fresh client. The fresh client starts disconnected so the seed is a
  // no-op here; the regression test pins the absence of seeding so a
  // future change that pre-binds a connected client wouldn't silently
  // overwrite the soft-reset's `markDisconnected` stale-flag.
  it('does not seed connected state on the fresh post-reset client (which starts disconnected)', () => {
    const state = makeStateWithPrimary();
    resetPrimarySlot(state);
    const after = getSlot(state);
    const snap = after.live.snapshotDevice();
    expect(snap.connected).toBe(false);
    expect(after.live.isStale()).toBe(true);
  });

  // Slot-routing fix (2026-05-08) — defensive dispose. See
  // `coordination/bug-investigations/ble-slot-routing-2026-05-08.md`.
  it('disposes the outgoing client before swapping in the fresh one', () => {
    const state = makeStateWithPrimary();
    const priorClient = getSlot(state).client as InstanceType<typeof VoltraClient> & {
      disposed: boolean;
    };
    expect(priorClient.disposed).toBe(false);

    resetPrimarySlot(state);
    expect(priorClient.disposed).toBe(true);
    // Fresh client takes over; it must not also be disposed.
    const freshClient = getSlot(state).client as InstanceType<typeof VoltraClient> & {
      disposed: boolean;
    };
    expect(freshClient.disposed).toBe(false);
  });
});

describe('swapSlots', () => {
  it('exchanges client/live/modeRevertGuard between the two slots while keeping slot keys stable', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    const leftClient = connectedClient();
    createSlot(state, 'left', leftClient);
    const primaryBefore = getSlot(state, PRIMARY_SLOT);
    const leftBefore = getSlot(state, 'left');
    const primaryClientBefore = primaryBefore.client;
    const primaryLiveBefore = primaryBefore.live;
    const primaryGuardBefore = primaryBefore.modeRevertGuard;
    const leftLiveBefore = leftBefore.live;
    const leftGuardBefore = leftBefore.modeRevertGuard;

    swapSlots(state);

    const primaryAfter = getSlot(state, PRIMARY_SLOT);
    const leftAfter = getSlot(state, 'left');
    // SlotState wrapper objects are mutated in place — same references, but
    // their `client` / `live` / `modeRevertGuard` fields swap.
    expect(primaryAfter).toBe(primaryBefore);
    expect(leftAfter).toBe(leftBefore);
    expect(primaryAfter.slotId).toBe(PRIMARY_SLOT);
    expect(leftAfter.slotId).toBe('left');
    // Bindings have flipped.
    expect(primaryAfter.client).toBe(leftClient);
    expect(leftAfter.client).toBe(primaryClientBefore);
    expect(primaryAfter.live).toBe(leftLiveBefore);
    expect(leftAfter.live).toBe(primaryLiveBefore);
    expect(primaryAfter.modeRevertGuard).toBe(leftGuardBefore);
    expect(leftAfter.modeRevertGuard).toBe(primaryGuardBefore);
  });

  it('rejects when only one slot is connected (primary connected, no second slot)', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    expect(() => swapSlots(state)).toThrow(/found 1 connected/i);
  });

  it('rejects when neither slot is connected', () => {
    // Two slots in the map but neither has `isConnected: true`.
    const state = makeStateWithPrimary();
    createSlot(state, 'left', new VoltraClient());
    expect(() => swapSlots(state)).toThrow(/found 0 connected/i);
  });

  it('rejects when one slot is bound but the other is not', () => {
    // Primary is connected; left is a fresh placeholder (isConnected=false).
    const state = makeStateWithPrimary({ primaryConnected: true });
    createSlot(state, 'left', new VoltraClient());
    expect(() => swapSlots(state)).toThrow(/found 1 connected/i);
  });

  it('attaches a SWAP_REQUIRES_TWO_SLOTS code on the empty-second-slot rejection', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    let caught: unknown;
    try {
      swapSlots(state);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('SWAP_REQUIRES_TWO_SLOTS');
  });

  it('attaches a SWAP_REQUIRES_TWO_SLOTS code when both slots exist but one is unbound', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    createSlot(state, 'left', new VoltraClient());
    let caught: unknown;
    try {
      swapSlots(state);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('SWAP_REQUIRES_TWO_SLOTS');
  });

  // F1 / VMCP-01.18: explicit left+right with the bootstrap primary
  // placeholder unconnected must succeed (count is over CONNECTED slots, not
  // all entries in state.slots).
  it('swaps left↔right when an unconnected bootstrap primary is also present', () => {
    const state = makeStateWithPrimary();
    const leftClient = connectedClient();
    const rightClient = connectedClient();
    createSlot(state, 'left', leftClient);
    createSlot(state, 'right', rightClient);
    expect(state.slots.size).toBe(3);

    swapSlots(state);

    expect(getSlot(state, 'left').client).toBe(rightClient);
    expect(getSlot(state, 'right').client).toBe(leftClient);
    // The unconnected primary is untouched by the swap.
    expect(getSlot(state, PRIMARY_SLOT).client.isConnected).toBe(false);
  });

  it('rejects with "found 0 connected" when no slot is connected', () => {
    const state = makeStateWithPrimary();
    let caught: unknown;
    try {
      swapSlots(state);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/found 0 connected/);
    expect((caught as { code?: string }).code).toBe('SWAP_REQUIRES_TWO_SLOTS');
  });

  it('rejects with "found 1 connected" when only one slot is connected', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    createSlot(state, 'left', new VoltraClient());
    let caught: unknown;
    try {
      swapSlots(state);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/found 1 connected/);
    expect((caught as { code?: string }).code).toBe('SWAP_REQUIRES_TWO_SLOTS');
  });

  it('is idempotent — two consecutive swaps return to the original mapping', () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    const leftClient = connectedClient();
    createSlot(state, 'left', leftClient);
    const originalPrimaryClient = getSlot(state, PRIMARY_SLOT).client;
    const originalLeftClient = getSlot(state, 'left').client;

    swapSlots(state);
    swapSlots(state);

    expect(getSlot(state, PRIMARY_SLOT).client).toBe(originalPrimaryClient);
    expect(getSlot(state, 'left').client).toBe(originalLeftClient);
  });

  it('unwires both bridges before the swap and re-wires after (no listeners on stale handles)', async () => {
    const state = makeStateWithPrimary({ primaryConnected: true });
    const { wireBridgeForSlot } = await import('../event-bridge.js');
    const wireMock = wireBridgeForSlot as unknown as ReturnType<typeof vi.fn>;
    // Track the unwire fns each `wireBridgeForSlot` invocation hands back so
    // we can assert they fire when swapSlots tears the old bridge down.
    const unwireCalls: string[] = [];
    let counter = 0;
    wireMock.mockImplementation(() => {
      const id = `unwire-${++counter}`;
      return vi.fn(() => {
        unwireCalls.push(id);
      });
    });
    // Primary already has its placeholder unwire from the earlier `vi.fn`
    // mock at module load — replace it with a tracked one so assertions are
    // about the bridge tear-down behavior of swapSlots itself.
    const primary = getSlot(state, PRIMARY_SLOT);
    primary.unwireBridge = vi.fn(() => {
      unwireCalls.push('unwire-primary-pre');
    });
    const leftClient = connectedClient();
    // createSlot will pull a fresh tracked unwire (`unwire-1` from the
    // counter above, since the wireMock replacement is now in effect).
    createSlot(state, 'left', leftClient);

    wireMock.mockClear();
    swapSlots(state);

    // Both pre-swap unwires fired.
    expect(unwireCalls).toContain('unwire-primary-pre');
    expect(unwireCalls).toContain('unwire-1');
    // Bridge re-wired exactly once per slot.
    expect(wireMock).toHaveBeenCalledTimes(2);
  });
});
