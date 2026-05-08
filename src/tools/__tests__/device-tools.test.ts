// Unit tests for `device.*` tools (Wave 3A, Task 10).
//
// Strategy: build a fake `VoltraManager` + `VoltraClient` shaped just for the
// surface that `registerDeviceTools` consumes. The MCP server is replaced
// with a minimal fake whose `tool()` records placeholder registrations so we
// can fish out the swapped-in real callbacks. This keeps the test free of
// the @voltras/node-sdk runtime (and its optional native peers).
//
// AC anchors:
// - AC-26: `device.get_state` reads from client.isConnected, connectionState,
//   settings, connectedDeviceId; output never carries a raw enum number.
// - EC-05: `device.set_mode` with `Idle` → INVALID_INPUT.
// - AC-14: no `noble`/`webbluetooth` imports in src/tools/.
// - Critic FIX #9 reflected here: `device.scan` passes a ScanOptions OBJECT
//   to `manager.scan`, never a bare number. The live SDK's `ScanOptions`
//   uses `timeout` (the briefing/critic prose said `timeoutMs`, which was a
//   typo against the actual SDK shape — see report.md deviation note); the
//   tests assert the actual SDK property.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub the SDK to keep test runs free of native peers. We need:
// - `TrainingMode` (enum object, both name→num and num→name) for Idle
//   filtering and forward/reverse mapping in the device-tools handler.
// - `VoltraSDKError` for the errors module's instanceof check.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

const FakeTrainingMode = {
  Idle: 0,
  WeightTraining: 1,
  ResistanceBand: 2,
  Rowing: 3,
  Damper: 4,
  CustomCurves: 6,
  Isokinetic: 7,
  Isometric: 8,
  // Reverse mapping (TS enum behaviour).
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  3: 'Rowing',
  4: 'Damper',
  6: 'CustomCurves',
  7: 'Isokinetic',
  8: 'Isometric',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
  // Stubbed for `resetPrimarySlot`, which constructs a fresh placeholder
  // client when an actually-connected primary slot disconnects (Step 3 of
  // dual-Voltras). The body is unused — the production helper only needs
  // a constructable shape, and the slot reference goes stale immediately
  // after disconnect anyway.
  VoltraClient: class {},
}));

// Stub the per-slot event-bridge wirer used by `slot-manager` and the
// primary-rebind branch of `device.connect`. The device-tools tests don't
// observe channel/publisher behavior — only slot-map and SDK call-shape
// invariants — so a no-op wirer keeps the fake state minimal.
vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { registerDeviceTools } = await import('../device-tools.js');

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeSettings {
  weight: number;
  chains: number;
  inverseChains: number;
  eccentric: number;
  mode: number;
  battery: number | null;
  damperLevel?: number;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'authenticating' | 'connected';
  connectedDeviceId: string | null;
  settings: FakeSettings;
  setAdapter: Mock<(adapter: unknown) => void>;
  connect: Mock<(device: unknown) => Promise<void>>;
  disconnect: Mock<() => Promise<void>>;
  setWeight: Mock<(lbs: number) => Promise<void>>;
  setMode: Mock<(mode: number) => Promise<void>>;
  setChains: Mock<(lbs: number) => Promise<void>>;
  setEccentric: Mock<(percent: number) => Promise<void>>;
  setDamperLevel: Mock<(level: number) => Promise<void>>;
  setAssistMode: Mock<(mode: 'off' | 'on') => Promise<void>>;
  setBandMaxForce: Mock<(lbs: number) => Promise<void>>;
  setIsokineticTargetSpeed: Mock<(mmPerSec: number) => Promise<void>>;
  setIsokineticEccMode: Mock<(mode: 'isokinetic' | 'constant') => Promise<void>>;
  setIsokineticEccSpeedLimit: Mock<(mmPerSec: number) => Promise<void>>;
  setIsokineticEccConstWeight: Mock<(lbs: number) => Promise<void>>;
  setIsokineticEccOverloadWeight: Mock<(lbs: number) => Promise<void>>;
  startGuidedLoad: Mock<
    (opts: {
      targetWeightLbs: number;
      pollIntervalMs?: number;
      pollDurationMs?: number;
    }) => Promise<void>
  >;
  // <Bug-22>
  enterRowMode: Mock<() => Promise<void>>;
  startRow: Mock<(distance?: string) => Promise<void>>;
  isRowingActive: boolean;
  // </Bug-22>
  onPerRep: Mock<(cb: (event: unknown) => void) => void>;
  onInProgress: Mock<(cb: (event: unknown) => void) => void>;
  onSummary: Mock<(cb: (event: unknown) => void) => void>;
  onPreSummary: Mock<(cb: (event: unknown) => void) => void>;
  onSettingsUpdate: Mock<(cb: (settings: unknown) => void) => void>;
  onConnectionStateChange: Mock<(cb: (state: unknown) => void) => void>;
  onFrame: Mock<(cb: (frame: unknown) => void) => void>;
}

interface FakeManager {
  devices: Array<{ id: string; name: string | null; rssi: number | null }>;
  scan: Mock<(opts?: { timeout?: number; filterVoltra?: boolean }) => Promise<unknown[]>>;
  connect: Mock<(device: unknown) => Promise<FakeClient>>;
  disconnect: Mock<(deviceId: string) => Promise<void>>;
  isConnected: Mock<(deviceId: string) => boolean>;
}

function makeFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    isConnected: false,
    connectionState: 'disconnected',
    connectedDeviceId: null,
    settings: {
      weight: 5,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.Idle,
      battery: null,
    },
    setAdapter: vi.fn(() => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    setWeight: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    setChains: vi.fn(async () => undefined),
    setEccentric: vi.fn(async () => undefined),
    setDamperLevel: vi.fn(async () => undefined),
    setAssistMode: vi.fn(async () => undefined),
    setBandMaxForce: vi.fn(async () => undefined),
    setIsokineticTargetSpeed: vi.fn(async () => undefined),
    setIsokineticEccMode: vi.fn(async () => undefined),
    setIsokineticEccSpeedLimit: vi.fn(async () => undefined),
    setIsokineticEccConstWeight: vi.fn(async () => undefined),
    setIsokineticEccOverloadWeight: vi.fn(async () => undefined),
    startGuidedLoad: vi.fn(async () => undefined),
    // <Bug-22>
    enterRowMode: vi.fn(async () => undefined),
    startRow: vi.fn(async () => undefined),
    isRowingActive: false,
    // </Bug-22>
    onPerRep: vi.fn(() => undefined),
    onInProgress: vi.fn(() => undefined),
    onSummary: vi.fn(() => undefined),
    onPreSummary: vi.fn(() => undefined),
    onSettingsUpdate: vi.fn(() => undefined),
    onConnectionStateChange: vi.fn(() => undefined),
    onFrame: vi.fn(() => undefined),
    ...overrides,
  };
}

function makeFakeManager(): FakeManager {
  return {
    devices: [],
    scan: vi.fn(async () => []),
    connect: vi.fn(async () => makeFakeClient()),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => false),
  };
}

// ── Fake McpServer + placeholder registry ────────────────────────────────

interface RecordedTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

interface FakeServer {
  tool: Mock<(name: string, ...rest: unknown[]) => RecordedTool>;
}

function makeFakeServer(): FakeServer {
  const tool = vi.fn((_name: string, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as RecordedTool['callback'];
    const reg: RecordedTool = {
      callback: cb,
      update: vi.fn((updates) => {
        if (updates.callback) {
          reg.callback = updates.callback;
        }
      }),
    };
    return reg;
  });
  return { tool };
}

function buildPlaceholderMap(server: FakeServer, names: string[]): Map<string, RecordedTool> {
  const placeholders = new Map<string, RecordedTool>();
  const stub = (): unknown => ({
    content: [{ type: 'text', text: '{"code":"STARTING"}' }],
    isError: true,
  });
  for (const name of names) {
    placeholders.set(name, server.tool(name, stub));
  }
  return placeholders;
}

const DEVICE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.set_damper_level',
  'device.set_assist_mode',
  'device.set_band_max_force',
  'device.set_isokinetic_target_speed',
  'device.set_isokinetic_ecc_mode',
  'device.set_isokinetic_ecc_speed_limit',
  'device.set_isokinetic_ecc_const_weight',
  'device.set_isokinetic_ecc_overload_weight',
  'device.start_guided_load',
  // <Bug-22>
  'device.enter_row_mode',
  'device.start_row',
  // </Bug-22>
  'device.get_state',
  'device.send_raw',
] as const;

interface FakeLive {
  snapshotDevice: () => {
    connected: boolean;
    deviceId?: string;
    weightLbs?: number;
    trainingMode?: string;
    batteryPercent?: number;
    damperLevel?: number;
    chainSettingLbs?: number;
    assistMode?: number;
    trainingModeRaw?: number;
    chainTargetForceTenths?: number;
    weightLbsTenths?: number;
    eccentricPercentTenths?: number;
    staleSinceDisconnect?: string;
    isStale?: boolean;
    disconnectedAt?: string;
  };
  markDisconnected: (at: string) => void;
}

interface FakeSlot {
  slotId: string;
  client: FakeClient;
  live: FakeLive;
}

interface State {
  manager: FakeManager;
  slots: Map<string, FakeSlot>;
}

function makeFakeLive(overrides: Partial<ReturnType<FakeLive['snapshotDevice']>> = {}): FakeLive {
  return {
    snapshotDevice: () => ({ connected: false, ...overrides }),
    markDisconnected: vi.fn(),
  };
}

function makeState(): State {
  const slots = new Map<string, FakeSlot>();
  slots.set('primary', { slotId: 'primary', client: makeFakeClient(), live: makeFakeLive() });
  return {
    manager: makeFakeManager(),
    slots,
  };
}

/**
 * Convenience accessor — every test was written against a flat `state.client`
 * before Step 1 of dual-Voltras introduced slots. Returning the primary slot's
 * client keeps the test bodies single-line without re-implementing the
 * production `getSlot` helper.
 */
function primaryClient(state: State): FakeClient {
  return state.slots.get('primary')!.client;
}

// Helper: invoke a registered tool and parse the result envelope.
async function invoke(
  reg: RecordedTool,
  args: unknown,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const result = (await reg.callback(args)) as {
    isError?: boolean;
    content: Array<{ type: 'text'; text: string }>;
  };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('registerDeviceTools', () => {
  let state: State;
  let server: FakeServer;
  let placeholders: Map<string, RecordedTool>;

  beforeEach(() => {
    state = makeState();
    server = makeFakeServer();
    placeholders = buildPlaceholderMap(server, [...DEVICE_TOOL_NAMES]);
    registerDeviceTools(
      server as unknown as Parameters<typeof registerDeviceTools>[0],
      state as unknown as Parameters<typeof registerDeviceTools>[1],
      placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
    );
  });

  it('swaps in real handlers via placeholder.update() for every device tool', () => {
    for (const name of DEVICE_TOOL_NAMES) {
      const reg = placeholders.get(name);
      expect(reg, `placeholder for ${name}`).toBeDefined();
      expect(reg?.update).toHaveBeenCalledWith(
        expect.objectContaining({ callback: expect.any(Function) }),
      );
    }
  });

  describe('device.scan', () => {
    it('passes the timeout to manager.scan as a ScanOptions object (critic FIX #9)', async () => {
      state.manager.scan.mockResolvedValueOnce([{ id: 'V-1', name: 'Voltra-1', rssi: -45 }]);
      const reg = placeholders.get('device.scan')!;
      const { isError, payload } = await invoke(reg, { timeoutMs: 2000 });
      expect(isError).toBeUndefined();
      expect(state.manager.scan).toHaveBeenCalledTimes(1);
      const opts = state.manager.scan.mock.calls[0][0];
      // Object shape — neither a bare number nor undefined.
      expect(typeof opts).toBe('object');
      expect(opts).not.toBeNull();
      expect((opts as { timeout?: number }).timeout).toBe(2000);
      // Returned device list serialized as-is (id/name/rssi from scan).
      expect(payload).toEqual({
        devices: [{ id: 'V-1', name: 'Voltra-1', rssi: -45 }],
      });
    });

    it('defaults timeout to 10000ms when input omits timeoutMs', async () => {
      state.manager.scan.mockResolvedValueOnce([]);
      const reg = placeholders.get('device.scan')!;
      await invoke(reg, {});
      const opts = state.manager.scan.mock.calls[0][0];
      expect((opts as { timeout?: number }).timeout).toBe(10000);
    });

    it('rejects timeoutMs below the 1000ms floor with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.scan')!;
      const { isError, payload } = await invoke(reg, { timeoutMs: 500 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(state.manager.scan).not.toHaveBeenCalled();
    });
  });

  describe('device.connect', () => {
    it('returns ok:true on success after locating the device by id from manager.devices', async () => {
      state.manager.devices = [{ id: 'V-1', name: 'Voltra-1', rssi: -50 }];
      const connected = makeFakeClient({
        isConnected: true,
        connectionState: 'connected',
        connectedDeviceId: 'V-1',
      });
      state.manager.connect.mockResolvedValueOnce(connected);
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true, deviceId: 'V-1' });
      // Handler must hand the DiscoveredDevice (not a bare string) to manager.connect.
      expect(state.manager.connect).toHaveBeenCalledWith({
        id: 'V-1',
        name: 'Voltra-1',
        rssi: -50,
      });
    });

    it('returns DEVICE_NOT_FOUND when the deviceId is absent from the last scan', async () => {
      state.manager.devices = [{ id: 'V-2', name: null, rssi: null }];
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('DEVICE_NOT_FOUND');
      expect(state.manager.connect).not.toHaveBeenCalled();
    });

    it('returns ALREADY_CONNECTED when the primary slot client is already connected (EC-08)', async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectedDeviceId = 'V-existing';
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('ALREADY_CONNECTED');
      expect(state.manager.connect).not.toHaveBeenCalled();
    });

    it('maps a thrown VoltraSDKError to its code (CONNECTION_LOST)', async () => {
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      state.manager.connect.mockRejectedValueOnce(
        new FakeVoltraSDKError('lost mid-handshake', 'CONNECTION_LOST'),
      );
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('CONNECTION_LOST');
    });
  });

  describe('device.disconnect', () => {
    it('calls manager.disconnect for the active deviceId and returns ok:true', async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectedDeviceId = 'V-1';
      const reg = placeholders.get('device.disconnect')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.manager.disconnect).toHaveBeenCalledWith('V-1');
    });

    it('is a graceful no-op when nothing is connected', async () => {
      const reg = placeholders.get('device.disconnect')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.manager.disconnect).not.toHaveBeenCalled();
    });
  });

  // ── Slot lifecycle (Step 3 of dual-Voltras) ───────────────────────────
  //
  // Connect / disconnect cooperating with the slots map. New slot creation
  // is the path that actually exercises `state.slots.size` change; the
  // primary-only path is covered exhaustively above. Bridge fan-out is a
  // Step 4 concern, so these tests do not assert on event delivery.
  describe('device.connect / device.disconnect slot lifecycle', () => {
    it("explicit slot:'left' creates a new slot in state.slots after manager.connect resolves", async () => {
      state.manager.devices = [{ id: 'V-1', name: 'Voltra-1', rssi: -50 }];
      const connected = makeFakeClient({
        isConnected: true,
        connectionState: 'connected',
        connectedDeviceId: 'V-1',
      });
      state.manager.connect.mockResolvedValueOnce(connected);
      const reg = placeholders.get('device.connect')!;

      const { isError, payload } = await invoke(reg, { deviceId: 'V-1', slot: 'left' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true, deviceId: 'V-1' });

      // Slot map now has both 'primary' and 'left'.
      expect(state.slots.size).toBe(2);
      expect(state.slots.has('left')).toBe(true);
      // The new slot's client is the one returned by manager.connect — not
      // the placeholder allocated at bootstrap.
      expect(state.slots.get('left')!.client).toBe(connected as unknown);
    });

    it('connecting twice to the same explicit slot returns ALREADY_CONNECTED', async () => {
      state.manager.devices = [
        { id: 'V-1', name: null, rssi: null },
        { id: 'V-2', name: null, rssi: null },
      ];
      const first = makeFakeClient({
        isConnected: true,
        connectionState: 'connected',
        connectedDeviceId: 'V-1',
      });
      state.manager.connect.mockResolvedValueOnce(first);
      const reg = placeholders.get('device.connect')!;
      await invoke(reg, { deviceId: 'V-1', slot: 'left' });

      const second = await invoke(reg, { deviceId: 'V-2', slot: 'left' });
      expect(second.isError).toBe(true);
      expect(second.payload.code).toBe('ALREADY_CONNECTED');
      // Helpful message names the slot.
      expect(String(second.payload.message)).toMatch(/`left`/);
      // No second manager.connect call.
      expect(state.manager.connect).toHaveBeenCalledTimes(1);
    });

    it('connect with no slot when primary is taken returns ALREADY_CONNECTED with the dual-device hint', async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectedDeviceId = 'V-existing';
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('ALREADY_CONNECTED');
      // Message should hint at the explicit-slot escape hatch.
      expect(String(payload.message)).toMatch(/Primary slot is already connected/i);
      expect(String(payload.message)).toMatch(/explicit `slot`/i);
    });

    it('rejects a third connected slot with SLOT_LIMIT_EXCEEDED (max 2 connected devices)', async () => {
      // Step 4 of dual-Voltras: the cap counts CONNECTED slots, not total
      // map size. Primary's bootstrap stub (`isConnected=false`) is
      // invisible to the cap, so a true bilateral allocation
      // (`'left'` + `'right'`) succeeds. To trip the cap we have to bind
      // primary first (single-device flow) and THEN attempt left + right.
      state.manager.devices = [
        { id: 'V-PRIMARY', name: null, rssi: null },
        { id: 'V-LEFT', name: null, rssi: null },
        { id: 'V-RIGHT', name: null, rssi: null },
      ];
      const reg = placeholders.get('device.connect')!;

      state.manager.connect.mockResolvedValueOnce(
        makeFakeClient({
          isConnected: true,
          connectionState: 'connected',
          connectedDeviceId: 'V-PRIMARY',
        }),
      );
      await invoke(reg, { deviceId: 'V-PRIMARY' });

      state.manager.connect.mockResolvedValueOnce(
        makeFakeClient({
          isConnected: true,
          connectionState: 'connected',
          connectedDeviceId: 'V-LEFT',
        }),
      );
      await invoke(reg, { deviceId: 'V-LEFT', slot: 'left' });

      // primary + left both connected ⇒ the cap is full.
      const third = await invoke(reg, { deviceId: 'V-RIGHT', slot: 'right' });
      expect(third.isError).toBe(true);
      expect(third.payload.code).toBe('SLOT_LIMIT_EXCEEDED');
      expect(state.slots.has('right')).toBe(false);
    });

    it('allows two non-primary slots when primary is idle (true bilateral)', async () => {
      // The bilateral case the cap relaxation was sized for: primary
      // remains in the map (bootstrap leftover) but isConnected=false,
      // so allocating both `'left'` and `'right'` lands two real devices
      // without tripping the cap.
      state.manager.devices = [
        { id: 'V-LEFT', name: null, rssi: null },
        { id: 'V-RIGHT', name: null, rssi: null },
      ];
      const reg = placeholders.get('device.connect')!;

      state.manager.connect.mockResolvedValueOnce(
        makeFakeClient({
          isConnected: true,
          connectionState: 'connected',
          connectedDeviceId: 'V-LEFT',
        }),
      );
      const r1 = await invoke(reg, { deviceId: 'V-LEFT', slot: 'left' });
      expect(r1.isError).toBeUndefined();

      state.manager.connect.mockResolvedValueOnce(
        makeFakeClient({
          isConnected: true,
          connectionState: 'connected',
          connectedDeviceId: 'V-RIGHT',
        }),
      );
      const r2 = await invoke(reg, { deviceId: 'V-RIGHT', slot: 'right' });
      expect(r2.isError).toBeUndefined();
      expect(state.slots.has('left')).toBe(true);
      expect(state.slots.has('right')).toBe(true);
    });

    it("disconnecting an explicit 'left' slot removes it from state.slots", async () => {
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      const connected = makeFakeClient({
        isConnected: true,
        connectionState: 'connected',
        connectedDeviceId: 'V-1',
      });
      state.manager.connect.mockResolvedValueOnce(connected);
      await invoke(placeholders.get('device.connect')!, { deviceId: 'V-1', slot: 'left' });
      expect(state.slots.has('left')).toBe(true);

      const r = await invoke(placeholders.get('device.disconnect')!, { slot: 'left' });
      expect(r.isError).toBeUndefined();
      expect(r.payload).toEqual({ ok: true });
      expect(state.manager.disconnect).toHaveBeenCalledWith('V-1');
      // Slot is gone — primary remains.
      expect(state.slots.has('left')).toBe(false);
      expect(state.slots.has('primary')).toBe(true);
    });

    it("disconnecting 'primary' resets the slot in place (does not delete it)", async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectedDeviceId = 'V-1';
      // Capture the SlotState wrapper before reset — `resetPrimarySlot`
      // mutates `slot.client` in place, so reading from the same reference
      // after the reset would see the new client.
      const beforeSlot = state.slots.get('primary');

      const r = await invoke(placeholders.get('device.disconnect')!, { slot: 'primary' });
      expect(r.isError).toBeUndefined();
      expect(r.payload).toEqual({ ok: true });
      expect(state.manager.disconnect).toHaveBeenCalledWith('V-1');
      // Same SlotState wrapper, still present, but the client field has been
      // reset (the BLE-connected client is replaced by a fresh placeholder).
      expect(state.slots.has('primary')).toBe(true);
      expect(state.slots.get('primary')).toBe(beforeSlot);
      // The original `client` was the BLE-connected handle; after reset the
      // slot points at a freshly-constructed VoltraClient stub.
      expect(state.slots.get('primary')!.client).not.toBe(client as unknown);
    });

    it('rejects slot ids with whitespace at the schema layer (INVALID_INPUT)', async () => {
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1', slot: 'left side' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      // Manager is never reached.
      expect(state.manager.connect).not.toHaveBeenCalled();
    });
  });

  describe('device.set_weight', () => {
    it('forwards lbs to client.setWeight and returns ok:true', async () => {
      const reg = placeholders.get('device.set_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setWeight).toHaveBeenCalledWith(50);
    });

    it('rejects out-of-range lbs with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 999 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setWeight).not.toHaveBeenCalled();
    });
  });

  describe('device.set_mode', () => {
    it('maps the enum NAME back to the SDK numeric value before calling setMode', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'WeightTraining' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setMode).toHaveBeenCalledWith(FakeTrainingMode.WeightTraining);
    });

    it('rejects "Idle" with INVALID_INPUT (EC-05) — Idle is not user-selectable', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'Idle' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setMode).not.toHaveBeenCalled();
    });

    it('rejects an unknown mode string with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'TimeMachine' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
    });

    // <Bug-22>
    it('forwards Rowing to client.setMode (which auto-routes via SDK) — never the legacy strength-arm', async () => {
      // Per A10: the SDK's setMode() encapsulates the two-stage entry
      // for Rowing. MCP just forwards the call; SDK handles routing.
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'Rowing' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setMode).toHaveBeenCalledWith(FakeTrainingMode.Rowing);
    });
    // </Bug-22>
  });

  // <Bug-22>
  describe('device.enter_row_mode', () => {
    it('forwards to client.enterRowMode', async () => {
      const reg = placeholders.get('device.enter_row_mode')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).enterRowMode).toHaveBeenCalledTimes(1);
    });

    it('does not invoke setMode or startRow', async () => {
      const reg = placeholders.get('device.enter_row_mode')!;
      await invoke(reg, {});
      expect(primaryClient(state).setMode).not.toHaveBeenCalled();
      expect(primaryClient(state).startRow).not.toHaveBeenCalled();
    });
  });

  describe('device.start_row', () => {
    it('forwards distance to client.startRow', async () => {
      const reg = placeholders.get('device.start_row')!;
      const { isError, payload } = await invoke(reg, { distance: 'M500' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).startRow).toHaveBeenCalledWith('M500');
    });

    it('passes undefined to client.startRow when distance is omitted', async () => {
      const reg = placeholders.get('device.start_row')!;
      await invoke(reg, {});
      expect(primaryClient(state).startRow).toHaveBeenCalledWith(undefined);
    });

    it('rejects unknown distance presets with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.start_row')!;
      const { isError, payload } = await invoke(reg, { distance: 'M999' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).startRow).not.toHaveBeenCalled();
    });
  });
  // </Bug-22>

  describe('device.set_chains', () => {
    it('forwards lbs to client.setChains', async () => {
      const reg = placeholders.get('device.set_chains')!;
      const { isError, payload } = await invoke(reg, { lbs: 25 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setChains).toHaveBeenCalledWith(25);
    });
  });

  describe('device.set_eccentric', () => {
    it('forwards percent to client.setEccentric', async () => {
      const reg = placeholders.get('device.set_eccentric')!;
      const { isError, payload } = await invoke(reg, { percent: -50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setEccentric).toHaveBeenCalledWith(-50);
    });

    it('rejects percent outside [-195, 195] with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_eccentric')!;
      const { isError, payload } = await invoke(reg, { percent: 300 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
    });
  });

  describe('device.get_state (AC-26)', () => {
    // Phase 0.5.2 reshape: device.get_state now reads its substantive fields
    // (deviceId, weightLbs, trainingMode, damperLevel, chainSettingLbs, the
    // cmd=0x07 state-dump fields, batteryPercent) from `live.snapshotDevice()`
    // — the same source `voltra://device/{slot}/current` reads from. Only
    // `connected`, `connectionState`, and `isRowingActive` come from the live
    // client. This keeps the tool aligned with the resource across the
    // disconnect window so callers see preserved last-known values during
    // the soft-reset gap instead of post-cleanup defaults.

    it('composes the response from live.snapshotDevice plus client live state', async () => {
      const slot = state.slots.get('primary')!;
      slot.live = makeFakeLive({
        deviceId: 'V-1',
        weightLbs: 75,
        trainingMode: 'WeightTraining',
        batteryPercent: 80,
      });
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectionState = 'connected';
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );
      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toMatchObject({
        connected: true,
        connectionState: 'connected',
        deviceId: 'V-1',
        weightLbs: 75,
        trainingMode: 'WeightTraining',
        batteryPercent: 80,
      });
      expect(typeof payload.trainingMode).toBe('string');
      // No `rssi` field leaks (no SDK source for connected RSSI).
      expect(payload.rssi).toBeUndefined();
    });

    it('omits batteryPercent when live.snapshotDevice has no battery (FIX #6)', async () => {
      // The bridge's settingsToSnapshot drops null battery; the tool only
      // surfaces values that survived that pass.
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).not.toHaveProperty('batteryPercent');
      expect(payload.batteryPercent).toBeUndefined();
    });

    it('reports disconnected without crashing when no device is connected', async () => {
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.connected).toBe(false);
      expect(payload.connectionState).toBe('disconnected');
      expect(payload.deviceId).toBeUndefined();
    });

    it('surfaces damperLevel from live.snapshotDevice', async () => {
      const slot = state.slots.get('primary')!;
      slot.live = makeFakeLive({ damperLevel: 4 });
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );
      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.damperLevel).toBe(4);
    });

    it('omits damperLevel when live.snapshotDevice has no damperLevel', async () => {
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).not.toHaveProperty('damperLevel');
      expect(payload.damperLevel).toBeUndefined();
    });

    it('returns isRowingActive:false when Rowing two-stage has not completed', async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectionState = 'connected';
      client.isRowingActive = false;
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.isRowingActive).toBe(false);
    });

    it('returns isRowingActive:true when Rowing two-stage has completed', async () => {
      const client = primaryClient(state);
      client.isConnected = true;
      client.connectionState = 'connected';
      client.isRowingActive = true;
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.isRowingActive).toBe(true);
    });

    it('surfaces cmd=0x07 state-dump fields from live.snapshotDevice', async () => {
      // Wire a fake live that returns state-dump fields.
      const slot = state.slots.get('primary')!;
      slot.live = makeFakeLive({
        assistMode: 2,
        trainingModeRaw: 1,
        chainTargetForceTenths: 250,
        weightLbsTenths: 1000,
        eccentricPercentTenths: 50,
      });
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );
      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.assistMode).toBe(2);
      expect(payload.trainingModeRaw).toBe(1);
      expect(payload.chainTargetForceTenths).toBe(250);
      expect(payload.weightLbsTenths).toBe(1000);
      expect(payload.eccentricPercentTenths).toBe(50);
    });

    it('omits state-dump fields when live.snapshotDevice returns them as undefined', async () => {
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      // Default makeFakeLive returns no state-dump fields.
      expect(payload).not.toHaveProperty('assistMode');
      expect(payload).not.toHaveProperty('trainingModeRaw');
      expect(payload).not.toHaveProperty('chainTargetForceTenths');
      expect(payload).not.toHaveProperty('weightLbsTenths');
      expect(payload).not.toHaveProperty('eccentricPercentTenths');
    });

    it('surfaces chainSettingLbs from live.snapshotDevice', async () => {
      const slot = state.slots.get('primary')!;
      slot.live = makeFakeLive({ chainSettingLbs: 50 });
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );
      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.chainSettingLbs).toBe(50);
    });

    it('omits chainSettingLbs when live.snapshotDevice has no chainSettingLbs', async () => {
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).not.toHaveProperty('chainSettingLbs');
    });

    it('returns the same preserved-state values as the resource during the disconnect window (Phase 0.5.2)', async () => {
      // Pre-Phase-0.5.2 the tool read fields off `slot.client.settings`,
      // which the SDK resets to defaults when `resetPrimarySlot` swaps in
      // a fresh client. Meanwhile the resource path served from
      // `live.snapshotDevice()` correctly preserved the last-known values.
      // Both surfaces must agree across the soft-reset window.
      const slot = state.slots.get('primary')!;
      const resourceSnapshot = {
        connected: false,
        deviceId: 'V-097082',
        weightLbs: 75,
        trainingMode: 'WeightTraining',
        damperLevel: 5,
        chainSettingLbs: 23,
        assistMode: 2,
        trainingModeRaw: 1,
        weightLbsTenths: 750,
        chainTargetForceTenths: 230,
        eccentricPercentTenths: 1020,
        staleSinceDisconnect: '2026-05-08T00:00:00.000Z',
        isStale: true,
        disconnectedAt: '2026-05-08T00:00:00.000Z',
      };
      slot.live = makeFakeLive(resourceSnapshot);
      // Simulate the post-soft-reset disconnect window: fresh client with
      // default state, while LiveState retains the preserved snapshot.
      // The tool now reads only `isConnected`/`connectionState`/`isRowingActive`
      // from the client, so `settings` is irrelevant for this case.
      const client = primaryClient(state);
      client.isConnected = false;
      client.connectionState = 'disconnected';
      client.connectedDeviceId = null;
      client.isRowingActive = false;
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );
      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toMatchObject({
        deviceId: 'V-097082',
        weightLbs: 75,
        trainingMode: 'WeightTraining',
        damperLevel: 5,
        chainSettingLbs: 23,
        assistMode: 2,
        trainingModeRaw: 1,
        weightLbsTenths: 750,
        chainTargetForceTenths: 230,
        eccentricPercentTenths: 1020,
        staleSinceDisconnect: '2026-05-08T00:00:00.000Z',
        isStale: true,
        disconnectedAt: '2026-05-08T00:00:00.000Z',
      });
      // Tool-only transients reflect LIVE client state, not the snapshot.
      expect(payload.connected).toBe(false);
      expect(payload.connectionState).toBe('disconnected');
      expect(payload.isRowingActive).toBe(false);
    });
  });

  // ── SDK 0.6.0 mode-config setters ─────────────────────────────────────
  //
  // Each setter tool is a thin passthrough; tests assert the schema gate,
  // the SDK call shape, the structured-error mapping, and (for one setter)
  // slot routing. The MCP schema is intentionally permissive on numeric
  // ranges — the SDK's `InvalidSettingError` is the authoritative gate.

  describe('device.set_damper_level', () => {
    it('forwards level to client.setDamperLevel and returns ok:true', async () => {
      const reg = placeholders.get('device.set_damper_level')!;
      const { isError, payload } = await invoke(reg, { level: 5 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setDamperLevel).toHaveBeenCalledWith(5);
    });

    it('rejects out-of-range level (99) with INVALID_INPUT and never calls SDK', async () => {
      const reg = placeholders.get('device.set_damper_level')!;
      const { isError, payload } = await invoke(reg, { level: 99 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setDamperLevel).not.toHaveBeenCalled();
    });

    it('routes to the slot-specified client (slot:left)', async () => {
      const leftClient = makeFakeClient();
      state.slots.set('left', { slotId: 'left', client: leftClient, live: {} });
      const reg = placeholders.get('device.set_damper_level')!;
      const { isError } = await invoke(reg, { level: 3, slot: 'left' });
      expect(isError).toBeUndefined();
      expect(leftClient.setDamperLevel).toHaveBeenCalledWith(3);
      expect(primaryClient(state).setDamperLevel).not.toHaveBeenCalled();
    });
  });

  describe('device.set_assist_mode', () => {
    it("forwards 'on' to client.setAssistMode and returns ok:true", async () => {
      const reg = placeholders.get('device.set_assist_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'on' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setAssistMode).toHaveBeenCalledWith('on');
    });

    it("forwards 'off' to client.setAssistMode", async () => {
      const reg = placeholders.get('device.set_assist_mode')!;
      const { isError } = await invoke(reg, { mode: 'off' });
      expect(isError).toBeUndefined();
      expect(primaryClient(state).setAssistMode).toHaveBeenCalledWith('off');
    });

    it('rejects an unknown mode string with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_assist_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'maybe' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setAssistMode).not.toHaveBeenCalled();
    });
  });

  describe('device.set_band_max_force', () => {
    it('forwards lbs to client.setBandMaxForce and returns ok:true', async () => {
      const reg = placeholders.get('device.set_band_max_force')!;
      const { isError, payload } = await invoke(reg, { lbs: 50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setBandMaxForce).toHaveBeenCalledWith(50);
    });

    it('rejects out-of-range lbs (999) with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_band_max_force')!;
      const { isError, payload } = await invoke(reg, { lbs: 999 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setBandMaxForce).not.toHaveBeenCalled();
    });

    it('surfaces SDK InvalidSettingError when value is in MCP range but rejected by SDK', async () => {
      // MCP schema accepts 0..100, but the SDK valid set is 15..70. A
      // value of 5 passes the schema and hits the SDK, which rejects it.
      const client = primaryClient(state);
      client.setBandMaxForce.mockRejectedValueOnce(
        new FakeVoltraSDKError('bandMaxForce out of range', 'INVALID_SETTING'),
      );
      const reg = placeholders.get('device.set_band_max_force')!;
      const { isError, payload } = await invoke(reg, { lbs: 5 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_SETTING');
      expect(client.setBandMaxForce).toHaveBeenCalledWith(5);
    });
  });

  describe('device.set_isokinetic_target_speed', () => {
    it('forwards mmPerSec to client.setIsokineticTargetSpeed and returns ok:true', async () => {
      const reg = placeholders.get('device.set_isokinetic_target_speed')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: 1500 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setIsokineticTargetSpeed).toHaveBeenCalledWith(1500);
    });

    it('rejects mmPerSec above 2000 with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_isokinetic_target_speed')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: 5000 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setIsokineticTargetSpeed).not.toHaveBeenCalled();
    });

    it('surfaces SDK InvalidSettingError for invalid step (e.g. 1505 — not multiple of 10)', async () => {
      const client = primaryClient(state);
      client.setIsokineticTargetSpeed.mockRejectedValueOnce(
        new FakeVoltraSDKError('must be multiple of 10', 'INVALID_SETTING'),
      );
      const reg = placeholders.get('device.set_isokinetic_target_speed')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: 1505 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_SETTING');
    });
  });

  describe('device.set_isokinetic_ecc_mode', () => {
    it("forwards 'isokinetic' to client.setIsokineticEccMode and returns ok:true", async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'isokinetic' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setIsokineticEccMode).toHaveBeenCalledWith('isokinetic');
    });

    it("forwards 'constant' to client.setIsokineticEccMode", async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_mode')!;
      const { isError } = await invoke(reg, { mode: 'constant' });
      expect(isError).toBeUndefined();
      expect(primaryClient(state).setIsokineticEccMode).toHaveBeenCalledWith('constant');
    });

    it('rejects an unknown mode string with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'sometimes' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setIsokineticEccMode).not.toHaveBeenCalled();
    });
  });

  describe('device.set_isokinetic_ecc_speed_limit', () => {
    it('forwards mmPerSec to client.setIsokineticEccSpeedLimit and returns ok:true', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_speed_limit')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: 0 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      // 0 = auto.
      expect(primaryClient(state).setIsokineticEccSpeedLimit).toHaveBeenCalledWith(0);
    });

    it('rejects negative mmPerSec with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_speed_limit')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: -100 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setIsokineticEccSpeedLimit).not.toHaveBeenCalled();
    });

    it('surfaces SDK InvalidSettingError on rejection', async () => {
      const client = primaryClient(state);
      client.setIsokineticEccSpeedLimit.mockRejectedValueOnce(
        new FakeVoltraSDKError('invalid step', 'INVALID_SETTING'),
      );
      const reg = placeholders.get('device.set_isokinetic_ecc_speed_limit')!;
      const { isError, payload } = await invoke(reg, { mmPerSec: 1505 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_SETTING');
    });
  });

  describe('device.set_isokinetic_ecc_const_weight', () => {
    it('forwards lbs to client.setIsokineticEccConstWeight and returns ok:true', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_const_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 100 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setIsokineticEccConstWeight).toHaveBeenCalledWith(100);
    });

    it('rejects out-of-range lbs (300) with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_const_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 300 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setIsokineticEccConstWeight).not.toHaveBeenCalled();
    });

    it('maps a NotConnectedError thrown by the SDK to its code', async () => {
      const client = primaryClient(state);
      client.setIsokineticEccConstWeight.mockRejectedValueOnce(
        new FakeVoltraSDKError('not connected', 'NOT_CONNECTED'),
      );
      const reg = placeholders.get('device.set_isokinetic_ecc_const_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 50 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('NOT_CONNECTED');
    });
  });

  describe('device.set_isokinetic_ecc_overload_weight', () => {
    it('forwards lbs to client.setIsokineticEccOverloadWeight and returns ok:true', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_overload_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 75 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).setIsokineticEccOverloadWeight).toHaveBeenCalledWith(75);
    });

    it('rejects out-of-range lbs (-1) with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_isokinetic_ecc_overload_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: -1 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).setIsokineticEccOverloadWeight).not.toHaveBeenCalled();
    });

    it('surfaces SDK InvalidSettingError on rejection', async () => {
      const client = primaryClient(state);
      client.setIsokineticEccOverloadWeight.mockRejectedValueOnce(
        new FakeVoltraSDKError('overload weight invalid', 'INVALID_SETTING'),
      );
      const reg = placeholders.get('device.set_isokinetic_ecc_overload_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 50 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_SETTING');
    });
  });

  describe('device.start_guided_load', () => {
    it('forwards targetWeightLbs to client.startGuidedLoad and returns ok:true', async () => {
      const reg = placeholders.get('device.start_guided_load')!;
      const { isError, payload } = await invoke(reg, { targetWeightLbs: 50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(primaryClient(state).startGuidedLoad).toHaveBeenCalledWith({
        targetWeightLbs: 50,
      });
    });

    it('forwards optional pollIntervalMs and pollDurationMs when supplied', async () => {
      const reg = placeholders.get('device.start_guided_load')!;
      const { isError } = await invoke(reg, {
        targetWeightLbs: 75,
        pollIntervalMs: 250,
        pollDurationMs: 30000,
      });
      expect(isError).toBeUndefined();
      expect(primaryClient(state).startGuidedLoad).toHaveBeenCalledWith({
        targetWeightLbs: 75,
        pollIntervalMs: 250,
        pollDurationMs: 30000,
      });
    });

    it('rejects out-of-range targetWeightLbs (4) with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.start_guided_load')!;
      const { isError, payload } = await invoke(reg, { targetWeightLbs: 4 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).startGuidedLoad).not.toHaveBeenCalled();
    });

    it('rejects out-of-range targetWeightLbs (201) with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.start_guided_load')!;
      const { isError, payload } = await invoke(reg, { targetWeightLbs: 201 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(primaryClient(state).startGuidedLoad).not.toHaveBeenCalled();
    });

    it('surfaces SDK InvalidSettingError on rejection', async () => {
      const client = primaryClient(state);
      client.startGuidedLoad.mockRejectedValueOnce(
        new FakeVoltraSDKError('weight unsupported', 'INVALID_SETTING'),
      );
      const reg = placeholders.get('device.start_guided_load')!;
      const { isError, payload } = await invoke(reg, { targetWeightLbs: 50 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_SETTING');
    });
  });

  describe('AC-14: BLE access only via @voltras/node-sdk', () => {
    it('contains zero references to noble or webbluetooth across src/tools/', () => {
      // Walk src/tools/ relative to this test file.
      const here = dirname(fileURLToPath(import.meta.url));
      const toolsDir = resolve(here, '..');
      const offending: string[] = [];
      const banned = /\b(noble|webbluetooth)\b/;
      for (const file of walkTs(toolsDir)) {
        const text = readFileSync(file, 'utf8');
        if (banned.test(text)) {
          offending.push(file);
        }
      }
      expect(offending).toEqual([]);
    });
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
