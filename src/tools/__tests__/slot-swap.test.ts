// Unit tests for the `slot.swap` MCP tool. The handler is a thin wrapper
// over `swapSlots` (state/slot-manager.ts) — these tests pin the
// tool-shaped contract: input schema rejects extra fields, the success
// response carries the post-swap binding map keyed by slotId, and the
// preconditions surface as structured `{ code, message }` errors.
//
// Strategy mirrors the device-tools test suite: SDK fully stubbed via
// `vi.mock('@voltras/node-sdk')`, the MCP placeholder map is a hand-rolled
// fake of `RegisteredTool.update`, the slot-scoped state is constructed
// manually. The state-layer invariants (which fields are exchanged, bridge
// re-wiring) live in `state/__tests__/slot-lifecycle.test.ts`.

import { describe, expect, it, vi } from 'vitest';
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
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { LiveState } = await import('../../state/live-state.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { registerDeviceTools } = await import('../device-tools.js');

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  isRowingActive: boolean;
  settings: Record<string, unknown>;
  getAdapter: Mock<() => unknown>;
  dispose: Mock<() => void>;
}

function makeFakeClient(opts: { connected: boolean; deviceId?: string }): FakeClient {
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

interface FakeSlot {
  slotId: string;
  client: FakeClient;
  live: InstanceType<typeof LiveState>;
  modeRevertGuard: InstanceType<typeof ModeRevertGuard>;
  unwireBridge?: () => void;
}

interface State {
  config: { adapter: 'node' | 'mock'; dbPath: string; logLevel: 'info' };
  manager: Record<string, unknown>;
  slots: Map<string, FakeSlot>;
  slotBindings: {
    get: Mock<(deviceId: string) => null>;
    bind: Mock<(deviceId: string, side: 'left' | 'right') => unknown>;
    touch: Mock<(deviceId: string) => void>;
    remove: Mock<(deviceId: string) => unknown>;
    list: Mock<() => unknown[]>;
  };
}

function makeFakeSlotBindings(): State['slotBindings'] {
  return {
    get: vi.fn(() => null),
    bind: vi.fn(),
    touch: vi.fn(),
    remove: vi.fn(() => null),
    list: vi.fn(() => []),
  };
}

function makeStateWithBoth(opts: { primaryConnected: boolean; leftConnected: boolean }): {
  state: State;
  primaryClient: FakeClient;
  leftClient: FakeClient;
} {
  const primaryClient = makeFakeClient({
    connected: opts.primaryConnected,
    deviceId: 'V-PRI',
  });
  const leftClient = makeFakeClient({
    connected: opts.leftConnected,
    deviceId: 'V-LEFT',
  });
  const slots = new Map<string, FakeSlot>();
  slots.set('primary', {
    slotId: 'primary',
    client: primaryClient,
    live: new LiveState(),
    modeRevertGuard: new ModeRevertGuard(),
    unwireBridge: vi.fn(),
  });
  slots.set('left', {
    slotId: 'left',
    client: leftClient,
    live: new LiveState(),
    modeRevertGuard: new ModeRevertGuard(),
    unwireBridge: vi.fn(),
  });
  return {
    state: {
      config: { adapter: 'node', dbPath: '/tmp/test.sqlite', logLevel: 'info' },
      manager: {},
      slots,
      slotBindings: makeFakeSlotBindings(),
    },
    primaryClient,
    leftClient,
  };
}

interface RecordedTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

const ALL_DEVICE_TOOL_NAMES = [
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
  'device.enter_row_mode',
  'device.start_row',
  'device.get_state',
  'device.send_raw',
  'slot.swap',
];

function buildPlaceholderMap(names: string[]): Map<string, RecordedTool> {
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

interface InvokeResult {
  isError?: boolean;
  payload: Record<string, unknown>;
}

function setup(state: State): {
  placeholders: Map<string, RecordedTool>;
  invoke: (name: string, args: unknown) => Promise<InvokeResult>;
} {
  const placeholders = buildPlaceholderMap(ALL_DEVICE_TOOL_NAMES);
  registerDeviceTools(
    {} as never,
    state as unknown as Parameters<typeof registerDeviceTools>[1],
    placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
  );
  return {
    placeholders,
    invoke: async (name, args) => {
      const reg = placeholders.get(name)!;
      const r = (await reg.callback(args)) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { isError: r.isError, payload: JSON.parse(r.content[0].text) };
    },
  };
}

describe('slot.swap tool', () => {
  it('swaps both bound slots and returns the post-swap binding map keyed by slotId', async () => {
    const { state, primaryClient, leftClient } = makeStateWithBoth({
      primaryConnected: true,
      leftConnected: true,
    });
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBeUndefined();
    expect(r.payload.ok).toBe(true);
    expect(r.payload.bindings).toEqual({
      primary: { deviceId: 'V-LEFT' },
      left: { deviceId: 'V-PRI' },
    });
    // The actual SlotState references should now point at swapped clients.
    expect(state.slots.get('primary')?.client).toBe(leftClient);
    expect(state.slots.get('left')?.client).toBe(primaryClient);
  });

  it('rejects with SWAP_REQUIRES_TWO_SLOTS — found 1 connected — when only the primary slot is connected', async () => {
    const { state } = makeStateWithBoth({ primaryConnected: true, leftConnected: false });
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('SWAP_REQUIRES_TWO_SLOTS');
    expect(String(r.payload.message)).toMatch(/found 1 connected/);
  });

  it('rejects with SWAP_REQUIRES_TWO_SLOTS — found 1 connected — when only the secondary slot is connected', async () => {
    const { state } = makeStateWithBoth({ primaryConnected: false, leftConnected: true });
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('SWAP_REQUIRES_TWO_SLOTS');
    expect(String(r.payload.message)).toMatch(/found 1 connected/);
  });

  it('rejects with SWAP_REQUIRES_TWO_SLOTS — found 0 connected — when neither slot is connected', async () => {
    const { state } = makeStateWithBoth({ primaryConnected: false, leftConnected: false });
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('SWAP_REQUIRES_TWO_SLOTS');
    expect(String(r.payload.message)).toMatch(/found 0 connected/);
  });

  it('rejects with SWAP_REQUIRES_TWO_SLOTS when only the primary slot exists and is connected (no second slot allocated)', async () => {
    // Single-slot state — primary is connected, but no second slot has
    // been allocated via device.connect.
    const slots = new Map<string, FakeSlot>();
    const primaryClient = makeFakeClient({ connected: true, deviceId: 'V-PRI' });
    slots.set('primary', {
      slotId: 'primary',
      client: primaryClient,
      live: new LiveState(),
      modeRevertGuard: new ModeRevertGuard(),
      unwireBridge: vi.fn(),
    });
    const state: State = {
      config: { adapter: 'node', dbPath: '/tmp/test.sqlite', logLevel: 'info' },
      manager: {},
      slots,
      slotBindings: makeFakeSlotBindings(),
    };
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('SWAP_REQUIRES_TWO_SLOTS');
    expect(String(r.payload.message)).toMatch(/found 1 connected/);
  });

  // F1 / VMCP-01.18 — repro: bootstrap leaves an unconnected `primary` slot in
  // state.slots; the user runs `device.connect {slot: 'left'}` then
  // `device.connect {slot: 'right'}`. `slot.swap` must count only connected
  // slots (left + right = 2) and ignore the unconnected primary placeholder.
  it('swaps left↔right when an unconnected bootstrap primary placeholder is also present (F1 repro)', async () => {
    const slots = new Map<string, FakeSlot>();
    const primaryClient = makeFakeClient({ connected: false });
    const leftClient = makeFakeClient({ connected: true, deviceId: 'V-097082' });
    const rightClient = makeFakeClient({ connected: true, deviceId: 'V-212006' });
    slots.set('primary', {
      slotId: 'primary',
      client: primaryClient,
      live: new LiveState(),
      modeRevertGuard: new ModeRevertGuard(),
      unwireBridge: vi.fn(),
    });
    slots.set('left', {
      slotId: 'left',
      client: leftClient,
      live: new LiveState(),
      modeRevertGuard: new ModeRevertGuard(),
      unwireBridge: vi.fn(),
    });
    slots.set('right', {
      slotId: 'right',
      client: rightClient,
      live: new LiveState(),
      modeRevertGuard: new ModeRevertGuard(),
      unwireBridge: vi.fn(),
    });
    const state: State = {
      config: { adapter: 'node', dbPath: '/tmp/test.sqlite', logLevel: 'info' },
      manager: {},
      slots,
      slotBindings: makeFakeSlotBindings(),
    };
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', {});

    expect(r.isError).toBeUndefined();
    expect(r.payload.ok).toBe(true);
    // The connected pair swapped — primary stays unconnected (deviceId: null)
    // and is included in the bindings snapshot since it lives in state.slots.
    expect(r.payload.bindings).toEqual({
      primary: { deviceId: null },
      left: { deviceId: 'V-212006' },
      right: { deviceId: 'V-097082' },
    });
    expect(state.slots.get('left')?.client).toBe(rightClient);
    expect(state.slots.get('right')?.client).toBe(leftClient);
    // Primary's unconnected placeholder is untouched by the swap.
    expect(state.slots.get('primary')?.client).toBe(primaryClient);
  });

  it('rejects unknown input fields with INVALID_INPUT (.strict() schema)', async () => {
    const { state } = makeStateWithBoth({ primaryConnected: true, leftConnected: true });
    const { invoke } = setup(state);

    const r = await invoke('slot.swap', { slot: 'primary' });

    expect(r.isError).toBe(true);
    expect(r.payload.code).toBe('INVALID_INPUT');
  });

  it('two consecutive swaps return to the original mapping (idempotent at the tool layer)', async () => {
    const { state, primaryClient, leftClient } = makeStateWithBoth({
      primaryConnected: true,
      leftConnected: true,
    });
    const { invoke } = setup(state);

    await invoke('slot.swap', {});
    const r2 = await invoke('slot.swap', {});

    expect(r2.isError).toBeUndefined();
    expect(r2.payload.bindings).toEqual({
      primary: { deviceId: 'V-PRI' },
      left: { deviceId: 'V-LEFT' },
    });
    expect(state.slots.get('primary')?.client).toBe(primaryClient);
    expect(state.slots.get('left')?.client).toBe(leftClient);
  });
});
