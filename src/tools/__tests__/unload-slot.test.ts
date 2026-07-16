// VMCP-02.78 P6 — the reusable `unloadSlot` primitive and the
// `isSafetyUnloadWarranted` predicate that the voice safety fast-path drives
// WITHOUT an MCP/LLM round-trip. `unloadSlot` is the extracted single source of
// truth behind the `device.unload` tool; this file covers the primitives in
// isolation plus a behavior-preservation check on the tool callback.

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
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  TrainingModeNames: {},
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
}));

// The bridge's onGuidedLoadState publish is covered by the event-bridge tests;
// here we only need the tool callbacks installable.
vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { unloadSlot, isSafetyUnloadWarranted, registerDeviceTools } =
  await import('../device-tools.js');

type GuidedLoadPhase =
  | 'idle'
  | 'armed'
  | 'countdown'
  | 'engaging'
  | 'active'
  | 'exited'
  | 'timeout';

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  guidedLoadState: { phase: GuidedLoadPhase; countdownRemainingMs: number | null };
  isRowingActive: boolean;
  unloadDevice: Mock<() => Promise<void>>;
  exitGuidedLoad: Mock<() => Promise<void>>;
}

interface FakeLive {
  session: undefined;
  set: undefined;
  snapshotSet: Mock<() => { status: string } | undefined>;
}

interface Fixture {
  state: unknown;
  client: FakeClient;
  live: FakeLive;
}

function makeFixture(overrides: {
  isConnected?: boolean;
  phase?: GuidedLoadPhase;
  isRowingActive?: boolean;
  activeSet?: { status: string } | undefined;
}): Fixture {
  const client: FakeClient = {
    isConnected: overrides.isConnected ?? true,
    connectionState: 'connected',
    guidedLoadState: { phase: overrides.phase ?? 'idle', countdownRemainingMs: null },
    isRowingActive: overrides.isRowingActive ?? false,
    unloadDevice: vi.fn(async () => undefined),
    exitGuidedLoad: vi.fn(async () => undefined),
  };
  const live: FakeLive = {
    session: undefined,
    set: undefined,
    snapshotSet: vi.fn(() => overrides.activeSet),
  };
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live, modeRevertGuard: {} });
  const state = {
    slots,
    store: { putSession: vi.fn(async () => undefined), putSet: vi.fn(async () => undefined) },
    setStartDeviceSnapshots: new Map(),
  };
  return { state, client, live };
}

describe('unloadSlot', () => {
  it('unloads the cable exactly once', async () => {
    const { state, client } = makeFixture({ phase: 'idle' });
    await unloadSlot(state as never, 'primary');
    expect(client.unloadDevice).toHaveBeenCalledTimes(1);
  });

  it('from idle: does NOT drive exitGuidedLoad (no active flow to tear down)', async () => {
    const { state, client } = makeFixture({ phase: 'idle' });
    await unloadSlot(state as never, 'primary');
    expect(client.exitGuidedLoad).not.toHaveBeenCalled();
  });

  it.each<GuidedLoadPhase>(['armed', 'countdown', 'engaging', 'active'])(
    'from active phase %s: unloads AND drives exitGuidedLoad',
    async (phase) => {
      const { state, client } = makeFixture({ phase });
      await unloadSlot(state as never, 'primary');
      expect(client.unloadDevice).toHaveBeenCalledTimes(1);
      expect(client.exitGuidedLoad).toHaveBeenCalledTimes(1);
    },
  );
});

describe('isSafetyUnloadWarranted', () => {
  it('disconnected → not warranted (nothing to unload)', () => {
    const { state } = makeFixture({ isConnected: false, activeSet: { status: 'active' } });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: false,
      reason: 'none',
    });
  });

  it('active set → warranted via active_set (operative gate for weight-training)', () => {
    const { state } = makeFixture({ activeSet: { status: 'active' } });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: true,
      reason: 'active_set',
    });
  });

  it('no active set but guided-load active → warranted via loaded', () => {
    const { state } = makeFixture({ phase: 'active', activeSet: undefined });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: true,
      reason: 'loaded',
    });
  });

  it('no active set but guided-load engaging → warranted via loaded', () => {
    const { state } = makeFixture({ phase: 'engaging', activeSet: undefined });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: true,
      reason: 'loaded',
    });
  });

  it('rowing active → warranted via loaded', () => {
    const { state } = makeFixture({ isRowingActive: true, activeSet: undefined });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: true,
      reason: 'loaded',
    });
  });

  it('ended set does not count as active → not warranted when idle+unloaded', () => {
    const { state } = makeFixture({ activeSet: { status: 'ended' } });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: false,
      reason: 'none',
    });
  });

  it('connected + idle + no set → not warranted', () => {
    const { state } = makeFixture({ activeSet: undefined });
    expect(isSafetyUnloadWarranted(state as never, 'primary')).toEqual({
      warranted: false,
      reason: 'none',
    });
  });
});

interface FakeRegisteredTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<(updates: { callback?: FakeRegisteredTool['callback'] }) => void>;
}

describe('device.unload tool — behavior preserved through the extraction', () => {
  let fixture: Fixture;
  let placeholders: Map<string, FakeRegisteredTool>;

  beforeEach(() => {
    fixture = makeFixture({ phase: 'idle' });
    placeholders = new Map();
    const reg: FakeRegisteredTool = {
      callback: async () => ({ content: [{ type: 'text', text: '{}' }], isError: true }),
      update: vi.fn((updates) => {
        if (updates.callback) reg.callback = updates.callback;
      }),
    };
    placeholders.set('device.unload', reg);
    registerDeviceTools({ tool: vi.fn() } as never, fixture.state as never, placeholders as never);
  });

  it('still returns {ok:true} and drives the extracted unload', async () => {
    const reg = placeholders.get('device.unload');
    const result = (await reg!.callback({})) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    expect(fixture.client.unloadDevice).toHaveBeenCalledTimes(1);
  });
});
