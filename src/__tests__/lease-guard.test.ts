// Lease enforcement across two live connections (VMCP-01.61).
//
// write-lease.test.ts covers the lease algebra in isolation. This file covers
// the part that can only break in the wiring: that WRITE tools are actually
// wrapped, READ tools actually are not, and the `system.lease_*` trio stays
// callable without the lease.
//
// Mock adapter + throwaway SQLite, so no radio and no shared DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClientConnection,
  __resetClientIdSequence,
  type ClientConnection,
} from '../client-connection.js';
import { loadConfig } from '../config.js';
import { bootstrapState, isDeviceEngaged, type ServerState } from '../state/server-state.js';
import { LEASE_EXEMPT_TOOLS } from '../lease-guard.js';
import { TOOL_ACCESS, toolAccess, type ToolName } from '../tool-registry.js';

let dbDir: string;
let state: ServerState;
let a: ClientConnection;
let b: ClientConnection;
const savedEnv = { ...process.env };

/** Invoke a tool on a connection the way the SDK would. */
async function call(
  connection: ClientConnection,
  name: string,
  args: unknown = {},
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const tool = connection.placeholders.get(name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  const handler = tool.handler as (args: unknown, extra: unknown) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
  const result = await handler(args, {});
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

beforeEach(async () => {
  __resetClientIdSequence();
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-lease-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'lease.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  state = await bootstrapState(loadConfig());
  a = createClientConnection('client-a');
  b = createClientConnection('client-b');
  a.activate(state);
  b.activate(state);
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * Put slot `primary` into a live-set state, CONNECTED, and give the lease to
 * `connection`.
 *
 * The set is installed directly rather than by driving `set.start`, which
 * needs a real device. But the slot must report connected, or `surrenderDevice`
 * skips the unload arm entirely and the test silently covers half the code.
 */
async function startSetOn(connection: ClientConnection): Promise<void> {
  state.lease.tryAcquire(connection.clientId);
  const slot = state.slots.get('primary')!;
  fakeClientState(slot, { connected: true, guidedLoadPhase: 'idle' });
  await state.store.putSession({
    id: 'session-1',
    startedAt: new Date().toISOString(),
    exerciseId: 'bench-press',
  } as never);
  slot.live.startSession({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    exerciseId: 'bench-press',
    setIds: [],
  });
  slot.live.startSet({
    setId: 'set-1',
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    reps: [],
    status: 'active',
  });
}

describe('write tools', () => {
  it('acquires implicitly for the first caller', async () => {
    const result = await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });
    expect(result.isError).toBe(false);
    expect(state.lease.isHeldBy('client-a')).toBe(true);
  });

  it('refuses a second client with an actionable error', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const denied = await call(b, 'timer.start', { durationMs: 60000, label: 'rest' });

    expect(denied.isError).toBe(true);
    expect(denied.payload.code).toBe('LEASE_HELD');
    // The model relays this verbatim, so it must name the holder AND the exit.
    const message = String(denied.payload.message);
    expect(message).toContain('client-a');
    expect(message).toContain('system.lease_acquire');
    expect(message).toContain('force');
  });

  it('does not leak the lease to the loser', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });
    await call(b, 'timer.start', { durationMs: 60000, label: 'rest' });
    expect(state.lease.isHeldBy('client-a')).toBe(true);
  });
});

describe('read tools', () => {
  it('work for a client holding no lease', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const health = await call(b, 'server.health');

    expect(health.isError).toBe(false);
    expect(health.payload.leaseHeldBy).toBe('client-a');
  });

  it('never acquire the lease as a side effect', async () => {
    await call(b, 'server.health');
    await call(b, 'session.list', {});
    expect(state.lease.status()).toBeNull();
  });
});

describe('the lease tools themselves', () => {
  it('report the caller-relative view', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    expect((await call(a, 'system.lease_status')).payload).toMatchObject({
      self: 'client-a',
      heldByYou: true,
    });
    expect((await call(b, 'system.lease_status')).payload).toMatchObject({
      self: 'client-b',
      heldByYou: false,
    });
  });

  it('refuse an unforced acquire but stay callable', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const result = await call(b, 'system.lease_acquire', {});

    // Callable without the lease — refusal is in the payload, not an error.
    expect(result.isError).toBe(false);
    expect(result.payload.acquired).toBe(false);
    expect(state.lease.isHeldBy('client-a')).toBe(true);
  });

  it('transfer on a forced acquire', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const result = await call(b, 'system.lease_acquire', { force: true });

    expect(result.payload).toMatchObject({ acquired: true, forced: true, takenFrom: 'client-a' });
    expect(state.lease.isHeldBy('client-b')).toBe(true);
    // And the loser is genuinely locked out afterwards.
    expect((await call(a, 'timer.start', { durationMs: 60000, label: 'rest' })).payload.code).toBe('LEASE_HELD');
  });

  it('release, freeing the device for the other client', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    expect((await call(a, 'system.lease_release')).payload.released).toBe(true);
    expect(state.lease.status()).toBeNull();
    expect((await call(b, 'timer.start', { durationMs: 60000, label: 'rest' })).isError).toBe(false);
  });
});

/**
 * Assert a call was not refused by the lease AT ALL.
 *
 * `.not.toBe('LEASE_HELD')` is not enough — it passes for LEASE_HELD_ENGAGED
 * and LEASE_TRANSFERRING, so it stays green with the exemption removed. Match
 * the whole family.
 */
function expectNotLeaseRefused(payload: Record<string, unknown>, what: string): void {
  const code = String(payload.code ?? '');
  expect(code.startsWith('LEASE_'), `${what} was refused by the lease: ${code}`).toBe(false);
}

/** Make this slot's unload fail, so the surrender cannot drop the load. */
function breakUnload(slot: { client: unknown }): void {
  Object.defineProperty(slot.client, 'unloadDevice', {
    value: () => Promise.reject(new Error('radio wedged')),
    configurable: true,
  });
}

/** Override the SDK client's connection/guided-load getters for one test. */
function fakeClientState(
  slot: { client: unknown },
  opts: { connected: boolean; guidedLoadPhase: string; rowing?: boolean },
): void {
  Object.defineProperty(slot.client, 'isConnected', {
    get: () => opts.connected,
    configurable: true,
  });
  Object.defineProperty(slot.client, 'guidedLoadState', {
    get: () => ({ phase: opts.guidedLoadPhase }),
    configurable: true,
  });
  Object.defineProperty(slot.client, 'isRowingActive', {
    get: () => opts.rowing === true,
    configurable: true,
  });
}

describe('surrendering the device on transfer', () => {
it('finalizes the victim set on a forced steal, not just the load', async () => {
    // A bare unload leaves slot.live.set active, which (a) makes the stealer's
    // set.start throw SET_ALREADY_ACTIVE, (b) pins the new lease forever, and
    // (c) strands the victim's reps unpersisted because set.end is now denied.
    await startSetOn(a);
    expect(state.slots.get('primary')!.live.snapshotSet()).toBeDefined();

    await call(b, 'system.lease_acquire', { force: true });

    expect(state.slots.get('primary')!.live.snapshotSet()).toBeUndefined();
    // `snapshotSet()` clears BEFORE the store write, so asserting only that
    // would pass even if finalizeSet threw on its way to persistence — and
    // consequence (c), the lost reps, is the whole reason this code exists.
    expect(await state.store.getSet('set-1')).toBeDefined();
  });

  it('surrenders on an explicit release too', async () => {
    await startSetOn(a);

    await call(a, 'system.lease_release');

    expect(state.slots.get('primary')!.live.snapshotSet()).toBeUndefined();
    expect(await state.store.getSet('set-1')).toBeDefined();
  });

  it('surrenders when the holder disconnects mid-set', async () => {
    // stdio pipes drop routinely (VMCP-01.25/F11), so this is the ordinary
    // path. Releasing without surrendering would hand B a loaded cable and
    // lose A's reps.
    await startSetOn(a);

    await a.close(state);

    expect(state.slots.get('primary')!.live.snapshotSet()).toBeUndefined();
    expect(await state.store.getSet('set-1')).toBeDefined();
    expect(state.lease.status()).toBeNull();
  });

  it('waits for an in-flight set.start, then finalizes the set it installs', async () => {
    // set.start engages the motor and installs the set only after the BLE
    // round-trip. Surrendering inside that window finalizes nothing, and the
    // caller's continuation then installs an active set on a device it no
    // longer owns — re-orphaning what surrender exists to prevent.
    state.lease.tryAcquire('client-a');
    const slot = state.slots.get('primary')!;
    fakeClientState(slot, { connected: true, guidedLoadPhase: 'idle' });
    await state.store.putSession({
      id: 'session-1',
      startedAt: new Date().toISOString(),
      exerciseId: 'bench-press',
    } as never);
    slot.live.startSession({
      sessionId: 'session-1',
      startedAt: new Date().toISOString(),
      exerciseId: 'bench-press',
      setIds: [],
    });
    slot.setStartInFlight = true;

    const steal = call(b, 'system.lease_acquire', { force: true });

    // Simulate set.start's continuation landing mid-steal.
    await new Promise((r) => setTimeout(r, 30));
    slot.live.startSet({
      setId: 'set-1',
      sessionId: 'session-1',
      startedAt: new Date().toISOString(),
      reps: [],
      status: 'active',
    });
    slot.setStartInFlight = false;

    await steal;

    // The late-installed set was finalized and persisted, not orphaned.
    expect(slot.live.snapshotSet()).toBeUndefined();
    expect(await state.store.getSet('set-1')).toBeDefined();
  });

  it('REFUSES a forced steal when nothing could be unloaded', async () => {
    // The branch that decides whether a possibly-loaded device changes hands.
    await startSetOn(a);
    breakUnload(state.slots.get('primary')!);

    const result = await call(b, 'system.lease_acquire', { force: true });

    expect(result.payload.acquired).toBe(false);
    // The old holder keeps it — a refusal must not half-transfer.
    expect(state.lease.isHeldBy('client-a')).toBe(true);
    expect(String(result.payload.warning)).toContain('MAY STILL BE LOADED');
  });

  it('transfers anyway once the caller accepts a possibly-loaded device', async () => {
    await startSetOn(a);
    breakUnload(state.slots.get('primary')!);

    const result = await call(b, 'system.lease_acquire', {
      force: true,
      acceptLoadedDevice: true,
    });

    expect(result.payload.acquired).toBe(true);
    expect(state.lease.isHeldBy('client-b')).toBe(true);
    // Still told, not silently reassured.
    expect(String(result.payload.warning)).toContain('may still be loaded');
  });

  it('reports the per-slot outcome so the model can relay it', async () => {
    await startSetOn(a);
    breakUnload(state.slots.get('primary')!);

    const result = await call(b, 'system.lease_acquire', {
      force: true,
      acceptLoadedDevice: true,
    });

    const slots = result.payload.surrender as Array<Record<string, unknown>>;
    const primary = slots.find((entry) => entry.slotId === 'primary')!;
    expect(primary.unloaded).toBe(false);
    expect(String(primary.error)).toContain('unload');
  });

  it('does not touch the device when releasing an idle lease', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const result = await call(a, 'system.lease_release');

    expect(result.payload.released).toBe(true);
    expect(result.payload.surrender).toBeUndefined();
  });
});

describe('freezing the lease during a handover', () => {
  it('denies the OUTGOING holder while the device is being surrendered', async () => {
    // The window is seconds of BLE work. If the victim keeps write access it
    // can re-engage the motor after the surrender unloaded, and the incoming
    // client is handed a lease over a device it believes is slack.
    await startSetOn(a);
    state.lease.beginTransfer();

    const denied = await call(a, 'device.set_weight', { weightLbs: 100 });

    expect(denied.payload.code).toBe('LEASE_TRANSFERRING');
    expect(String(denied.payload.message)).toContain('mid-handover');
  });

  it('still lets ANY client stop the machine while frozen', async () => {
    await startSetOn(a);
    state.lease.beginTransfer();

    // The exempt, load-reducing tools must never wait on arbitration.
    expectNotLeaseRefused((await call(b, 'device.unload', {})).payload, 'device.unload');
    expectNotLeaseRefused(
      (await call(b, 'device.exit_guided_load', {})).payload,
      'device.exit_guided_load',
    );
  });

  it('refuses a second concurrent takeover instead of double-stealing', async () => {
    await startSetOn(a);
    state.lease.beginTransfer();

    const second = await call(b, 'system.lease_acquire', { force: true });

    expect(second.payload.acquired).toBe(false);
    expect(state.lease.isTransferring()).toBe(true);
  });

  it('a disconnecting client does not unfreeze someone else\'s handover', async () => {
    // close() must not call abortTransfer() when it did not begin the
    // transfer: doing so unfreezes the other client's in-flight surrender and
    // reopens the window the freeze exists to close.
    // The real shape: A holds an engaged lease, B begins a forced takeover,
    // and A's pipe drops mid-surrender. A's close() must leave B's freeze
    // alone. Closing a NON-holder would prove nothing — close() skips the
    // whole block unless this client holds the lease.
    await startSetOn(a);
    expect(state.lease.isHeldBy('client-a')).toBe(true);
    state.lease.beginTransfer();

    await a.close(state);

    expect(state.lease.isTransferring()).toBe(true);
  });

  it('restores the previous holder when a takeover is refused', async () => {
    await startSetOn(a);
    breakUnload(state.slots.get('primary')!);

    await call(b, 'system.lease_acquire', { force: true });

    expect(state.lease.isTransferring()).toBe(false);
    expect(state.lease.isHeldBy('client-a')).toBe(true);
    // And normal service resumes for the holder that kept it.
    expect((await call(a, 'timer.start', { durationMs: 1000, label: 'x' })).isError).toBe(false);
  });
});

describe('stopping the machine without the lease', () => {
  it('lets a non-holder unload', async () => {
    // A second session must be able to stop a machine someone is attached to
    // without first winning an arbitration round.
    await startSetOn(a);

    expectNotLeaseRefused((await call(b, 'device.unload', {})).payload, 'device.unload');
  });

  it('still gates disconnect, which removes control rather than load', async () => {
    // Dropping the BLE link does not drop the load — it strands it.
    await startSetOn(a);

    expect((await call(b, 'device.disconnect', {})).payload.code).toBe('LEASE_HELD_ENGAGED');
  });
});

describe('the pin', () => {
  it('pins on a set-start still mid-flight', () => {
    // set.start engages the motor BEFORE installing the active set, so an
    // active-set-only pin leaves a loaded cable unpinned for the length of a
    // BLE round-trip.
    const slot = state.slots.get('primary')!;
    expect(isDeviceEngaged(state)).toBe(false);

    slot.setStartInFlight = true;
    expect(isDeviceEngaged(state)).toBe(true);

    slot.setStartInFlight = false;
    expect(isDeviceEngaged(state)).toBe(false);
  });

  it('pins while guided load holds the cable, with no set active', () => {
    // Guided load keeps the cable hot without ever creating a set.
    // `isConnected` is a getter on VoltraClient, hence defineProperty.
    const slot = state.slots.get('primary')!;
    fakeClientState(slot, { connected: true, guidedLoadPhase: 'active' });

    expect(slot.live.snapshotSet()).toBeUndefined();
    expect(isDeviceEngaged(state)).toBe(true);
  });

  it('pins while rowing keeps the cable hot', () => {
    const slot = state.slots.get('primary')!;
    fakeClientState(slot, { connected: true, guidedLoadPhase: 'idle', rowing: true });
    expect(isDeviceEngaged(state)).toBe(true);
  });

  it('does not pin a connected but idle slot', () => {
    // The negative control for the two positives above: without it, a pin that
    // always returned true would pass every other test in this block.
    const slot = state.slots.get('primary')!;
    fakeClientState(slot, { connected: true, guidedLoadPhase: 'idle' });
    expect(isDeviceEngaged(state)).toBe(false);
  });

  it('does not pin a disconnected slot', () => {
    const slot = state.slots.get('primary')!;
    fakeClientState(slot, { connected: false, guidedLoadPhase: 'active' });

    expect(isDeviceEngaged(state)).toBe(false);
  });
});

describe('disconnect', () => {
  it('releases the lease when the holder goes away', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });
    expect(state.lease.isHeldBy('client-a')).toBe(true);

    await a.close(state);

    // Otherwise a crashed session strands the device until the idle timeout.
    expect(state.lease.status()).toBeNull();
    expect((await call(b, 'timer.start', { durationMs: 60000, label: 'rest' })).isError).toBe(false);
  });

  it('does not disturb a lease held by someone else', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    await b.close(state);

    expect(state.lease.isHeldBy('client-a')).toBe(true);
  });
});

describe('guard coverage', () => {
  it('wraps every gated write tool and no read tool', async () => {
    // Rather than trusting the wiring, take the lease for A and assert that
    // calling each tool from B is refused iff it is a gated write. This is the
    // test that would catch a tool registered after applyLeaseGuard runs.
    state.lease.tryAcquire('client-a');

    const notGated: string[] = [];
    const wronglyGated: string[] = [];
    for (const name of Object.keys(TOOL_ACCESS) as ToolName[]) {
      if (!b.placeholders.has(name)) continue; // mock-only tools in node mode
      const gated = toolAccess(name) === 'write' && !LEASE_EXEMPT_TOOLS.has(name);
      // Deliberately invalid args: a gated tool must refuse on the LEASE before
      // it ever reaches schema validation, so INVALID_INPUT here means the
      // guard is missing.
      const { payload } = await call(b, name, { __lease_probe__: true });
      const refused = payload.code === 'LEASE_HELD';
      if (gated && !refused) notGated.push(name);
      if (!gated && refused) wronglyGated.push(name);
    }

    expect(notGated, 'write tools reachable without the lease').toEqual([]);
    expect(wronglyGated, 'read tools gated behind the lease').toEqual([]);
  });

  it('leaves the REAL input schema in place when wrapping', () => {
    // `call()` invokes tool.handler directly, bypassing the SDK's schema
    // dispatch — so an INVALID_INPUT there comes from wrapHandler's own zod
    // parse and would still appear with inputSchema wiped. Assert the schema
    // itself, which is the property the SDK actually uses.
    const wrapped = a.placeholders.get('timer.start')!;
    const unwrapped = a.placeholders.get('device.get_state')!;
    expect(wrapped.inputSchema).toBeDefined();
    // A real schema, not the permissive placeholder: it must know its fields.
    expect(Object.keys((wrapped.inputSchema as { shape: object }).shape)).toContain('durationMs');
    expect(unwrapped.inputSchema).toBeDefined();
  });
});
