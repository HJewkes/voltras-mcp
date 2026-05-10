// Unit tests for the `bilateral.cascade` tool.
//
// Strategy mirrors `device-tools.test.ts`: stub the @voltras/node-sdk module
// with a fake `TrainingMode` enum and a fake error class, build a
// minimal-shape state with one or more slots, then invoke the cascade
// handler against the placeholder map.
//
// Each test exercises a distinct slice of the contract:
//   * fan-out call counting (happy path)
//   * subset-of-fields → only requested setters fire
//   * partial-failure isolation under `abortOnFirstFailure: false`
//   * sequential abort under `abortOnFirstFailure: true`
//   * empty-input rejection
//   * unbound-slot rejection (no setters fire)
//   * default slot resolution (omit `slots`)
//   * preservation of input slot order in `results`

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

// `slot-manager` reaches into `event-bridge` on slot creation; the cascade
// handler doesn't allocate slots itself, but the device-tools registration
// closure imports it transitively. Stubbing the bridge wirer keeps the
// fake state minimal and avoids dragging in the SQLite store / publisher
// stack.
vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { registerDeviceTools } = await import('../device-tools.js');

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  setAdapter: Mock;
  getAdapter: Mock;
  dispose: Mock;
  setMode: Mock<(mode: number) => Promise<void>>;
  setWeight: Mock<(lbs: number) => Promise<void>>;
  setEccentric: Mock<(percent: number) => Promise<void>>;
  setChains: Mock<(lbs: number) => Promise<void>>;
  // Other setters required by the device-tools registration but unused here.
  setDamperLevel: Mock;
  setAssistMode: Mock;
  setBandMaxForce: Mock;
  setIsokineticTargetSpeed: Mock;
  setIsokineticEccMode: Mock;
  setIsokineticEccSpeedLimit: Mock;
  setIsokineticEccConstWeight: Mock;
  setIsokineticEccOverloadWeight: Mock;
  startGuidedLoad: Mock;
  enterRowMode: Mock;
  startRow: Mock;
  isRowingActive: boolean;
  onPerRep: Mock;
  onInProgress: Mock;
  onSummary: Mock;
  onSetSummary: Mock;
  onSettingsUpdate: Mock;
  onConnectionStateChange: Mock;
  onFrame: Mock;
}

function makeFakeClient(connected = true): FakeClient {
  return {
    isConnected: connected,
    connectionState: connected ? 'connected' : 'disconnected',
    connectedDeviceId: connected ? 'V-X' : null,
    setAdapter: vi.fn(),
    getAdapter: vi.fn(() => null),
    dispose: vi.fn(),
    setMode: vi.fn(async () => undefined),
    setWeight: vi.fn(async () => undefined),
    setEccentric: vi.fn(async () => undefined),
    setChains: vi.fn(async () => undefined),
    setDamperLevel: vi.fn(async () => undefined),
    setAssistMode: vi.fn(async () => undefined),
    setBandMaxForce: vi.fn(async () => undefined),
    setIsokineticTargetSpeed: vi.fn(async () => undefined),
    setIsokineticEccMode: vi.fn(async () => undefined),
    setIsokineticEccSpeedLimit: vi.fn(async () => undefined),
    setIsokineticEccConstWeight: vi.fn(async () => undefined),
    setIsokineticEccOverloadWeight: vi.fn(async () => undefined),
    startGuidedLoad: vi.fn(async () => undefined),
    enterRowMode: vi.fn(async () => undefined),
    startRow: vi.fn(async () => undefined),
    isRowingActive: false,
    onPerRep: vi.fn(),
    onInProgress: vi.fn(),
    onSummary: vi.fn(),
    onSetSummary: vi.fn(),
    onSettingsUpdate: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onFrame: vi.fn(),
  };
}

interface RecordedTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock;
}

interface FakeServer {
  tool: Mock;
}

function makeFakeServer(): FakeServer {
  const tool = vi.fn((_name: string, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as RecordedTool['callback'];
    const reg: RecordedTool = {
      callback: cb,
      update: vi.fn((updates: { callback?: RecordedTool['callback'] }) => {
        if (updates.callback) reg.callback = updates.callback;
      }),
    };
    return reg;
  });
  return { tool };
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
  'device.enter_row_mode',
  'device.start_row',
  'device.get_state',
  'device.send_raw',
  'bilateral.cascade',
] as const;

interface FakeSlot {
  slotId: string;
  client: FakeClient;
  live: { snapshotDevice: () => Record<string, unknown>; markDisconnected: Mock };
}

function makeSlot(slotId: string, connected = true): FakeSlot {
  return {
    slotId,
    client: makeFakeClient(connected),
    live: {
      snapshotDevice: () => ({}),
      markDisconnected: vi.fn(),
    },
  };
}

interface State {
  manager: { devices: unknown[]; scan: Mock; connect: Mock; disconnect: Mock; isConnected: Mock };
  slots: Map<string, FakeSlot>;
}

function makeState(slots: Array<[string, FakeSlot]>): State {
  return {
    manager: {
      devices: [],
      scan: vi.fn(async () => []),
      connect: vi.fn(async () => makeFakeClient()),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => false),
    },
    slots: new Map(slots),
  };
}

function buildPlaceholderMap(server: FakeServer): Map<string, RecordedTool> {
  const placeholders = new Map<string, RecordedTool>();
  const stub = (): unknown => ({
    content: [{ type: 'text', text: '{"code":"STARTING"}' }],
    isError: true,
  });
  for (const name of DEVICE_TOOL_NAMES) {
    placeholders.set(name, server.tool(name, stub));
  }
  return placeholders;
}

interface InvokeResult {
  isError?: boolean;
  payload: Record<string, unknown>;
}

async function invoke(reg: RecordedTool, args: unknown): Promise<InvokeResult> {
  const result = (await reg.callback(args)) as {
    isError?: boolean;
    content: Array<{ type: 'text'; text: string }>;
  };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

interface SetterOutcome {
  ok: boolean;
  error?: string;
  value?: number | string;
}
interface SlotResult {
  slot: string;
  applied: {
    mode?: SetterOutcome;
    weightLbs?: SetterOutcome;
    eccentricPercent?: SetterOutcome;
    chainsLbs?: SetterOutcome;
  };
}

function setupHandler(slots: Array<[string, FakeSlot]>): {
  state: State;
  reg: RecordedTool;
} {
  const state = makeState(slots);
  const server = makeFakeServer();
  const placeholders = buildPlaceholderMap(server);
  registerDeviceTools(
    server as unknown as Parameters<typeof registerDeviceTools>[0],
    state as unknown as Parameters<typeof registerDeviceTools>[1],
    placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
  );
  const reg = placeholders.get('bilateral.cascade');
  if (!reg) throw new Error('bilateral.cascade placeholder missing');
  return { state, reg };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('bilateral.cascade', () => {
  let primary: FakeSlot;
  let secondary: FakeSlot;
  let reg: RecordedTool;

  beforeEach(() => {
    primary = makeSlot('primary', true);
    secondary = makeSlot('secondary', true);
    reg = setupHandler([
      ['primary', primary],
      ['secondary', secondary],
    ]).reg;
  });

  it('fans all four setters across two slots — 8 SDK calls total, ok:true', async () => {
    const { isError, payload } = await invoke(reg, {
      mode: 'WeightTraining',
      weightLbs: 75,
      eccentricPercent: 30,
      chainsLbs: 20,
    });
    expect(isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    // 4 setters per slot, 2 slots → 8 total fires.
    expect(primary.client.setMode).toHaveBeenCalledWith(FakeTrainingMode.WeightTraining);
    expect(primary.client.setWeight).toHaveBeenCalledWith(75);
    expect(primary.client.setEccentric).toHaveBeenCalledWith(30);
    expect(primary.client.setChains).toHaveBeenCalledWith(20);
    expect(secondary.client.setMode).toHaveBeenCalledWith(FakeTrainingMode.WeightTraining);
    expect(secondary.client.setWeight).toHaveBeenCalledWith(75);
    expect(secondary.client.setEccentric).toHaveBeenCalledWith(30);
    expect(secondary.client.setChains).toHaveBeenCalledWith(20);
    const results = payload.results as SlotResult[];
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.applied.mode).toEqual({ ok: true, value: FakeTrainingMode.WeightTraining });
      expect(r.applied.weightLbs).toEqual({ ok: true, value: 75 });
      expect(r.applied.eccentricPercent).toEqual({ ok: true, value: 30 });
      expect(r.applied.chainsLbs).toEqual({ ok: true, value: 20 });
    }
  });

  it('only requested setters fire — `applied` map keys reflect the request', async () => {
    const { isError, payload } = await invoke(reg, {
      mode: 'ResistanceBand',
      weightLbs: 50,
    });
    expect(isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    // Mode + weight on each slot ⇒ 4 calls.
    expect(primary.client.setMode).toHaveBeenCalledTimes(1);
    expect(primary.client.setWeight).toHaveBeenCalledTimes(1);
    expect(secondary.client.setMode).toHaveBeenCalledTimes(1);
    expect(secondary.client.setWeight).toHaveBeenCalledTimes(1);
    // Untouched setters never fire.
    expect(primary.client.setEccentric).not.toHaveBeenCalled();
    expect(primary.client.setChains).not.toHaveBeenCalled();
    expect(secondary.client.setEccentric).not.toHaveBeenCalled();
    expect(secondary.client.setChains).not.toHaveBeenCalled();
    const results = payload.results as SlotResult[];
    for (const r of results) {
      expect(Object.keys(r.applied).sort()).toEqual(['mode', 'weightLbs']);
      expect(r.applied.mode?.ok).toBe(true);
      expect(r.applied.weightLbs?.ok).toBe(true);
    }
  });

  it('partial-failure: one setter on secondary rejects, other setters still attempted on both slots', async () => {
    secondary.client.setWeight.mockRejectedValueOnce(
      new FakeVoltraSDKError('range error: weight must be 5-200', 'INVALID_SETTING'),
    );
    const { isError, payload } = await invoke(reg, {
      mode: 'WeightTraining',
      weightLbs: 75,
      eccentricPercent: 30,
      chainsLbs: 20,
    });
    expect(isError).toBeUndefined();
    // Overall ok is false — at least one setter failed.
    expect(payload.ok).toBe(false);
    // Primary's setters all fired and succeeded.
    expect(primary.client.setMode).toHaveBeenCalledTimes(1);
    expect(primary.client.setWeight).toHaveBeenCalledTimes(1);
    expect(primary.client.setEccentric).toHaveBeenCalledTimes(1);
    expect(primary.client.setChains).toHaveBeenCalledTimes(1);
    // Secondary's other setters STILL fired even though setWeight rejected.
    expect(secondary.client.setMode).toHaveBeenCalledTimes(1);
    expect(secondary.client.setWeight).toHaveBeenCalledTimes(1);
    expect(secondary.client.setEccentric).toHaveBeenCalledTimes(1);
    expect(secondary.client.setChains).toHaveBeenCalledTimes(1);
    const results = payload.results as SlotResult[];
    const secondaryResult = results.find((r) => r.slot === 'secondary');
    expect(secondaryResult?.applied.weightLbs?.ok).toBe(false);
    expect(secondaryResult?.applied.weightLbs?.error).toMatch(/range error/);
    expect(secondaryResult?.applied.weightLbs?.value).toBe(75);
    expect(secondaryResult?.applied.mode?.ok).toBe(true);
    expect(secondaryResult?.applied.eccentricPercent?.ok).toBe(true);
    expect(secondaryResult?.applied.chainsLbs?.ok).toBe(true);
    const primaryResult = results.find((r) => r.slot === 'primary');
    expect(primaryResult?.applied.weightLbs?.ok).toBe(true);
  });

  it('abortOnFirstFailure: true — first failure short-circuits subsequent setters in the same slot', async () => {
    // Single-slot setup so the ordering is unambiguous: with two slots, the
    // abort flag flips after both slots' first concurrent step has fired,
    // which makes "subsequent setters not attempted" non-deterministic
    // across the OTHER slot. Here we isolate to one slot to make the
    // sequential semantic visible.
    const onlyPrimary = makeSlot('primary', true);
    const setup = setupHandler([['primary', onlyPrimary]]);
    const oneRegister = setup.reg;

    // The first setter scheduled (in the request order: mode → weight →
    // eccentric → chains) is `mode`. Force it to reject so weight/ecc/chains
    // never fire.
    onlyPrimary.client.setMode.mockRejectedValueOnce(
      new FakeVoltraSDKError('mode rejected', 'INVALID_SETTING'),
    );

    const { isError, payload } = await invoke(oneRegister, {
      mode: 'WeightTraining',
      weightLbs: 75,
      eccentricPercent: 30,
      chainsLbs: 20,
      abortOnFirstFailure: true,
    });
    expect(isError).toBeUndefined();
    expect(payload.ok).toBe(false);
    // Only setMode fired — the abort short-circuits the rest.
    expect(onlyPrimary.client.setMode).toHaveBeenCalledTimes(1);
    expect(onlyPrimary.client.setWeight).not.toHaveBeenCalled();
    expect(onlyPrimary.client.setEccentric).not.toHaveBeenCalled();
    expect(onlyPrimary.client.setChains).not.toHaveBeenCalled();
    const results = payload.results as SlotResult[];
    expect(results).toHaveLength(1);
    expect(results[0].applied.mode?.ok).toBe(false);
    expect(results[0].applied.mode?.error).toMatch(/mode rejected/);
    // The skipped setters never produced an `applied` entry — keeps the
    // payload honest about what was actually attempted.
    expect(results[0].applied.weightLbs).toBeUndefined();
    expect(results[0].applied.eccentricPercent).toBeUndefined();
    expect(results[0].applied.chainsLbs).toBeUndefined();
  });

  it('empty input (no setter fields) returns INVALID_INPUT — no setters fire', async () => {
    const { isError, payload } = await invoke(reg, {});
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(String(payload.message)).toMatch(/at least one of/i);
    // Sanity: no SDK calls landed.
    for (const slot of [primary, secondary]) {
      expect(slot.client.setMode).not.toHaveBeenCalled();
      expect(slot.client.setWeight).not.toHaveBeenCalled();
      expect(slot.client.setEccentric).not.toHaveBeenCalled();
      expect(slot.client.setChains).not.toHaveBeenCalled();
    }
  });

  it('unbound slot id in `slots` returns INVALID_INPUT before any setter fires', async () => {
    const { isError, payload } = await invoke(reg, {
      slots: ['primary', 'phantom'],
      weightLbs: 50,
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(String(payload.message)).toMatch(/phantom/);
    // Pre-flight check fails ⇒ no setters fired on EITHER slot.
    expect(primary.client.setWeight).not.toHaveBeenCalled();
    expect(secondary.client.setWeight).not.toHaveBeenCalled();
  });

  it('disconnected slot id is rejected the same way as a missing slot id', async () => {
    secondary.client.isConnected = false;
    const { isError, payload } = await invoke(reg, {
      slots: ['primary', 'secondary'],
      weightLbs: 50,
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(String(payload.message)).toMatch(/secondary/);
    expect(primary.client.setWeight).not.toHaveBeenCalled();
    expect(secondary.client.setWeight).not.toHaveBeenCalled();
  });

  it('empty `slots: []` returns INVALID_INPUT — never silently fans out across nothing', async () => {
    const { isError, payload } = await invoke(reg, {
      slots: [],
      weightLbs: 50,
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(String(payload.message)).toMatch(/empty/i);
  });

  it('omitted `slots` defaults to every connected slot in natural order', async () => {
    const { isError, payload } = await invoke(reg, { weightLbs: 60 });
    expect(isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    const results = payload.results as SlotResult[];
    expect(results.map((r) => r.slot)).toEqual(['primary', 'secondary']);
    expect(primary.client.setWeight).toHaveBeenCalledWith(60);
    expect(secondary.client.setWeight).toHaveBeenCalledWith(60);
  });

  it('omitted `slots` skips disconnected slots', async () => {
    secondary.client.isConnected = false;
    const { isError, payload } = await invoke(reg, { weightLbs: 60 });
    expect(isError).toBeUndefined();
    const results = payload.results as SlotResult[];
    expect(results.map((r) => r.slot)).toEqual(['primary']);
    expect(secondary.client.setWeight).not.toHaveBeenCalled();
  });

  it('omitted `slots` with NO connected slots returns INVALID_INPUT', async () => {
    primary.client.isConnected = false;
    secondary.client.isConnected = false;
    const { isError, payload } = await invoke(reg, { weightLbs: 60 });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(String(payload.message)).toMatch(/connected/i);
  });

  it('preserves explicit `slots` order in `results` (slots: [secondary, primary] → that order)', async () => {
    const { isError, payload } = await invoke(reg, {
      slots: ['secondary', 'primary'],
      weightLbs: 50,
    });
    expect(isError).toBeUndefined();
    const results = payload.results as SlotResult[];
    expect(results.map((r) => r.slot)).toEqual(['secondary', 'primary']);
  });

  it('rejects unknown TrainingMode names with INVALID_INPUT (no setters fire)', async () => {
    const { isError, payload } = await invoke(reg, {
      mode: 'TimeMachine',
      weightLbs: 50,
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(primary.client.setMode).not.toHaveBeenCalled();
    expect(primary.client.setWeight).not.toHaveBeenCalled();
  });

  it('rejects out-of-range weightLbs with INVALID_INPUT', async () => {
    const { isError, payload } = await invoke(reg, { weightLbs: 999 });
    expect(isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(primary.client.setWeight).not.toHaveBeenCalled();
  });
});
