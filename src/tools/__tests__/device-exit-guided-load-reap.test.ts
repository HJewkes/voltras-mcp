// F4 + F8 (VMCP-01.19 / VMCP-01.24) — `device.exit_guided_load` lifecycle reap.
//
// Whereas `device-exit-guided-load.test.ts` covers the schema + phase-guard
// surface with a hand-rolled `FakeLive`, this file exercises the new
// auto-reap behavior end-to-end against the real `LiveState`, the real
// `finalizeSet`, and a stub `state.store`. The boundary chosen is:
//
//   * real `LiveState` — so the autoCreatedBy tag + set/session lifecycle
//     mutations exercise their actual implementation
//   * real `set-tools.finalizeSet` (transitive import via `device-tools`)
//   * stub `SessionStore` — we only care that putSet/putSession are called
//     with the expected partialReason / endedAt shape
//   * stub `client` — we only care that `exitGuidedLoad` is invoked and
//     that `endSet` (the SDK-level disengage) is NOT (since the SDK's
//     `exitGuidedLoad` already wrote the exit frame)
//
// Coverage targets (per the F4+F8 brief):
//   1. Active auto-created set → reaped with `partialReason: 'guided_load_exited'`
//   2. No active set → tool still returns ok:true; no error
//   3. Auto-created session is reaped too (allows next session.start)
//   4. Lazy weight re-snapshot — settings_update after arming reaches the
//      persisted row
//   5. F14 regression — guided-load exit does NOT drop a trailing rep
//   6. Explicit session is NOT reaped (autoCreatedBy guard)

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

// The bridge wires onPerRep / onInProgress / etc. callbacks; we don't
// need any of that in these tests, so stub `wireBridgeForSlot` to a
// no-op. Mirrors the approach used in `device-exit-guided-load.test.ts`.
vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { LiveState } = await import('../../state/live-state.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { registerDeviceTools } = await import('../device-tools.js');
const { registerSetTools } = await import('../set-tools.js');

// ── Test fakes ────────────────────────────────────────────────────────────

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
  exitGuidedLoad: Mock<() => Promise<void>>;
  endSet: Mock<() => Promise<void>>;
  // The remaining callbacks/setters are stubbed for type-shape only; the
  // tests below don't exercise them, but `registerDeviceTools` reads their
  // presence when it wires the bridge (the bridge itself is mocked above).
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

function makeFakeClient(): FakeClient {
  return {
    isConnected: true,
    connectionState: 'connected',
    connectedDeviceId: 'VTR-test',
    settings: {
      weight: 30,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.Idle,
      battery: null,
    },
    guidedLoadState: { phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null },
    isRowingActive: false,
    exitGuidedLoad: vi.fn(async () => undefined),
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
  // ServerState is typed as `unknown` here so we can stub the SQLite-typed
  // store + manager + exercises shapes without re-implementing every method.
  // We cast at the registerSetTools / registerDeviceTools call sites.
  state: {
    config: { adapter: string };
    manager: unknown;
    slots: Map<
      string,
      {
        slotId: string;
        client: FakeClient;
        live: InstanceType<typeof LiveState>;
        modeRevertGuard: unknown;
      }
    >;
    store: {
      putSet: Mock<(set: unknown) => Promise<void>>;
      putSession: Mock<(session: unknown) => Promise<void>>;
      getSession: Mock<(id: string) => Promise<unknown>>;
      getSet: Mock<(id: string) => Promise<unknown>>;
      getSetsForSession: Mock<(id: string) => Promise<unknown[]>>;
      listSessions: Mock<() => Promise<unknown[]>>;
      close: Mock<() => Promise<void>>;
    };
    exercises: unknown;
    channels: unknown;
    setStartDeviceSnapshots: Map<
      string,
      ReturnType<InstanceType<typeof LiveState>['snapshotDevice']>
    >;
    setWatchdog: unknown;
  };
  live: InstanceType<typeof LiveState>;
  client: FakeClient;
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ isError?: boolean; payload: Record<string, unknown> }>;
  putSet: Mock<(set: unknown) => Promise<void>>;
  putSession: Mock<(session: unknown) => Promise<void>>;
  channelEvents: Array<{ content: string; meta: Record<string, string> }>;
}

function setup(): Harness {
  const live = new LiveState();
  const client = makeFakeClient();
  const channelEvents: Array<{ content: string; meta: Record<string, string> }> = [];
  const channels = {
    publish: vi.fn(),
    forSlot: (slotId: string) => ({
      publish: (event: unknown) => {
        const e = event as { content: string; meta: Record<string, string> };
        channelEvents.push({ content: e.content, meta: { slot: slotId, ...e.meta } });
      },
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
  };
  const placeholders = makePlaceholders();
  const server = { tool: vi.fn() };
  // Register set-tools first so finalizeSet's path is exercised when
  // device.exit_guided_load reaps the set. Order doesn't strictly matter
  // because each tool only mutates its own placeholder callback, but it
  // matches the production registration order in server.ts.
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
    channelEvents,
  };
}

/**
 * Mint a guided-load auto-created session + set in the harness's LiveState,
 * mirroring what `ensureGuidedLoadSessionAndSet` does in the real bridge.
 * The pre-armed device snapshot reflects the weight the user had set
 * before guided_load took over (30 lbs in our test).
 */
function armGuidedLoadScaffold(
  h: Harness,
  opts: { preArmedWeight?: number } = {},
): {
  sessionId: string;
  setId: string;
} {
  const preArmedWeight = opts.preArmedWeight ?? 30;
  h.live.applySettings({
    connected: true,
    weightLbs: preArmedWeight,
    trainingMode: 'WeightTraining',
  });
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
  h.live.startSet({
    setId,
    sessionId,
    startedAt,
    reps: [],
    status: 'active',
  });
  // Mirror the bridge: capture the start snapshot (which is the stale
  // pre-armed weight, before settings_update propagates the target).
  h.state.setStartDeviceSnapshots.set(setId, h.live.snapshotDevice());
  return { sessionId, setId };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('device.exit_guided_load — F4 / F8 lifecycle reap', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
    h.client.guidedLoadState = {
      phase: 'active',
      countdownRemainingMs: null,
      fitnessModeRaw: 0x0027,
    };
  });

  it('F4: finalizes the auto-created set with partialReason "guided_load_exited"', async () => {
    armGuidedLoadScaffold(h);

    const { isError, payload } = await h.invoke('device.exit_guided_load', {});

    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(h.client.exitGuidedLoad).toHaveBeenCalledTimes(1);
    expect(h.live.set).toBeUndefined();
    expect(h.putSet).toHaveBeenCalledTimes(1);
    const stored = h.putSet.mock.calls[0][0] as { partial: boolean; partialReason: string };
    expect(stored.partial).toBe(true);
    expect(stored.partialReason).toBe('guided_load_exited');
  });

  it('F4: does NOT disengage the motor (SDK exitGuidedLoad already wrote the exit frame)', async () => {
    armGuidedLoadScaffold(h);

    await h.invoke('device.exit_guided_load', {});

    // The SDK-level `endSet` write would be `Workout.STOP`; finalizeSet's
    // `disengageMotor: true` path normally fires it. Reap must pass `false`.
    expect(h.client.endSet).not.toHaveBeenCalled();
  });

  it('F4: returns ok:true and emits no events when no set is active', async () => {
    // Phase is active but the bridge never minted scaffold (e.g., bridge
    // not wired, or set was already closed somehow). Tool must not throw.
    h.live.applySettings({ connected: true, weightLbs: 5, trainingMode: 'WeightTraining' });

    const { isError, payload } = await h.invoke('device.exit_guided_load', {});

    expect(isError).toBeUndefined();
    expect(payload).toEqual({ ok: true });
    expect(h.client.exitGuidedLoad).toHaveBeenCalledTimes(1);
    expect(h.putSet).not.toHaveBeenCalled();
    expect(h.putSession).not.toHaveBeenCalled();
  });

  it('F8: reaps the auto-created session so a subsequent session.start succeeds', async () => {
    armGuidedLoadScaffold(h);
    expect(h.live.session).toBeDefined();

    await h.invoke('device.exit_guided_load', {});

    // Session removed from LiveState — no SESSION_ALREADY_ACTIVE for the
    // next session.start.
    expect(h.live.session).toBeUndefined();
    // And persisted with an endedAt (session.list will surface it as
    // closed rather than dangling).
    expect(h.putSession).toHaveBeenCalledTimes(1);
    const storedSession = h.putSession.mock.calls[0][0] as { endedAt?: string; id: string };
    expect(storedSession.id).toBe('sess-guided-A');
    expect(typeof storedSession.endedAt).toBe('string');
  });

  it('F8: leaves an EXPLICIT session intact (autoCreatedBy guard)', async () => {
    // Caller pre-started a real session via session.start, then ran
    // device.start_guided_load. The bridge's ensureGuidedLoadSessionAndSet
    // mints the set but reuses the existing (untagged) session.
    h.live.applySettings({ connected: true, weightLbs: 30, trainingMode: 'WeightTraining' });
    h.live.startSession({
      sessionId: 'sess-explicit',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
      exerciseName: 'Squat',
      // No autoCreatedBy — this session is the user's, not the bridge's.
    });
    h.live.startSet({
      setId: 'set-X',
      sessionId: 'sess-explicit',
      startedAt: '2025-01-01T00:00:01.000Z',
      reps: [],
      status: 'active',
    });
    h.state.setStartDeviceSnapshots.set('set-X', h.live.snapshotDevice());

    await h.invoke('device.exit_guided_load', {});

    // Set reaped (the bridge minted it on `armed`), but the session
    // is the user's, so it stays open.
    expect(h.live.set).toBeUndefined();
    expect(h.live.session?.sessionId).toBe('sess-explicit');
    expect(h.putSet).toHaveBeenCalledTimes(1);
    expect(h.putSession).not.toHaveBeenCalled();
  });

  it('F4: lazy weight re-snapshot — settings_update after arming reaches the persisted row', async () => {
    // Bridge minted scaffold at pre-armed weight 30 lbs. The user had
    // requested guided_load(targetWeightLbs=5); a tick later, the device
    // pushes a settings_update with weightLbs=5.
    armGuidedLoadScaffold(h, { preArmedWeight: 30 });
    expect(h.live.snapshotDevice().weightLbs).toBe(30);
    // settings_update arrives.
    h.live.applySettings({ connected: true, weightLbs: 5, trainingMode: 'WeightTraining' });
    expect(h.live.snapshotDevice().weightLbs).toBe(5);
    // The start-snapshot the bridge captured is still the stale 30 (we
    // proved this above — snapshot was 30 at arm time).

    await h.invoke('device.exit_guided_load', {});

    expect(h.putSet).toHaveBeenCalledTimes(1);
    const stored = h.putSet.mock.calls[0][0] as { weightLbs: number };
    // The reap path lazily re-snapshots, so the persisted row carries the
    // guided-load target weight, not the pre-armed value.
    expect(stored.weightLbs).toBe(5);
  });

  it('F14 regression: guided-load exit does NOT drop a trailing in-progress rep', async () => {
    const { setId } = armGuidedLoadScaffold(h);
    // Push two reps onto the active set via the LiveState's direct path.
    // Both reps look "in progress" in the sense that they have no eccentric
    // phase — but the dropTrailingInProgress predicate must NOT fire here.
    const inProgressRep = {
      repNumber: 2,
      concentric: {
        samples: [],
        startTime: 0,
        endTime: 0,
        startPosition: 0,
        endPosition: 0,
        _totalVelocity: 0,
        _totalForce: 0,
        _totalLoad: 0,
        _movementSampleCount: 0,
        _totalHoldDuration: 0,
        peakVelocity: 0,
        peakForce: 0,
        peakLoad: 0,
      },
      eccentric: {
        samples: [],
        startTime: 0,
        endTime: 0,
        startPosition: 0,
        endPosition: 0,
        _totalVelocity: 0,
        _totalForce: 0,
        _totalLoad: 0,
        _movementSampleCount: 0,
        _totalHoldDuration: 0,
        peakVelocity: 0,
        peakForce: 0,
        peakLoad: 0,
      },
    };
    h.live.appendRep({ ...inProgressRep, repNumber: 1 });
    h.live.appendRep({ ...inProgressRep, repNumber: 2 });
    void setId;

    await h.invoke('device.exit_guided_load', {});

    expect(h.putSet).toHaveBeenCalledTimes(1);
    const stored = h.putSet.mock.calls[0][0] as { reps: Array<{ index: number }> };
    // Both reps persist; finalizeSet's dropTrailingInProgress predicate
    // only fires for auto_stopped / inactivity_timeout, NOT
    // guided_load_exited.
    expect(stored.reps.length).toBe(2);
  });
});
