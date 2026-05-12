// Unit tests for `slot.bind` / `slot.bindings_list` / `slot.unbind` (VMCP-02.05)
// and for `device.connect`'s `slot: 'auto'` resolution path.
//
// Strategy: drive the real `SlotBindingsStore` against a tmpdir (no
// filesystem mocks — the storage roundtrip is part of the contract) and
// stub everything BLE-side as we already do in `slot-swap.test.ts`. Both
// tool registries are exercised so the bindings written by `slot.bind`
// surface through `device.connect`'s auto path in the same test fixture.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

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
  Damper: 4,
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  4: 'Damper',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  TrainingModeNames: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
  VoltraManager: class {},
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

vi.mock('../../state/slot-manager.js', async () => {
  // Pass through to the real module — we want the production slot-lifecycle
  // helpers, not stubs, so the bilateral connect path mutates state.slots
  // the same way runtime does.
  return await vi.importActual('../../state/slot-manager.js');
});

const { SlotBindingsStore } = await import('../../state/slot-bindings.js');
const { LiveState } = await import('../../state/live-state.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { CoercionWatch } = await import('../../state/coercion-watch.js');
const { registerSlotTools } = await import('../slot-tools.js');
const { registerDeviceTools } = await import('../device-tools.js');

type Callback = (
  args: unknown,
  extra?: unknown,
) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

interface RecordedTool {
  callback: Callback;
  update: Mock<(updates: { callback?: Callback }) => void>;
}

function buildPlaceholders(names: readonly string[]): Map<string, RecordedTool> {
  const placeholders = new Map<string, RecordedTool>();
  for (const name of names) {
    const reg: RecordedTool = {
      callback: async () => ({
        content: [{ type: 'text', text: '{"code":"STARTING"}' }],
        isError: true,
      }),
      update: vi.fn((updates) => {
        if (updates.callback) reg.callback = updates.callback;
      }),
    };
    placeholders.set(name, reg);
  }
  return placeholders;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  isRowingActive: boolean;
  settings: Record<string, unknown>;
  getAdapter: Mock<() => null>;
  dispose: Mock<() => void>;
}

function makeFakeClient(
  opts: { connected: boolean; deviceId?: string } = { connected: false },
): FakeClient {
  return {
    isConnected: opts.connected,
    connectionState: opts.connected ? 'connected' : 'disconnected',
    connectedDeviceId: opts.connected ? (opts.deviceId ?? 'V-?') : null,
    isRowingActive: false,
    settings: {},
    getAdapter: vi.fn(() => null),
    dispose: vi.fn(),
  };
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
  'device.exit_guided_load',
  'device.enter_row_mode',
  'device.start_row',
  'device.get_state',
  'device.send_raw',
  'bilateral.cascade',
  'slot.swap',
] as const;

const SLOT_TOOL_NAMES = [
  'slot.identify',
  'slot.bind',
  'slot.bindings_list',
  'slot.unbind',
] as const;

function makeState(bindingsPath: string): {
  state: ReturnType<typeof buildBareState>;
  bindingsStore: InstanceType<typeof SlotBindingsStore>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{
    isError?: boolean;
    payload: Record<string, unknown>;
  }>;
} {
  const bindingsStore = SlotBindingsStore.open(bindingsPath);
  const state = buildBareState(bindingsStore);
  const placeholders = buildPlaceholders([...DEVICE_TOOL_NAMES, ...SLOT_TOOL_NAMES]);
  registerSlotTools(
    {} as never,
    state as unknown as Parameters<typeof registerSlotTools>[1],
    placeholders as unknown as Parameters<typeof registerSlotTools>[2],
  );
  registerDeviceTools(
    {} as never,
    state as unknown as Parameters<typeof registerDeviceTools>[1],
    placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
  );
  return {
    state,
    bindingsStore,
    invoke: async (name, args) => {
      const reg = placeholders.get(name);
      if (!reg) throw new Error(`tool not registered: ${name}`);
      const r = await reg.callback(args);
      return { isError: r.isError, payload: JSON.parse(r.content[0].text) };
    },
  };
}

interface FakeManager {
  devices: Array<{ id: string; name: string | null; rssi: number | null }>;
  connect: Mock<(d: unknown) => Promise<FakeClient>>;
  disconnect: Mock<(id: string) => Promise<void>>;
  scan: Mock<() => Promise<unknown[]>>;
}

function makeFakeManager(): FakeManager {
  return {
    devices: [],
    connect: vi.fn(async () => makeFakeClient({ connected: true })),
    disconnect: vi.fn(async () => undefined),
    scan: vi.fn(async () => []),
  };
}

function buildBareState(bindings: InstanceType<typeof SlotBindingsStore>) {
  const slots = new Map<string, ReturnType<typeof buildPrimarySlot>>();
  slots.set('primary', buildPrimarySlot());
  return {
    config: { adapter: 'node' as const, dbPath: '/tmp/x.sqlite', logLevel: 'info' as const },
    manager: makeFakeManager(),
    slots,
    slotBindings: bindings,
  };
}

function buildPrimarySlot() {
  return {
    slotId: 'primary',
    client: makeFakeClient({ connected: false }),
    live: new LiveState(),
    modeRevertGuard: new ModeRevertGuard(),
    coercionWatch: new CoercionWatch(),
    unwireBridge: vi.fn(),
  };
}

describe('slot.bind tool', () => {
  let dir: string;
  let bindingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-bind-'));
    bindingsPath = join(dir, 'bindings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a deviceId → physicalSide mapping and surfaces it in slot.bindings_list', async () => {
    const { invoke } = makeState(bindingsPath);

    const r = await invoke('slot.bind', { deviceId: 'V-097082', physicalSide: 'left' });
    expect(r.isError).toBeUndefined();
    expect(r.payload).toMatchObject({
      ok: true,
      binding: { deviceId: 'V-097082', physicalSide: 'left' },
    });

    const listed = await invoke('slot.bindings_list', {});
    expect(listed.payload.bindings).toHaveLength(1);
    expect((listed.payload.bindings as Array<{ deviceId: string }>)[0].deviceId).toBe('V-097082');
  });

  it('persists across SlotBindingsStore reopens (verifies the on-disk roundtrip)', async () => {
    const first = makeState(bindingsPath);
    await first.invoke('slot.bind', { deviceId: 'V-1', physicalSide: 'right' });

    // Reopen the store as a fresh MCP boot would.
    const second = makeState(bindingsPath);
    const listed = await second.invoke('slot.bindings_list', {});
    expect(listed.payload.bindings).toHaveLength(1);
    expect((listed.payload.bindings as Array<{ physicalSide: string }>)[0].physicalSide).toBe(
      'right',
    );
  });

  it('overwrites an existing binding when called twice for the same deviceId', async () => {
    const { invoke } = makeState(bindingsPath);
    await invoke('slot.bind', { deviceId: 'V-1', physicalSide: 'left' });
    await invoke('slot.bind', { deviceId: 'V-1', physicalSide: 'right' });
    const listed = await invoke('slot.bindings_list', {});
    expect(listed.payload.bindings).toHaveLength(1);
    expect((listed.payload.bindings as Array<{ physicalSide: string }>)[0].physicalSide).toBe(
      'right',
    );
  });

  it('rejects an unknown physicalSide enum value with INVALID_INPUT', async () => {
    const { invoke } = makeState(bindingsPath);
    const r = await invoke('slot.bind', { deviceId: 'V-1', physicalSide: 'middle' });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('INVALID_INPUT');
  });

  it('rejects an empty deviceId with INVALID_INPUT', async () => {
    const { invoke } = makeState(bindingsPath);
    const r = await invoke('slot.bind', { deviceId: '', physicalSide: 'left' });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('INVALID_INPUT');
  });

  it('rejects unknown input fields with INVALID_INPUT (.strict() schema)', async () => {
    const { invoke } = makeState(bindingsPath);
    const r = await invoke('slot.bind', {
      deviceId: 'V-1',
      physicalSide: 'left',
      extra: true,
    });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('INVALID_INPUT');
  });

  it('slot.unbind removes a persisted binding and returns the removed entry', async () => {
    const { invoke } = makeState(bindingsPath);
    await invoke('slot.bind', { deviceId: 'V-1', physicalSide: 'left' });

    const r = await invoke('slot.unbind', { deviceId: 'V-1' });
    expect(r.isError).toBeUndefined();
    expect(r.payload.ok).toBe(true);
    expect((r.payload.removed as { deviceId: string }).deviceId).toBe('V-1');

    const listed = await invoke('slot.bindings_list', {});
    expect(listed.payload.bindings).toEqual([]);
  });

  it('slot.unbind returns ok:true + removed:null when the deviceId was never bound', async () => {
    const { invoke } = makeState(bindingsPath);
    const r = await invoke('slot.unbind', { deviceId: 'V-NOPE' });
    expect(r.isError).toBeUndefined();
    expect(r.payload).toEqual({ ok: true, removed: null });
  });
});

describe("device.connect with slot: 'auto'", () => {
  let dir: string;
  let bindingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-bind-connect-'));
    bindingsPath = join(dir, 'bindings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves to slot 'left' when the deviceId has a persisted left binding", async () => {
    const { state, invoke } = makeState(bindingsPath);
    await invoke('slot.bind', { deviceId: 'V-LEFT', physicalSide: 'left' });

    state.manager.devices = [{ id: 'V-LEFT', name: 'Voltra-L', rssi: -50 }];
    state.manager.connect.mockResolvedValueOnce(
      makeFakeClient({ connected: true, deviceId: 'V-LEFT' }),
    );

    const r = await invoke('device.connect', { deviceId: 'V-LEFT', slot: 'auto' });
    expect(r.isError).toBeUndefined();
    expect(r.payload).toEqual({
      ok: true,
      deviceId: 'V-LEFT',
      slot: 'left',
      resolvedFrom: 'persisted_binding',
    });
    expect(state.slots.has('left')).toBe(true);
    expect(state.slots.has('right')).toBe(false);
  });

  it("resolves to slot 'right' when the deviceId has a persisted right binding", async () => {
    const { state, invoke } = makeState(bindingsPath);
    await invoke('slot.bind', { deviceId: 'V-RIGHT', physicalSide: 'right' });

    state.manager.devices = [{ id: 'V-RIGHT', name: 'Voltra-R', rssi: -50 }];
    state.manager.connect.mockResolvedValueOnce(
      makeFakeClient({ connected: true, deviceId: 'V-RIGHT' }),
    );

    const r = await invoke('device.connect', { deviceId: 'V-RIGHT', slot: 'auto' });
    expect(r.isError).toBeUndefined();
    expect((r.payload as { slot: string }).slot).toBe('right');
    expect(state.slots.has('right')).toBe(true);
  });

  it("falls back to NO_PERSISTED_BINDING when slot: 'auto' is passed for an unbound deviceId", async () => {
    const { state, invoke } = makeState(bindingsPath);
    state.manager.devices = [{ id: 'V-NEW', name: 'Voltra-?', rssi: -50 }];

    const r = await invoke('device.connect', { deviceId: 'V-NEW', slot: 'auto' });
    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('NO_PERSISTED_BINDING');
    expect(String(r.payload.message)).toMatch(/V-NEW/);
    expect(state.manager.connect).not.toHaveBeenCalled();
  });

  it('preserves backwards-compat — explicit slot keeps the legacy { ok, deviceId } response', async () => {
    const { state, invoke } = makeState(bindingsPath);
    state.manager.devices = [{ id: 'V-1', name: 'Voltra-1', rssi: -50 }];
    state.manager.connect.mockResolvedValueOnce(
      makeFakeClient({ connected: true, deviceId: 'V-1' }),
    );

    const r = await invoke('device.connect', { deviceId: 'V-1', slot: 'left' });
    expect(r.isError).toBeUndefined();
    // No `slot` / `resolvedFrom` keys on the non-auto path.
    expect(r.payload).toEqual({ ok: true, deviceId: 'V-1' });
  });

  it('touches lastSeen on the persisted binding after a successful connect', async () => {
    // Pin Date.now() to deterministic values so the bind / connect
    // timestamps are guaranteed distinct.
    const t0 = Date.parse('2026-05-12T12:00:00.000Z');
    const t1 = Date.parse('2026-05-12T12:00:01.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const { state, bindingsStore, invoke } = makeState(bindingsPath);
      await invoke('slot.bind', { deviceId: 'V-LEFT', physicalSide: 'left' });
      const before = bindingsStore.get('V-LEFT');
      expect(before?.lastSeen).toBe(new Date(t0).toISOString());

      nowSpy.mockReturnValue(t1);
      state.manager.devices = [{ id: 'V-LEFT', name: 'Voltra-L', rssi: -50 }];
      state.manager.connect.mockResolvedValueOnce(
        makeFakeClient({ connected: true, deviceId: 'V-LEFT' }),
      );
      await invoke('device.connect', { deviceId: 'V-LEFT', slot: 'auto' });

      const after = bindingsStore.get('V-LEFT');
      expect(after?.boundAt).toBe(before?.boundAt);
      expect(after?.lastSeen).toBe(new Date(t1).toISOString());
    } finally {
      nowSpy.mockRestore();
    }
  });
});
