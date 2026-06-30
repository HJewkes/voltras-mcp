// VMCP-02.41 — `device.unload` refreshes guided-load state when it tears down
// an active flow.
//
// `unloadDevice()` physically drops the cable but never touches the SDK's
// guided-load state machine, so before this fix `get_state` kept reporting
// `load_state: loaded` / `guided_load.phase: active` after an unload from an
// active phase, and no terminal channel event was published. The fix drives
// the SDK through `exitGuidedLoad()` (which transitions the phase to `exited`,
// firing the bridge's terminal `guided_load_state` publish) and reaps the
// auto-created scaffold — automating the validated unload-then-exit recovery.
//
// This file mirrors the harness in `device-exit-guided-load-reap.test.ts`:
// real `LiveState`, real `finalizeSet`, stub `SessionStore`, stub `client`.
// The stub `exitGuidedLoad` mutates `guidedLoadState.phase` to `'exited'` the
// way the real SDK does, so the `get_state` acceptance can be asserted
// directly. The bridge is mocked, so the channel publish that the real
// `onGuidedLoadState` would emit is covered by the event-bridge tests, not
// here; this file asserts that unload DRIVES `exitGuidedLoad` (the lever that
// fires it).

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

const FakeTrainingModeNames = {
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
  TrainingModeNames: FakeTrainingModeNames,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
}));

// Stub the bridge wiring — its onGuidedLoadState publish is covered by the
// event-bridge tests; here we only need the tool callbacks installed.
vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { LiveState } = await import('../../state/live-state.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { RestTimerRegistry } = await import('../../state/rest-timer.js');
const { registerDeviceTools } = await import('../device-tools.js');
const { registerSetTools } = await import('../set-tools.js');

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
  connectedDeviceId: string | null;
  settings: Record<string, number | null>;
  guidedLoadState: {
    phase: GuidedLoadPhase;
    countdownRemainingMs: number | null;
    fitnessModeRaw: number | null;
  };
  isRowingActive: boolean;
  isRecording: boolean;
  unloadDevice: Mock<() => Promise<void>>;
  exitGuidedLoad: Mock<() => Promise<void>>;
  endSet: Mock<() => Promise<void>>;
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
  enterRowMode: Mock<() => Promise<void>>;
  startRow: Mock<(distance?: string) => Promise<void>>;
}

/**
 * `callLog` records the order of the two teardown writes so a test can assert
 * unload-before-exit. The stub `exitGuidedLoad` mutates `guidedLoadState` the
 * way the real SDK does (`updateGuidedLoadState({ phase: 'exited' })`) so the
 * `get_state` derivation can be exercised faithfully.
 */
function makeFakeClient(callLog: string[]): FakeClient {
  const client: FakeClient = {
    isConnected: true,
    connectionState: 'connected',
    connectedDeviceId: 'VTR-test',
    settings: {
      weight: 30,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.WeightTraining,
      battery: null,
    },
    guidedLoadState: { phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null },
    isRowingActive: false,
    isRecording: false,
    unloadDevice: vi.fn(async () => {
      callLog.push('unloadDevice');
    }),
    exitGuidedLoad: vi.fn(async () => {
      callLog.push('exitGuidedLoad');
      client.guidedLoadState = {
        phase: 'exited',
        countdownRemainingMs: null,
        fitnessModeRaw: null,
      };
    }),
    endSet: vi.fn(async () => undefined),
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
    enterRowMode: vi.fn(async () => undefined),
    startRow: vi.fn(async () => undefined),
  };
  return client;
}

interface FakeRegisteredTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

const TOOL_NAMES = [
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
  'device.unload',
  'device.enter_row_mode',
  'device.start_row',
  'device.get_state',
  'device.send_raw',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
] as const;

function makePlaceholders(): Map<string, FakeRegisteredTool> {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
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

interface Harness {
  state: unknown;
  live: InstanceType<typeof LiveState>;
  client: FakeClient;
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ isError?: boolean; payload: Record<string, unknown> }>;
  putSet: Mock<(set: unknown) => Promise<void>>;
  putSession: Mock<(session: unknown) => Promise<void>>;
  callLog: string[];
}

function setup(): Harness {
  const live = new LiveState();
  const callLog: string[] = [];
  const client = makeFakeClient(callLog);
  const channels = {
    publish: vi.fn(),
    forSlot: (_slotId: string) => ({
      publish: vi.fn(),
      forSlot: channels.forSlot,
    }),
  };
  const putSet = vi.fn(async () => undefined);
  const putSession = vi.fn(async () => undefined);
  const slots = new Map();
  slots.set('primary', {
    slotId: 'primary',
    client,
    live,
    modeRevertGuard: new ModeRevertGuard(),
  });
  const state = {
    config: { adapter: 'node' },
    manager: {},
    slots,
    store: {
      putSet,
      putSession,
      getSession: vi.fn(async () => undefined),
      getSet: vi.fn(async () => undefined),
      getSetsForSession: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    },
    exercises: {},
    channels,
    setStartDeviceSnapshots: new Map(),
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
  };
  const placeholders = makePlaceholders();
  const server = { tool: vi.fn() };
  registerSetTools(
    server as Parameters<typeof registerSetTools>[0],
    state as Parameters<typeof registerSetTools>[1],
    placeholders as unknown as Parameters<typeof registerSetTools>[2],
  );
  registerDeviceTools(
    server as Parameters<typeof registerDeviceTools>[0],
    state as Parameters<typeof registerDeviceTools>[1],
    placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
  );
  return {
    state,
    live,
    client,
    placeholders,
    invoke: async (name, args) => {
      const reg = placeholders.get(name);
      if (reg === undefined) throw new Error(`unknown tool ${name}`);
      const result = (await reg.callback(args)) as {
        isError?: boolean;
        content: Array<{ type: 'text'; text: string }>;
      };
      return {
        isError: result.isError,
        payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
      };
    },
    putSet,
    putSession,
    callLog,
  };
}

/**
 * Mint a guided-load auto-created session + set in the harness's LiveState,
 * mirroring `ensureGuidedLoadSessionAndSet` in the real bridge.
 */
function armGuidedLoadScaffold(h: Harness): { sessionId: string; setId: string } {
  h.live.applySettings({ connected: true, weightLbs: 95, trainingMode: 'WeightTraining' });
  const sessionId = 'sess-guided-A';
  const setId = 'set-guided-A';
  const startedAt = '2025-01-01T00:00:00.000Z';
  h.live.startSession({
    sessionId,
    startedAt,
    setIds: [],
    status: 'active',
    exerciseName: 'Guided Load (auto)',
    autoCreatedBy: 'guided_load',
  });
  h.live.startSet({ setId, sessionId, startedAt, reps: [], status: 'active' });
  (h.state as { setStartDeviceSnapshots: Map<string, unknown> }).setStartDeviceSnapshots.set(
    setId,
    h.live.snapshotDevice(),
  );
  return { sessionId, setId };
}

describe('device.unload — VMCP-02.41 guided-load teardown', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('from an active guided-load phase: unloads, then drives exitGuidedLoad (in that order)', async () => {
    h.client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    armGuidedLoadScaffold(h);

    const { isError, payload } = await h.invoke('device.unload', {});

    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(h.client.unloadDevice).toHaveBeenCalledTimes(1);
    expect(h.client.exitGuidedLoad).toHaveBeenCalledTimes(1);
    // Physical release first, software-state cleanup second.
    expect(h.callLog).toEqual(['unloadDevice', 'exitGuidedLoad']);
  });

  it('refreshes get_state to load_state=unloaded / guided_load.phase=exited', async () => {
    h.client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    armGuidedLoadScaffold(h);

    // Pre-condition: the ticket's bug — get_state reports stale loaded/active.
    const before = await h.invoke('device.get_state', {});
    expect(before.payload.load_state).toBe('loaded');
    expect((before.payload.guided_load as { phase: string }).phase).toBe('active');

    await h.invoke('device.unload', {});

    const after = await h.invoke('device.get_state', {});
    expect(after.payload.load_state).toBe('unloaded');
    expect((after.payload.guided_load as { phase: string }).phase).toBe('exited');
  });

  it('reaps the auto-created set with partialReason "guided_load_exited" and ends the auto session', async () => {
    h.client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    armGuidedLoadScaffold(h);
    expect(h.live.session).toBeDefined();

    await h.invoke('device.unload', {});

    expect(h.live.set).toBeUndefined();
    expect(h.live.session).toBeUndefined();
    expect(h.putSet).toHaveBeenCalledTimes(1);
    const storedSet = h.putSet.mock.calls[0][0] as { partial: boolean; partialReason: string };
    expect(storedSet.partial).toBe(true);
    expect(storedSet.partialReason).toBe('guided_load_exited');
    expect(h.putSession).toHaveBeenCalledTimes(1);
    // The SDK exitGuidedLoad already wrote the exit frame; reap must not
    // re-fire the motor-disengage.
    expect(h.client.endSet).not.toHaveBeenCalled();
  });

  it('leaves an EXPLICIT (non-auto) session intact when unloading from active', async () => {
    h.client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
    h.live.applySettings({ connected: true, weightLbs: 95, trainingMode: 'WeightTraining' });
    h.live.startSession({
      sessionId: 'sess-explicit',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
      exerciseName: 'Chest Fly',
    });
    h.live.startSet({
      setId: 'set-X',
      sessionId: 'sess-explicit',
      startedAt: '2025-01-01T00:00:01.000Z',
      reps: [],
      status: 'active',
    });
    (h.state as { setStartDeviceSnapshots: Map<string, unknown> }).setStartDeviceSnapshots.set(
      'set-X',
      h.live.snapshotDevice(),
    );

    await h.invoke('device.unload', {});

    expect(h.client.exitGuidedLoad).toHaveBeenCalledTimes(1);
    expect(h.live.set).toBeUndefined();
    expect(h.live.session?.sessionId).toBe('sess-explicit');
    expect(h.putSession).not.toHaveBeenCalled();
  });

  it('regression — from idle (not in guided-load): unloads only, no exitGuidedLoad, no reap', async () => {
    // guidedLoadState defaults to phase 'idle'. Mint an auto scaffold to prove
    // the reap does NOT fire when we are not in an active guided-load phase.
    armGuidedLoadScaffold(h);

    const { isError, payload } = await h.invoke('device.unload', {});

    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(h.client.unloadDevice).toHaveBeenCalledTimes(1);
    expect(h.client.exitGuidedLoad).not.toHaveBeenCalled();
    expect(h.putSet).not.toHaveBeenCalled();
    expect(h.live.session).toBeDefined();
  });
});
