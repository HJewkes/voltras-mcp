// Unit tests for `device.exit_guided_load`.
//
// Strategy mirrors `device-tools.test.ts`: the SDK is fully stubbed, the
// placeholder map is a hand-rolled fake, and slot-scoped state is constructed
// manually. This keeps the test free of @voltras/node-sdk native peers.
//
// Coverage targets (per task brief):
//   * Happy path: slot in guided-load phase → exitGuidedLoad called, ok:true
//   * NOT_IN_GUIDED_LOAD: slot not in active guided-load phase
//   * SLOT_NOT_BOUND: unbound (unknown) slot id
//   * INVALID_INPUT: unknown field rejected by .strict()
//   * Default slot: omitting slot routes to primary

import { describe, expect, it, beforeEach, vi } from 'vitest';
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
  Rowing: 3,
  Damper: 4,
  CustomCurves: 6,
  Isokinetic: 7,
  Isometric: 8,
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
  VoltraClient: class {},
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { registerDeviceTools } = await import('../device-tools.js');

// ── Fakes ─────────────────────────────────────────────────────────────────

type GuidedLoadPhase =
  | 'idle'
  | 'armed'
  | 'countdown'
  | 'engaging'
  | 'active'
  | 'exited'
  | 'timeout';

interface FakeGuidedLoadState {
  phase: GuidedLoadPhase;
  countdownRemainingMs: number | null;
  fitnessModeRaw: number | null;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  settings: {
    weight: number;
    chains: number;
    inverseChains: number;
    eccentric: number;
    mode: number;
    battery: number | null;
  };
  guidedLoadState: FakeGuidedLoadState;
  setAdapter: Mock<(adapter: unknown) => void>;
  getAdapter: Mock<() => unknown>;
  dispose: Mock<() => void>;
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
  startGuidedLoad: Mock<(opts: { targetWeightLbs: number }) => Promise<void>>;
  exitGuidedLoad: Mock<() => Promise<void>>;
  enterRowMode: Mock<() => Promise<void>>;
  startRow: Mock<(distance?: string) => Promise<void>>;
  isRowingActive: boolean;
  onPerRep: Mock<(cb: (event: unknown) => void) => void>;
  onInProgress: Mock<(cb: (event: unknown) => void) => void>;
  onSummary: Mock<(cb: (event: unknown) => void) => void>;
  onSetSummary: Mock<(cb: (event: unknown) => void) => void>;
  onSettingsUpdate: Mock<(cb: (settings: unknown) => void) => void>;
  onConnectionStateChange: Mock<(cb: (state: unknown) => void) => void>;
  onFrame: Mock<(cb: (frame: unknown) => void) => void>;
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
    guidedLoadState: { phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null },
    setAdapter: vi.fn(() => undefined),
    getAdapter: vi.fn(() => null),
    dispose: vi.fn(() => undefined),
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
    exitGuidedLoad: vi.fn(async () => undefined),
    enterRowMode: vi.fn(async () => undefined),
    startRow: vi.fn(async () => undefined),
    isRowingActive: false,
    onPerRep: vi.fn(() => undefined),
    onInProgress: vi.fn(() => undefined),
    onSummary: vi.fn(() => undefined),
    onSetSummary: vi.fn(() => undefined),
    onSettingsUpdate: vi.fn(() => undefined),
    onConnectionStateChange: vi.fn(() => undefined),
    onFrame: vi.fn(() => undefined),
    ...overrides,
  };
}

interface FakeLive {
  snapshotDevice: () => { connected: boolean };
  markDisconnected: (at: string) => void;
}

function makeFakeLive(): FakeLive {
  return {
    snapshotDevice: () => ({ connected: false }),
    markDisconnected: vi.fn(),
  };
}

interface FakeRegisteredTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

interface State {
  manager: {
    devices: unknown[];
    scan: Mock<() => Promise<unknown[]>>;
    connect: Mock<() => Promise<FakeClient>>;
    disconnect: Mock<() => Promise<void>>;
    isConnected: Mock<() => boolean>;
    dispose: Mock<() => void>;
  };
  slots: Map<string, { slotId: string; client: FakeClient; live: FakeLive }>;
  config?: { adapter: string };
}

function makeState(primaryClient?: FakeClient): State {
  const client = primaryClient ?? makeFakeClient();
  const slots = new Map<string, { slotId: string; client: FakeClient; live: FakeLive }>();
  slots.set('primary', { slotId: 'primary', client, live: makeFakeLive() });
  return {
    manager: {
      devices: [],
      scan: vi.fn(async () => []),
      connect: vi.fn(async () => client),
      disconnect: vi.fn(async () => undefined),
      isConnected: vi.fn(() => false),
      dispose: vi.fn(() => undefined),
    },
    slots,
    config: { adapter: 'node' },
  };
}

const ALL_TOOL_NAMES = [
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
] as const;

function makePlaceholders(): Map<string, FakeRegisteredTool> {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of ALL_TOOL_NAMES) {
    const reg: FakeRegisteredTool = {
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

async function invoke(
  placeholders: Map<string, FakeRegisteredTool>,
  name: string,
  args: unknown,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const reg = placeholders.get(name)!;
  const result = (await reg.callback(args)) as {
    isError?: boolean;
    content: Array<{ type: 'text'; text: string }>;
  };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('device.exit_guided_load', () => {
  let client: FakeClient;
  let state: State;
  let placeholders: Map<string, FakeRegisteredTool>;

  beforeEach(() => {
    client = makeFakeClient();
    state = makeState(client);
    placeholders = makePlaceholders();
    registerDeviceTools(
      {} as Parameters<typeof registerDeviceTools>[0],
      state as unknown as Parameters<typeof registerDeviceTools>[1],
      placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
    );
  });

  it('calls exitGuidedLoad and returns ok:true when slot is in armed phase', async () => {
    client.guidedLoadState = { phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('calls exitGuidedLoad and returns ok:true when slot is in countdown phase', async () => {
    client.guidedLoadState = {
      phase: 'countdown',
      countdownRemainingMs: 2500,
      fitnessModeRaw: 0x0026,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('calls exitGuidedLoad and returns ok:true when slot is in engaging phase', async () => {
    client.guidedLoadState = {
      phase: 'engaging',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0026,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('calls exitGuidedLoad and returns ok:true when slot is in active phase', async () => {
    client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('returns NOT_IN_GUIDED_LOAD when slot is in idle phase — exitGuidedLoad not called', async () => {
    client.guidedLoadState = { phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBe(true);
    expect(payload.code).toBe('NOT_IN_GUIDED_LOAD');
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it('returns NOT_IN_GUIDED_LOAD when slot is in exited phase — exitGuidedLoad not called', async () => {
    client.guidedLoadState = {
      phase: 'exited',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0004,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBe(true);
    expect(payload.code).toBe('NOT_IN_GUIDED_LOAD');
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it('returns NOT_IN_GUIDED_LOAD when slot is in timeout phase — exitGuidedLoad not called', async () => {
    client.guidedLoadState = { phase: 'timeout', countdownRemainingMs: null, fitnessModeRaw: null };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBe(true);
    expect(payload.code).toBe('NOT_IN_GUIDED_LOAD');
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it("routes to primary slot when 'slot' is omitted (default-slot test)", async () => {
    client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it("routes to primary slot when slot: 'primary' is explicit", async () => {
    client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {
      slot: 'primary',
    });
    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('returns an error (Unknown slot message) for an unknown slot id — exitGuidedLoad not called', async () => {
    client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {
      slot: 'phantom',
    });
    expect(isError).toBe(true);
    expect(String(payload.message)).toMatch(/Unknown slot/i);
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it('returns INVALID_INPUT when an unknown field is passed (.strict())', async () => {
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {
      unknownField: true,
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it('surfaces SDK error code when exitGuidedLoad rejects', async () => {
    client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    client.exitGuidedLoad.mockRejectedValueOnce(
      new FakeVoltraSDKError('BLE write failed', 'COMMAND_ERROR'),
    );
    const { isError, payload } = await invoke(placeholders, 'device.exit_guided_load', {});
    expect(isError).toBe(true);
    expect(payload.code).toBe('COMMAND_ERROR');
  });
});
