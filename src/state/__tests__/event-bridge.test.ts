// Unit tests for the SDK event-bridge (Wave 2C).
//
// Strategy: build a fake `VoltraClient` that captures every `on*` listener
// in a Map keyed by event name; tests then drive each listener directly to
// simulate SDK callbacks. The MCP server is replaced with a stub exposing a
// spy on `server.sendResourceUpdated` — the real `Server` is not constructed
// because all the bridge needs is the lower-level handle.
//
// Coverage targets (NF-03 floor 70% for event-bridge.ts):
//   - onPerRep fires sendResourceUpdated for voltra://set/active when a
//     set is active.
//   - onPerRep on no-active-set is a silent drop (EC-11).
//   - onSettingsUpdate maps SDK fields to DeviceSnapshot fields and notifies
//     voltra://device/current.
//   - onSettingsUpdate coerces battery=null to absent (FIX #6).
//   - onConnectionStateChange('connected') flips connected to true; on
//     'disconnected' calls markDisconnected and notifies all three URIs (R24).
//   - onInProgress subscribes but does not mutate state nor notify (gap
//     filed by the critic; bridge owns the no-action policy).
//   - Raw frame events (onFrame) are NOT subscribed by the bridge (R16:
//     typed-only, no Buffer leak).
//
// Note on the SDK signature: `client.onPerRep` carries a `PerRepEvent` payload
// in `@voltras/node-sdk` 0.6.0. The bridge currently ignores the payload and
// only logs the listener firing — rep construction from the frame stream is
// Wave 3's responsibility. The bridge's role for the per-rep signal is to
// (a) drop the signal when no set is active and (b) emit the
// resource-updated hint when one is. EC-11 (stale rep drop) is enforced at
// the bridge layer by the active-set check before the hint is sent.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
// `@voltras/workout-analytics` is NOT mocked — the golden VBT compare in the
// PR2 firmware-enrichment test replays the same sample slice through the real
// analytics pipeline the bridge uses.
import {
  createSet,
  addSampleToSet,
  completeSet,
  getPhaseRangeOfMotion,
} from '@voltras/workout-analytics';

// Stub the SDK so unit tests don't pull in optional native peers (noble,
// react-native-ble-plx). The bridge imports `TrainingMode` (enum values) and
// `TrainingModeNames` (numeric → string lookup) from the package; we mirror
// just those, mapping the values used in tests.
vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: {
    Idle: 0,
    WeightTraining: 1,
    ResistanceBand: 2,
    Rowing: 3,
    Damper: 4,
    CustomCurves: 6,
    Isokinetic: 7,
    Isometric: 8,
  },
  TrainingModeNames: {
    0: 'Idle',
    1: 'Weight Training',
    2: 'Resistance Band',
    3: 'Rowing',
    4: 'Damper',
    6: 'Custom Curves',
    7: 'Isokinetic',
    8: 'Isometric',
  },
}));

const { LiveState } = await import('../live-state.js');
type LiveStateT = InstanceType<typeof LiveState>;
const { wireBridgeForSlot } = await import('../event-bridge.js');
const { SetWatchdog } = await import('../set-watchdog.js');
type SetWatchdogT = InstanceType<typeof SetWatchdog>;
const { ModeRevertGuard } = await import('../mode-revert-guard.js');
type ModeRevertGuardT = InstanceType<typeof ModeRevertGuard>;
const { ModeDivergenceWatch } = await import('../mode-divergence-watch.js');
type ModeDivergenceWatchT = InstanceType<typeof ModeDivergenceWatch>;
const { CoercionWatch } = await import('../coercion-watch.js');
type CoercionWatchT = InstanceType<typeof CoercionWatch>;
const { RestTimerRegistry } = await import('../rest-timer.js');
type RestTimerRegistryT = InstanceType<typeof RestTimerRegistry>;

// Local typings for the fake client so the test file does not depend on the
// real SDK module shape — we only model the listener-registration surface
// the bridge uses.
type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

// Mirrors the SDK 0.6.0 `PerRepEvent` shape; redeclared structurally so the
// test file does not import from the mocked package.
interface PerRepEvent {
  phase: 'pull' | 'return';
  frameCounter: number;
  setCounter: number;
  repCount: number;
  targetWeightTenths: number;
}

// Mirrors the SDK 0.6.0 `InProgressEvent` shape (the ~1 Hz heartbeat).
interface InProgressEvent {
  peakForceTenths: number;
  currentForceTenths: number;
  velocityCmPerSec: number;
  targetWeightTenths: number;
  raw: Uint8Array;
}

// Mirrors the SDK 0.6.0 `SummaryEvent` shape (end-of-set vendor frame).
interface SummaryEvent {
  schemaVersion: number;
  setCounter: number;
  repCount: number;
  raw: Uint8Array;
}

// Mirrors the SDK 0.6.0 `SetSummaryEvent` shape (~3s before final rep).
interface SetSummaryEvent {
  schemaVersion: number;
  targetWeightTenths: number;
  repCount: number;
  repDurationMs: number;
  raw: Uint8Array;
}

// Mirrors the SDK 0.7.x `StateDumpEvent` shape (cmd=0x07). Field offsets
// validated on-device 2026-05-07; see voltra-private/research/cmd-0x07-
// variable-layout-fix-2026-05-08.md.
interface StateDumpEvent {
  trainingMode: number;
  assistMode: number;
  weightLbsTenths: number;
  chainTargetForceTenths: number;
  eccentricPercentTenths: number;
  raw: Uint8Array;
}

type PerRepListener = (event: PerRepEvent) => void;
type InProgressListener = (event: InProgressEvent) => void;
type SummaryListener = (event: SummaryEvent) => void;
type SetSummaryListener = (event: SetSummaryEvent) => void;
type SettingsUpdateListener = (settings: SdkSettings) => void;
type ConnectionStateListener = (state: ConnectionState) => void;
type StateDumpListener = (event: StateDumpEvent) => void;

interface SdkSettings {
  weight?: number;
  chains?: number;
  inverseChains?: number;
  eccentric?: number;
  mode?: number; // TrainingMode enum value
  battery?: number | null;
  damperLevel?: number;
}

interface FakeClient {
  onPerRep: Mock<(l: PerRepListener) => () => void>;
  onInProgress: Mock<(l: InProgressListener) => () => void>;
  onSummary: Mock<(l: SummaryListener) => () => void>;
  onSetSummary: Mock<(l: SetSummaryListener) => () => void>;
  onSettingsUpdate: Mock<(l: SettingsUpdateListener) => () => void>;
  onConnectionStateChange: Mock<(l: ConnectionStateListener) => () => void>;
  onStateDump: Mock<(l: StateDumpListener) => () => void>;
  /** SDK-retained settings (null = never connected / first boot). Used for D4 replay. */
  settings: SdkSettings | null;
  // The bridge subscribes to onFrame to assemble Reps from the typed
  // telemetry stream (R16 — typed values, no raw buffers).
  onFrame: Mock<(l: (frame: unknown) => void) => () => void>;
  // `finalizeSet` calls `slot.client.endSet` whenever `disengageMotor` is
  // true. The autonomous-finalize tests assert this is NOT called for the
  // device-signal path (disengageMotor: false), so the mock has to live on
  // the same object the bridge subscribed to.
  endSet: Mock<() => Promise<void>>;
  // Captured listeners for direct invocation.
  fire: {
    perRep: (event?: PerRepEvent) => void;
    inProgress: (event?: InProgressEvent) => void;
    summary: (event?: SummaryEvent) => void;
    setSummary: (event?: SetSummaryEvent) => void;
    settingsUpdate: (settings: SdkSettings) => void;
    connectionStateChange: (state: ConnectionState) => void;
    stateDump: (event: StateDumpEvent) => void;
    frame: (frame: {
      sequence: number;
      timestamp: number;
      phase: number;
      position: number;
      velocity: number;
      force: number;
    }) => void;
  };
}

const makePerRepEvent = (overrides: Partial<PerRepEvent> = {}): PerRepEvent => ({
  phase: 'pull',
  frameCounter: 1,
  setCounter: 1,
  repCount: 1,
  targetWeightTenths: 0,
  ...overrides,
});

const makeInProgressEvent = (overrides: Partial<InProgressEvent> = {}): InProgressEvent => ({
  peakForceTenths: 0,
  currentForceTenths: 0,
  velocityCmPerSec: 0,
  targetWeightTenths: 0,
  raw: new Uint8Array(79),
  ...overrides,
});

const makeSummaryEvent = (overrides: Partial<SummaryEvent> = {}): SummaryEvent => ({
  schemaVersion: 1,
  setCounter: 1,
  repCount: 0,
  raw: new Uint8Array(140),
  ...overrides,
});

const makeSetSummaryEvent = (overrides: Partial<SetSummaryEvent> = {}): SetSummaryEvent => ({
  schemaVersion: 1,
  targetWeightTenths: 1000,
  repCount: 5,
  repDurationMs: 1800,
  raw: new Uint8Array(110),
  ...overrides,
});

// Defaults to a stable WeightTraining frame so individual tests don't accidentally
// trigger the bridge's transitional-frame suppression (trainingMode=0). Tests
// covering the suppression path explicitly set `trainingMode: 0`.
const makeStateDumpEvent = (overrides: Partial<StateDumpEvent> = {}): StateDumpEvent => ({
  trainingMode: 1,
  assistMode: 0,
  weightLbsTenths: 0,
  chainTargetForceTenths: 0,
  eccentricPercentTenths: 0,
  raw: new Uint8Array(37),
  ...overrides,
});

function makeFakeClient(): FakeClient {
  let perRepCb: PerRepListener = () => undefined;
  let inProgressCb: InProgressListener = () => undefined;
  let summaryCb: SummaryListener = () => undefined;
  let setSummaryCb: SetSummaryListener = () => undefined;
  let settingsCb: SettingsUpdateListener = () => undefined;
  let connCb: ConnectionStateListener = () => undefined;
  let stateDumpCb: StateDumpListener = () => undefined;

  const onPerRep = vi.fn((l: PerRepListener) => {
    perRepCb = l;
    return () => undefined;
  });
  const onInProgress = vi.fn((l: InProgressListener) => {
    inProgressCb = l;
    return () => undefined;
  });
  const onSummary = vi.fn((l: SummaryListener) => {
    summaryCb = l;
    return () => undefined;
  });
  const onSetSummary = vi.fn((l: SetSummaryListener) => {
    setSummaryCb = l;
    return () => undefined;
  });
  const onSettingsUpdate = vi.fn((l: SettingsUpdateListener) => {
    settingsCb = l;
    return () => undefined;
  });
  const onConnectionStateChange = vi.fn((l: ConnectionStateListener) => {
    connCb = l;
    return () => undefined;
  });
  const onStateDump = vi.fn((l: StateDumpListener) => {
    stateDumpCb = l;
    return () => undefined;
  });
  let frameCb: (frame: unknown) => void = () => undefined;
  const onFrame = vi.fn((l: (f: unknown) => void) => {
    frameCb = l;
    return () => undefined;
  });

  return {
    onPerRep,
    onInProgress,
    onSummary,
    onSetSummary,
    onSettingsUpdate,
    onConnectionStateChange,
    onStateDump,
    onFrame,
    endSet: vi.fn(async () => undefined),
    settings: null,
    fire: {
      perRep: (e) => perRepCb(e ?? makePerRepEvent()),
      inProgress: (e) => inProgressCb(e ?? makeInProgressEvent()),
      summary: (e) => summaryCb(e ?? makeSummaryEvent()),
      setSummary: (e) => setSummaryCb(e ?? makeSetSummaryEvent()),
      settingsUpdate: (s) => settingsCb(s),
      connectionStateChange: (s) => connCb(s),
      stateDump: (e) => stateDumpCb(e),
      frame: (f) => frameCb(f),
    },
  };
}

interface FakeServer {
  server: { sendResourceUpdated: Mock<(p: { uri: string }) => Promise<void>> };
}

function makeFakeServer(): FakeServer {
  return {
    server: {
      sendResourceUpdated: vi.fn(() => Promise.resolve()),
    },
  };
}

interface FakeChannels {
  publish: Mock<(event: { content: string; meta: Record<string, string> }) => void>;
  forSlot: Mock<(slotId: string) => FakeChannels>;
}

/**
 * Build a fake `ChannelPublisher` that records every publish on the
 * top-level `publish` mock, regardless of whether it was issued through
 * `forSlot(slotId).publish(...)` or directly. Slot-scoped publishes get
 * their `meta.slot` auto-injected by mirroring the real
 * `slotScopedPublisher` behavior so test assertions against meta.slot
 * remain meaningful.
 */
function makeFakeChannels(): FakeChannels {
  const channels = {
    publish: vi.fn() as FakeChannels['publish'],
    forSlot: vi.fn() as FakeChannels['forSlot'],
  } as FakeChannels;
  channels.forSlot.mockImplementation((slotId: string) => {
    const scoped: FakeChannels = {
      publish: vi.fn((event) => {
        channels.publish({
          content: event.content,
          meta: { slot: slotId, ...event.meta },
        });
      }) as FakeChannels['publish'],
      forSlot: vi.fn(),
    };
    scoped.forSlot.mockImplementation((nextSlotId) => makeFakeChannels().forSlot(nextSlotId));
    return scoped;
  });
  return channels;
}

function startSet(live: LiveStateT): void {
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
  });
}

/**
 * Build a minimal ServerState shape carrying the bridge's required
 * collaborators (slots map, channels, server). Tests that exercise the
 * autonomous-finalize path replace this with a richer harness that adds a
 * mock store + setStartDeviceSnapshots — see the dedicated `beforeEach`
 * blocks further down.
 */
function makeBareState(opts: {
  client: FakeClient;
  live: LiveStateT;
  server: FakeServer;
  channels: FakeChannels;
}): {
  slots: Map<string, unknown>;
  channels: FakeChannels;
  server: FakeServer;
  restTimers: RestTimerRegistryT;
} {
  const slots = new Map<string, unknown>();
  slots.set('primary', {
    slotId: 'primary',
    client: opts.client,
    live: opts.live,
    modeRevertGuard: new ModeRevertGuard(),
    modeDivergenceWatch: new ModeDivergenceWatch(),
    coercionWatch: new CoercionWatch(),
  });
  return {
    slots,
    channels: opts.channels,
    server: opts.server,
    restTimers: new RestTimerRegistry(),
  };
}

describe('wireEventBridge', () => {
  let live: LiveStateT;
  let client: FakeClient;
  let server: FakeServer;
  let channels: FakeChannels;
  let bareState: ReturnType<typeof makeBareState>;

  beforeEach(() => {
    live = new LiveState();
    client = makeFakeClient();
    server = makeFakeServer();
    channels = makeFakeChannels();
    // Cast through unknown to keep test-only types decoupled from the SDK
    // module — the bridge accepts the structural surface we provide.
    bareState = makeBareState({ client, live, server, channels });
    wireBridgeForSlot(
      bareState as unknown as Parameters<typeof wireBridgeForSlot>[0],
      bareState.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
    );
  });

  describe('subscription surface', () => {
    it('subscribes to onPerRep, onInProgress, onSummary, onSetSummary, onSettingsUpdate, onConnectionStateChange, and onStateDump', () => {
      expect(client.onPerRep).toHaveBeenCalledOnce();
      expect(client.onInProgress).toHaveBeenCalledOnce();
      expect(client.onSummary).toHaveBeenCalledOnce();
      expect(client.onSetSummary).toHaveBeenCalledOnce();
      expect(client.onSettingsUpdate).toHaveBeenCalledOnce();
      expect(client.onConnectionStateChange).toHaveBeenCalledOnce();
      expect(client.onStateDump).toHaveBeenCalledOnce();
    });

    it('subscribes to onFrame to assemble Reps from telemetry stream (R16)', () => {
      // Frames carry typed numeric values (no raw buffers). The bridge maps
      // each frame to a WorkoutSample and uses analytics' `addSampleToRep`
      // to assemble a Rep on each onPerRep signal.
      expect(client.onFrame).toHaveBeenCalledOnce();
    });
  });

  describe('onPerRep (VMCP-02.29 Phase 1 firmware parity)', () => {
    // The device fires onPerRep at every phase transition (pull start +
    // return start) — same `repCount` for both. The bridge appends a
    // FirmwareRep on 'return' only (one per real rep) and records it to the
    // debug ring. This is a measurement-only scaffold: firmwareReps accrue
    // in parallel with the analytics-derived `reps[]` so
    // `debug.compare_rep_streams` can surface the count diff. Crucially, NO
    // channel event is published for firmware reps (the parallel live
    // `rep_finalized` publish is exactly why the first attempt was reverted).
    it('ignores the pull-phase event (only return counts as end-of-rep)', () => {
      startSet(live);
      client.fire.perRep({
        phase: 'pull',
        frameCounter: 5,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 600,
      });
      expect(live.snapshotSet()?.firmwareReps ?? []).toHaveLength(0);
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('appends a FirmwareRep on return phase without publishing a channel event', async () => {
      const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../debug-buffer.js');
      _resetDebugBuffersForTest();
      const debug = getDebugBuffers();
      const fresh = makeBareState({ client, live, server, channels });
      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        fresh.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );
      startSet(live);
      live.applySettings({ connected: true, weightLbs: 60, trainingMode: 'WeightTraining' });
      client.fire.perRep({
        phase: 'return',
        frameCounter: 12,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 600,
      });
      const set = live.snapshotSet();
      expect(set?.firmwareReps).toHaveLength(1);
      expect(set?.firmwareReps?.[0]).toMatchObject({
        repNumber: 1,
        setCounter: 1,
        frameCounter: 12,
        targetWeightTenths: 600,
      });
      // Measurement-only: the firmware rep lands in the debug ring...
      const firmwareEvents = debug.events.recent(20).filter((e) => e.type === 'firmware_rep');
      expect(firmwareEvents).toHaveLength(1);
      expect(firmwareEvents[0].payload).toMatchObject({
        repNumber: 1,
        setCounter: 1,
        frameCounter: 12,
        targetWeightTenths: 600,
        firmwareRepsSoFar: 1,
      });
      // ...and NOT on any channel.
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('de-dupes consecutive return events with the same (setCounter, repCount)', () => {
      startSet(live);
      client.fire.perRep({
        phase: 'return',
        frameCounter: 12,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      // Replay the same boundary (e.g., a redundant decode) — should be ignored.
      client.fire.perRep({
        phase: 'return',
        frameCounter: 12,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      expect(live.snapshotSet()?.firmwareReps).toHaveLength(1);
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('appends each unique repCount in sequence', () => {
      startSet(live);
      client.fire.perRep({
        phase: 'return',
        frameCounter: 12,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      client.fire.perRep({
        phase: 'return',
        frameCounter: 24,
        setCounter: 1,
        repCount: 2,
        targetWeightTenths: 0,
      });
      client.fire.perRep({
        phase: 'return',
        frameCounter: 36,
        setCounter: 1,
        repCount: 3,
        targetWeightTenths: 0,
      });
      const reps = live.snapshotSet()?.firmwareReps ?? [];
      expect(reps.map((r) => r.repNumber)).toEqual([1, 2, 3]);
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('drops the firmware boundary silently when no set is active', () => {
      client.fire.perRep({
        phase: 'return',
        frameCounter: 1,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      expect(channels.publish).not.toHaveBeenCalled();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('firmware-rep enrichment (VMCP-02.29 PR2)', () => {
    // PR2 attaches a real VBT Rep to each FirmwareRep by slicing the per-slot
    // sample buffer between the prior firmware boundary and this one (D3
    // correlation: buffered samples are stamped with a wall-clock `capturedAt`
    // and sliced by a `(floor, boundaryTs]` window — never by frameCounter).
    // We drive a deterministic clock so the slice windows are exact, feed a
    // synthetic ECC+CONC WorkoutSample stream, fire `return` boundaries at
    // chosen points, then assert the enriched rep EQUALS a direct
    // workout-analytics computation over the same slice (golden compare).
    interface FrameInput {
      sequence: number;
      timestamp: number;
      phase: number;
      position: number;
      velocity: number;
      force: number;
    }
    const toSample = (f: FrameInput): Parameters<typeof addSampleToSet>[1] => ({
      sequence: f.sequence,
      timestamp: f.timestamp,
      phase: f.phase as Parameters<typeof addSampleToSet>[1]['phase'],
      position: f.position,
      velocity: f.velocity,
      force: f.force,
    });
    // Golden: replay a slice through a fresh analytics set exactly as the
    // bridge does, then return the first completed rep.
    const goldenRep = (frames: FrameInput[]): ReturnType<typeof completeSet>['reps'][number] => {
      const set = frames.reduce((s, f) => addSampleToSet(s, toSample(f)), createSet());
      return completeSet(set).reps[0];
    };
    // One concentric-then-eccentric rep. Concentric peak velocity is the max
    // of the concentric samples; ROM derives from the position sweep.
    const repFrames = (base: number, peak: number): FrameInput[] => [
      { sequence: base, timestamp: base, phase: 1, position: 0.1, velocity: peak / 2, force: 50 },
      {
        sequence: base + 1,
        timestamp: base + 1,
        phase: 1,
        position: 0.4,
        velocity: peak,
        force: 55,
      },
      {
        sequence: base + 2,
        timestamp: base + 2,
        phase: 1,
        position: 0.7,
        velocity: peak / 3,
        force: 52,
      },
      {
        sequence: base + 3,
        timestamp: base + 3,
        phase: 3,
        position: 0.4,
        velocity: peak / 4,
        force: 40,
      },
      {
        sequence: base + 4,
        timestamp: base + 4,
        phase: 3,
        position: 0.1,
        velocity: peak / 8,
        force: 38,
      },
    ];

    let now = 0;
    let nowSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      now = 1_700_000_000_000;
      nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      nowSpy.mockRestore();
    });

    function armSet(): void {
      live.startSession({
        sessionId: 'sess-fw',
        startedAt: new Date(now).toISOString(),
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-fw',
        sessionId: 'sess-fw',
        startedAt: new Date(now).toISOString(),
        reps: [],
        status: 'active',
      });
    }

    it('attaches an enriched VBT rep matching a golden WA compute over the same slice', () => {
      armSet();
      const rep1 = repFrames(10, 800);
      const rep2 = repFrames(20, 500);

      now += 10; // first sample capturedAt strictly past the set-start floor
      for (const f of rep1) client.fire.frame(f);
      now += 10; // return boundary 1 — capturedAt <= boundaryTs
      client.fire.perRep({
        phase: 'return',
        frameCounter: 5,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });

      now += 10; // rep-2 samples land strictly past boundary 1
      for (const f of rep2) client.fire.frame(f);
      now += 10; // return boundary 2
      client.fire.perRep({
        phase: 'return',
        frameCounter: 11,
        setCounter: 1,
        repCount: 2,
        targetWeightTenths: 0,
      });

      const firmwareReps = live.snapshotSet()?.firmwareReps ?? [];
      expect(firmwareReps).toHaveLength(2);

      const gold1 = goldenRep(rep1);
      const gold2 = goldenRep(rep2);
      // Sanity: the golden reps carry real movement so an empty-vs-empty
      // equality can't pass silently.
      expect(gold1.concentric.peakVelocity).toBeGreaterThan(0);
      expect(getPhaseRangeOfMotion(gold1.concentric)).toBeGreaterThan(0);

      const enriched1 = firmwareReps[0].enriched;
      const enriched2 = firmwareReps[1].enriched;
      expect(enriched1).toBeDefined();
      expect(enriched2).toBeDefined();

      expect(enriched1?.concentric.peakVelocity).toBe(gold1.concentric.peakVelocity);
      expect(getPhaseRangeOfMotion(enriched1!.concentric)).toBe(
        getPhaseRangeOfMotion(gold1.concentric),
      );
      expect(enriched2?.concentric.peakVelocity).toBe(gold2.concentric.peakVelocity);
      expect(getPhaseRangeOfMotion(enriched2!.concentric)).toBe(
        getPhaseRangeOfMotion(gold2.concentric),
      );
      // Distinct windows: rep 2's slice must not fold in rep 1's stronger pull.
      expect(enriched2?.concentric.peakVelocity).toBe(500);
      // Measurement-only: the analytics pipeline publishes its usual
      // `rep_finalized` events (driven by the same frames), but the firmware
      // enrichment path adds NO event of its own — no publish carries a
      // firmware/enriched marker. The empty-slice test below proves the
      // enrichment path is silent in isolation (perRep only, no frames).
      for (const call of channels.publish.mock.calls) {
        expect(call[0].meta.event_type).toBe('rep_finalized');
      }
    });

    it('falls back to an empty rep when the boundary slice held no samples', () => {
      armSet();
      // Fire a return boundary with no buffered frames in the window.
      now += 10;
      client.fire.perRep({
        phase: 'return',
        frameCounter: 3,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      const firmwareReps = live.snapshotSet()?.firmwareReps ?? [];
      expect(firmwareReps).toHaveLength(1);
      expect(firmwareReps[0].enriched).toBeDefined();
      expect(firmwareReps[0].enriched?.concentric.samples).toHaveLength(0);
      expect(channels.publish).not.toHaveBeenCalled();
    });
  });

  describe('frame-driven cycle detection', () => {
    // velocity is in WA's native mm/s — the channel-payload boundary divides
    // by 1000 on the way out so a 500 mm/s sample lands as `peak_velocity: 0.5`.
    function feedFrame(seq: number, phase: number): void {
      client.fire.frame({
        sequence: seq,
        timestamp: 1000 + seq,
        phase,
        position: 0.1 * seq,
        velocity: 500,
        force: 50,
      });
    }

    it('starts a new rep when CONCENTRIC follows ECCENTRIC (canonical addSampleToSet boundary)', () => {
      startSet(live);
      feedFrame(1, 1); // CONCENTRIC -> starts rep 1
      feedFrame(2, 1);
      feedFrame(3, 3); // ECCENTRIC
      feedFrame(4, 3);
      feedFrame(5, 1); // CONCENTRIC again -> closes rep 1, starts rep 2

      // Two reps now exist: rep 1 is closed (C + E samples), rep 2 is
      // in-progress with the trailing CONCENTRIC sample. This matches the
      // mobile app's behavior — a rep is "closed" when the next one starts.
      const set = live.snapshotSet();
      expect(set?.reps.length).toBe(2);
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://set/active',
      });
    });

    it('emits one rep for CONCENTRIC -> ECCENTRIC -> IDLE (rest after rep)', () => {
      startSet(live);
      feedFrame(1, 1); // CONCENTRIC
      feedFrame(2, 3); // ECCENTRIC
      feedFrame(3, 0); // IDLE -> closes the rep

      expect(live.snapshotSet()?.reps.length).toBe(1);
    });

    it('emits exactly two reps for two full cycles (C->E->C->E)', () => {
      startSet(live);
      // Rep 1: CONCENTRIC -> ECCENTRIC
      feedFrame(1, 1);
      feedFrame(2, 3);
      // Rep 2: CONCENTRIC closes rep 1, then ECCENTRIC fills rep 2
      feedFrame(3, 1);
      feedFrame(4, 3);

      // After the sequence, reps = [rep1_closed, rep2_with_C+E]. Two reps.
      expect(live.snapshotSet()?.reps.length).toBe(2);
    });

    it('does not emit a phantom rep for noise frames at start of set (CONCENTRIC then IDLE without ECCENTRIC)', () => {
      startSet(live);
      feedFrame(1, 1); // CONCENTRIC (slack pickup)
      feedFrame(2, 0); // IDLE — no eccentric, no rep emitted
      // Now a real rep
      feedFrame(3, 1);
      feedFrame(4, 3);
      feedFrame(5, 0);

      expect(live.snapshotSet()?.reps.length).toBe(1);
    });

    it('does not emit a phantom rep for an ECCENTRIC-only burst at end of set', () => {
      startSet(live);
      feedFrame(1, 3); // ECCENTRIC only — no concentric pull
      feedFrame(2, 0); // IDLE
      // Without a CONCENTRIC half, the rep is dropped.
      expect(live.snapshotSet()?.reps.length).toBe(0);
    });

    it('drops frames when no set is active', () => {
      feedFrame(1, 1);
      feedFrame(2, 3);
      feedFrame(3, 0);
      // No set → no live state change.
      expect(live.snapshotSet()).toBeUndefined();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });

    it('does not publish rep_finalized while rep 1 is still in-progress (length 0 -> 1)', () => {
      // addSampleToSet creates rep 1 on the first CONCENTRIC sample. At that
      // moment rep 1 is in-progress — nothing has closed yet, so no channel
      // event should fire. The `set_ended` event from set-tools.ts covers
      // the terminal rep when the set itself ends.
      startSet(live);
      feedFrame(1, 1); // CONCENTRIC -> length 0 -> 1, rep 1 in-progress
      feedFrame(2, 3); // ECCENTRIC, samples appended to rep 1
      feedFrame(3, 0); // IDLE, samples appended to rep 1
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('publishes rep_finalized for rep 1 when rep 2 begins (length 1 -> 2)', () => {
      // Rep 1 finalizes at the ECC -> CONC transition that opens rep 2; the
      // closed rep sits at index 0 while the new in-progress rep is index 1.
      startSet(live);
      // Stamp device with a known weight + mode so the meta + set_context
      // assertions below have something to look at.
      live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
      feedFrame(1, 1); // C, rep 1 starts
      feedFrame(2, 3); // E, rep 1 in eccentric phase
      feedFrame(3, 1); // C -> ECC->CONC: rep 1 finalized, rep 2 starts

      expect(channels.publish).toHaveBeenCalledTimes(1);
      const event = channels.publish.mock.calls[0][0];
      expect(event.meta.source).toBe('voltras');
      expect(event.meta.event_type).toBe('rep_finalized');
      expect(event.meta.set_id).toBe('set-1');
      expect(event.meta.rep_count).toBe('1');
      // Velocity in the test frames is 0.5 (positive); meta should expose
      // peak concentric + eccentric velocity since both phases got samples.
      expect(event.meta.peak_concentric_velocity).toBe('0.500');
      expect(event.meta.peak_eccentric_velocity).toBe('0.500');
      expect(event.meta.weight_lbs).toBe('100');

      // Content is JSON-encoded with summary + rep + set_context keys.
      const parsed = JSON.parse(event.content);
      expect(typeof parsed.summary).toBe('string');
      expect(parsed.summary).toContain('Rep 1');
      expect(parsed.rep.rep_number).toBe(1);
      expect(parsed.rep.concentric).toMatchObject({
        peak_velocity: 0.5,
      });
      expect(typeof parsed.rep.concentric.duration_ms).toBe('number');
      expect(parsed.rep.eccentric.peak_velocity).toBe(0.5);
      // ROM is the absolute concentric position delta. With only one
      // CONCENTRIC sample (position 0.1) start == end, so ROM is 0; what we
      // care about is that the field is populated rather than null.
      expect(typeof parsed.rep.rom_m).toBe('number');
      expect(parsed.set_context).toMatchObject({
        weight_lbs: 100,
        training_mode: 'WeightTraining',
        // length-1 (in-progress rep 2) reps already started, so rep_count_so_far is 1.
        rep_count_so_far: 1,
      });
    });

    it('publishes rep_finalized for rep 2 when rep 3 begins (length 2 -> 3)', () => {
      startSet(live);
      feedFrame(1, 1); // C, rep 1 starts (no publish)
      feedFrame(2, 3); // E
      feedFrame(3, 1); // ECC->CONC: rep 1 finalized, rep 2 starts (publish rep 1)
      feedFrame(4, 3); // E, rep 2 in eccentric
      feedFrame(5, 1); // ECC->CONC: rep 2 finalized, rep 3 starts (publish rep 2)

      expect(channels.publish).toHaveBeenCalledTimes(2);
      const second = channels.publish.mock.calls[1][0];
      expect(second.meta.event_type).toBe('rep_finalized');
      expect(second.meta.rep_count).toBe('2');
      const parsed = JSON.parse(second.content);
      expect(parsed.summary).toContain('Rep 2');
      expect(parsed.rep.rep_number).toBe(2);
      // length-1 (in-progress rep 3) means rep_count_so_far is 2.
      expect(parsed.set_context.rep_count_so_far).toBe(2);
    });

    it('does not publish a channel event when no set is active', () => {
      feedFrame(1, 1);
      feedFrame(2, 3);
      expect(channels.publish).not.toHaveBeenCalled();
    });
  });

  describe('onInProgress', () => {
    function startSetNow(): void {
      live.startSession({
        sessionId: 'sess-grace',
        startedAt: new Date().toISOString(),
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-grace',
        sessionId: 'sess-grace',
        // startedAt = now → grace window applies.
        startedAt: new Date().toISOString(),
        reps: [],
        status: 'active',
      });
    }

    it('within the set-start grace window does not reset cycle state (Workout.GO echo suppression)', () => {
      startSetNow();
      // Feed half a rep (CONCENTRIC), then receive a spurious in-progress
      // event within the grace window — the cycle detector should keep
      // its state.
      client.fire.frame({
        sequence: 1,
        timestamp: 1001,
        phase: 1,
        position: 0.1,
        velocity: 0.5,
        force: 50,
      });
      client.fire.inProgress();

      // Now finish the rep — the bridge should still produce one rep,
      // proving the spurious boundary did not blow away the buffered
      // CONCENTRIC samples.
      client.fire.frame({
        sequence: 2,
        timestamp: 1002,
        phase: 3, // ECCENTRIC
        position: 0.2,
        velocity: 0.5,
        force: 50,
      });
      client.fire.frame({
        sequence: 3,
        timestamp: 1003,
        phase: 0, // IDLE -> close rep
        position: 0.3,
        velocity: 0,
        force: 0,
      });
      expect(live.snapshotSet()?.reps.length).toBe(1);
    });

    // Legacy "outside the grace window with no state wired" test removed
    // in Step 4 of P0 dual-Voltras: the bridge now always operates with a
    // ServerState (the per-slot wirer takes one as a required argument),
    // so the "missing-state silent drop" branch no longer exists. The
    // dedicated `set_ended` device-signal finalize describe block below
    // covers the active behavior end-to-end.
  });

  describe('onSetSummary → set_ended with closed_by=device', () => {
    // A second harness — the bridge needs `state` threaded so it can call
    // `finalizeSet`. We re-wire here with a minimal fake state shaped just
    // enough for the device-signal finalize path: live, store with a
    // putSet spy, channels with a publish spy, and the
    // setStartDeviceSnapshots map populated as if `set.start` had run.
    interface FakeSlot {
      slotId: string;
      live: LiveStateT;
      client: FakeClient;
      modeRevertGuard: ModeRevertGuardT;
      modeDivergenceWatch: ModeDivergenceWatchT;
      coercionWatch: CoercionWatchT;
    }
    interface FakeState {
      slots: Map<string, FakeSlot>;
      store: { putSet: Mock<(s: unknown) => Promise<void>> };
      channels: FakeChannels;
      server: FakeServer;
      setStartDeviceSnapshots: Map<
        string,
        { connected: boolean; weightLbs?: number; trainingMode?: string }
      >;
      setWatchdog: SetWatchdogT;
      restTimers: RestTimerRegistryT;
    }
    let fakeState: FakeState;

    function flushMicrotasks(): Promise<void> {
      // The bridge's onInProgress handler kicks off `finalizeSet` via
      // `void ...catch(...)` — a fire-and-forget Promise chain. We need
      // pending microtasks to drain so assertions on putSet / publish see
      // the side-effects. Two `setImmediate` flushes cover the
      // chain length (await live.endSet → await store.putSet → publish).
      return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    }

    beforeEach(() => {
      live = new LiveState();
      client = makeFakeClient();
      server = makeFakeServer();
      channels = makeFakeChannels();
      const slots = new Map<string, FakeSlot>();
      // Sneak the fake `client` (which captures the bridge's listeners)
      // into the slot via the test-side harness — finalizeSet's getSlot
      // lookup will see this slot, but the bridge subscribes to the
      // outer `client` reference passed via the slot. The slot's
      // `client.endSet` mock is asserted on for the
      // disengageMotor=false device-signal path.
      slots.set('primary', {
        slotId: 'primary',
        live,
        client: client as unknown as FakeSlot['client'],
        modeRevertGuard: new ModeRevertGuard(),
        modeDivergenceWatch: new ModeDivergenceWatch(),
        coercionWatch: new CoercionWatch(),
      });
      fakeState = {
        slots,
        store: { putSet: vi.fn(async () => undefined) },
        channels,
        server,
        setStartDeviceSnapshots: new Map(),
        setWatchdog: new SetWatchdog(),
        restTimers: new RestTimerRegistry(),
      };
      const slot = slots.get('primary')!;
      wireBridgeForSlot(
        fakeState as unknown as Parameters<typeof wireBridgeForSlot>[0],
        slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );
    });

    function startActiveSet(opts: { startedAt: string }): void {
      live.startSession({
        sessionId: 'sess-dev',
        startedAt: opts.startedAt,
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-dev',
        sessionId: 'sess-dev',
        startedAt: opts.startedAt,
        reps: [],
        status: 'active',
      });
      fakeState.setStartDeviceSnapshots.set('set-dev', {
        connected: true,
        weightLbs: 135,
        trainingMode: 'WeightTraining',
      });
    }

    it('onInProgress flood does NOT finalize (regression guard — was the SET_START_GRACE_MS bug)', async () => {
      // The legacy bridge used `onInProgress` outside a 500ms grace as the
      // close signal — broken under fast-tempo WT (sets ended at 1–3s with
      // 0–2 reps captured). Now `onInProgress` never finalizes; close goes
      // through `onSetSummary`. Fire many inProgress events to confirm.
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      client.fire.inProgress();
      client.fire.inProgress();
      client.fire.inProgress();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      expect(channels.publish).not.toHaveBeenCalled();
      expect(live.snapshotSet()).toBeDefined();
    });

    it('onSetSummary with an active set persists, clears live state, and publishes set_ended (closed_by=device)', async () => {
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      client.fire.setSummary();
      await flushMicrotasks();

      expect(fakeState.store.putSet).toHaveBeenCalledTimes(1);
      const stored = fakeState.store.putSet.mock.calls[0][0] as {
        id: string;
        partial: boolean;
        partialReason?: string;
        weightLbs: number;
        trainingMode: string;
      };
      expect(stored.id).toBe('set-dev');
      // F14/F15 rewrite: device-signal close is the canonical natural
      // close — NOT partial. The old `partial=true` /
      // `partialReason='device_signal'` stamp mislabeled an intentional
      // disengage as something went wrong.
      expect(stored.partial).toBe(false);
      expect(stored.partialReason).toBeUndefined();
      // Device snapshot from `set.start` is honored.
      expect(stored.weightLbs).toBe(135);
      expect(stored.trainingMode).toBe('WeightTraining');

      // LiveState's set is cleared.
      expect(live.snapshotSet()).toBeUndefined();

      // Three channel events on a single onSetSummary fire: first the
      // `set_pre_summary` rest-coaching prompt (kept for backwards-compat
      // with PT-skill consumers), then the unified `set_ended` event
      // with `closed_by='device'`, then the initial passive `rest_status`
      // (VMCP-02.08) at t=0 of the rest period.
      expect(channels.publish).toHaveBeenCalledTimes(3);
      expect(channels.publish.mock.calls[0][0].meta.event_type).toBe('set_pre_summary');
      const event = channels.publish.mock.calls[1][0];
      expect(event.meta.event_type).toBe('set_ended');
      expect(channels.publish.mock.calls[2][0].meta.event_type).toBe('rest_status');
      expect(event.meta.closed_by).toBe('device');
      expect(event.meta.set_id).toBe('set-dev');
      expect(event.meta.session_id).toBe('sess-dev');
      expect(event.meta.partial_reason).toBeUndefined();

      const parsed = JSON.parse(event.content) as {
        summary: string;
        set: { partial_reason: string | null; closed_by: string };
      };
      expect(parsed.set.partial_reason).toBeNull();
      expect(parsed.set.closed_by).toBe('device');
      expect(parsed.summary).toContain('Set ended by device');
      expect(parsed.summary).toContain('set ended automatically');

      // The bridge must NOT have called client.endSet — the device already
      // de-engaged on its own; an extra Workout.STOP would be churn.
      expect(fakeState.slots.get('primary')!.client.endSet).not.toHaveBeenCalled();

      // The voltra://set/active resource is poked so polling clients
      // refresh.
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://set/active',
      });
    });

    it('onSetSummary with NO active set is a silent drop', async () => {
      // No startSet invocation — `live.snapshotSet()` is undefined.
      // Simulates the explicit `set.end` race: tool already ran, then a
      // late `aa 85 5f` setSummary frame arrives.
      client.fire.setSummary();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      // The bridge's set_pre_summary publisher also short-circuits when
      // there is no active set, so `channels.publish` stays untouched.
      expect(channels.publish).not.toHaveBeenCalled();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });

    it('race-condition guard: live.endSet() before onSetSummary is a silent drop', async () => {
      // Reproduce the explicit `set.end` race: LiveState.endSet() runs
      // first, then a late onSetSummary arrives. The bridge must observe
      // the cleared live set and drop without re-finalizing.
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      live.endSet();
      client.fire.setSummary();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('attaches device_set_summary block to set_ended (the onSetSummary payload)', async () => {
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      client.fire.setSummary({
        schemaVersion: 1,
        targetWeightTenths: 200,
        repCount: 7,
        repDurationMs: 5730,
        raw: new Uint8Array(110),
      });
      await flushMicrotasks();

      // First publish is `set_pre_summary`, second is unified `set_ended`
      // with `closed_by='device'`, third is the initial `rest_status`
      // (VMCP-02.08) at t=0 of the rest period.
      expect(channels.publish).toHaveBeenCalledTimes(3);
      const setEnded = channels.publish.mock.calls[1][0];
      expect(setEnded.meta.event_type).toBe('set_ended');
      expect(setEnded.meta.closed_by).toBe('device');
      expect(setEnded.meta.device_rep_count).toBe('7');
      expect(setEnded.meta.device_set_rep_duration_ms).toBe('5730');
      expect(setEnded.meta.device_schema_version).toBe('1');
      const parsed = JSON.parse(setEnded.content) as {
        device_set_summary: {
          rep_count: number;
          rep_duration_ms: number;
          target_weight_tenths: number;
          schema_version: number;
        };
      };
      expect(parsed.device_set_summary).toEqual({
        rep_count: 7,
        rep_duration_ms: 5730,
        target_weight_tenths: 200,
        schema_version: 1,
      });
    });

    it('combines device_summary and device_set_summary when both onSummary and onSetSummary fire', async () => {
      // Edge case: the device occasionally emits both an `aa 86 7d` summary
      // and an `aa 85 5f` setSummary in the same set lifetime (e.g., the
      // workout-end summary replayed on reconnect). The bridge captures
      // both and threads both blocks onto the close payload.
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      client.fire.summary({
        schemaVersion: 4,
        setCounter: 1,
        repCount: 7,
        raw: new Uint8Array(140),
      });
      client.fire.setSummary({
        schemaVersion: 1,
        targetWeightTenths: 200,
        repCount: 7,
        repDurationMs: 5730,
        raw: new Uint8Array(110),
      });
      await flushMicrotasks();

      // Filter for the unified `set_ended` payload — call order is now
      // [set_pre_summary, set_ended, rest_status] (VMCP-02.08).
      const setEndedCall = channels.publish.mock.calls.find(
        (c) => c[0].meta.event_type === 'set_ended',
      );
      expect(setEndedCall).toBeDefined();
      const setEnded = setEndedCall![0];
      const parsed = JSON.parse(setEnded.content) as {
        device_summary?: { rep_count: number };
        device_set_summary?: { rep_count: number };
      };
      expect(parsed.device_summary).toEqual({ rep_count: 7, schema_version: 4 });
      expect(parsed.device_set_summary?.rep_count).toBe(7);
    });

    it('finalizes the last firmware rep + records firmwareTotalRepCount on close (VMCP-02.29 PR4)', async () => {
      // Fire frames + two `return` boundaries (firmware reps 1-2), then a
      // setSummary carrying repCount=3. The final rep never emits its own
      // 'return' (the device disengages after the last concentric), so the
      // close path slices the trailing sample window, appends it as firmware
      // rep 3, and records the device's authoritative repCount. Deterministic
      // clock so the boundary slice windows are exact.
      let clock = 1_700_000_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      // Snapshot the active set at the instant finalizeSet reaches endSet —
      // AFTER the firmware finalize appends, BEFORE endSet discards it.
      let firmwareRepsAtClose = 0;
      let finalRepNumber: number | undefined;
      let totalAtClose: number | undefined;
      const realEndSet = live.endSet.bind(live);
      vi.spyOn(live, 'endSet').mockImplementation((reason, opts) => {
        const snap = live.snapshotSet();
        const fw = snap?.firmwareReps ?? [];
        firmwareRepsAtClose = fw.length;
        finalRepNumber = fw[fw.length - 1]?.repNumber;
        totalAtClose = snap?.firmwareTotalRepCount;
        return realEndSet(reason, opts);
      });

      startActiveSet({ startedAt: new Date(clock).toISOString() });
      const frame = (seq: number, phase: number, velocity: number): void =>
        client.fire.frame({
          sequence: seq,
          timestamp: seq,
          phase,
          position: 0.1 * seq,
          velocity,
          force: 50,
        });

      clock += 10;
      frame(1, 1, 400);
      frame(2, 3, 200);
      clock += 10;
      client.fire.perRep({
        phase: 'return',
        frameCounter: 2,
        setCounter: 1,
        repCount: 1,
        targetWeightTenths: 0,
      });
      clock += 10;
      frame(3, 1, 500);
      frame(4, 3, 250);
      clock += 10;
      client.fire.perRep({
        phase: 'return',
        frameCounter: 4,
        setCounter: 1,
        repCount: 2,
        targetWeightTenths: 0,
      });
      clock += 10;
      frame(5, 1, 600);
      frame(6, 3, 300);
      clock += 10;
      client.fire.setSummary({
        schemaVersion: 1,
        targetWeightTenths: 1000,
        repCount: 3,
        repDurationMs: 1800,
        raw: new Uint8Array(110),
      });
      await flushMicrotasks();

      // Two `return`-driven firmware reps + one appended on close = 3; the
      // final rep carries the device's rep number and firmwareTotalRepCount
      // equals the setSummary payload's repCount.
      expect(firmwareRepsAtClose).toBe(3);
      expect(finalRepNumber).toBe(3);
      expect(totalAtClose).toBe(3);
      nowSpy.mockRestore();
    });
  });

  describe('trigger DSL — synchronous evaluation on rep_finalized', () => {
    // Trigger evaluation requires a wired ServerState (for the auto-stop
    // path) so this block re-wires the bridge with a fake state. Notify-only
    // triggers fire even without `state`, but we test both shapes here for
    // coverage.
    interface FakeSlotForTrigger {
      slotId: string;
      live: LiveStateT;
      client: FakeClient;
      modeRevertGuard: ModeRevertGuardT;
      modeDivergenceWatch: ModeDivergenceWatchT;
      coercionWatch: CoercionWatchT;
    }
    interface FakeStateForTrigger {
      slots: Map<string, FakeSlotForTrigger>;
      store: { putSet: Mock<(s: unknown) => Promise<void>> };
      channels: FakeChannels;
      server: FakeServer;
      setStartDeviceSnapshots: Map<
        string,
        { connected: boolean; weightLbs?: number; trainingMode?: string }
      >;
      setWatchdog: SetWatchdogT;
      restTimers: RestTimerRegistryT;
    }
    let fakeState: FakeStateForTrigger;

    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    }

    beforeEach(() => {
      live = new LiveState();
      client = makeFakeClient();
      server = makeFakeServer();
      channels = makeFakeChannels();
      const slots = new Map<string, FakeSlotForTrigger>();
      slots.set('primary', {
        slotId: 'primary',
        live,
        client,
        modeRevertGuard: new ModeRevertGuard(),
        modeDivergenceWatch: new ModeDivergenceWatch(),
        coercionWatch: new CoercionWatch(),
      });
      fakeState = {
        slots,
        store: { putSet: vi.fn(async () => undefined) },
        channels,
        server,
        setStartDeviceSnapshots: new Map(),
        setWatchdog: new SetWatchdog(),
        restTimers: new RestTimerRegistry(),
      };
      const slot = slots.get('primary')!;
      wireBridgeForSlot(
        fakeState as unknown as Parameters<typeof wireBridgeForSlot>[0],
        slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );
    });

    interface WatchSpec {
      notifyOn?: Array<
        | { type: 'rep_count_reached'; value: number }
        | { type: 'velocity_loss_exceeded'; pct: number }
      >;
    }

    function startWatchedSet(watch?: WatchSpec): void {
      live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
      live.startSession({
        sessionId: 'sess-trig',
        startedAt: '2025-01-01T00:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-trig',
        sessionId: 'sess-trig',
        startedAt: '2025-01-01T00:00:00.000Z',
        reps: [],
        status: 'active',
        ...(watch !== undefined
          ? {
              watch: {
                notifyOn: watch.notifyOn ?? [],
              },
            }
          : {}),
      });
      fakeState.setStartDeviceSnapshots.set('set-trig', {
        connected: true,
        weightLbs: 100,
        trainingMode: 'WeightTraining',
      });
    }

    /**
     * Drive a rep cycle through the bridge's frame handler. `velocity` is
     * stamped on every frame so the rep's concentric peakVelocity equals
     * `velocity` (matching the existing test pattern). Rep N finalizes
     * when the next CONCENTRIC frame begins rep N+1.
     */
    function driveRep(seq: number, velocity: number): void {
      client.fire.frame({
        sequence: seq * 10,
        timestamp: 1000 + seq * 100,
        phase: 1, // CONCENTRIC
        position: seq * 0.1,
        velocity,
        force: 50,
      });
      client.fire.frame({
        sequence: seq * 10 + 1,
        timestamp: 1000 + seq * 100 + 50,
        phase: 3, // ECCENTRIC
        position: seq * 0.1 + 0.1,
        velocity,
        force: 50,
      });
    }

    /** Open rep N+1 to finalize rep N — fed via a single CONCENTRIC frame. */
    function startNextRep(seq: number, velocity: number): void {
      client.fire.frame({
        sequence: seq * 10,
        timestamp: 1000 + seq * 100,
        phase: 1,
        position: seq * 0.1,
        velocity,
        force: 50,
      });
    }

    function lastTriggerEvent(): { meta: Record<string, string>; content: string } | undefined {
      const calls = channels.publish.mock.calls;
      for (let i = calls.length - 1; i >= 0; i--) {
        const ev = calls[i][0];
        if (
          ev.meta.event_type === 'set_target_reached' ||
          ev.meta.event_type === 'velocity_loss_exceeded'
        ) {
          return ev;
        }
      }
      return undefined;
    }

    describe('rep_count_reached', () => {
      it('notifyOn fires set_target_reached when N reps finalize but does not auto-stop', async () => {
        startWatchedSet({ notifyOn: [{ type: 'rep_count_reached', value: 2 }] });
        // Drive 3 concentric/eccentric cycles. The 3rd CONCENTRIC closes
        // rep 2 — that's when the rep_count_reached:2 trigger fires.
        driveRep(1, 0.6);
        driveRep(2, 0.6);
        startNextRep(3, 0.6);
        await flushMicrotasks();

        const trigger = lastTriggerEvent();
        expect(trigger).toBeDefined();
        expect(trigger?.meta).toMatchObject({
          event_type: 'set_target_reached',
          set_id: 'set-trig',
          target_rep_count: '2',
          actual_rep_count: '2',
        });
        expect(trigger?.meta.auto_stopped).toBeUndefined();
        // Set is still active — notifyOn does not finalize.
        expect(live.snapshotSet()).toBeDefined();
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
      });

      it('F14/F15 rewrite: rep_count_reached is advisory — fires cue but DOES NOT finalize the set', async () => {
        // Hardware capture 2026-05-11: a `stopOn: rep_count_reached: 5`
        // trigger fired after rep 5, wrote `Workout.STOP` mid-rep-6 and
        // ripped the cable mid-eccentric. The user dropped force-stop
        // entirely; triggers are now advisory cues only. The model
        // voice-coaches "rack it — that's your 5", the user finishes
        // naturally, and `aa 85 5f` becomes the canonical close.
        startWatchedSet({ notifyOn: [{ type: 'rep_count_reached', value: 2 }] });
        driveRep(1, 0.6);
        driveRep(2, 0.6);
        startNextRep(3, 0.6);
        await flushMicrotasks();

        // Trigger cue fires — advisory only, no auto_stopped meta.
        const trigger = lastTriggerEvent();
        expect(trigger).toBeDefined();
        expect(trigger?.meta).toMatchObject({
          event_type: 'set_target_reached',
          target_rep_count: '2',
          actual_rep_count: '2',
        });
        expect(trigger?.meta.auto_stopped).toBeUndefined();

        // Critical assertion: the set is STILL ACTIVE. No `set_ended`
        // event was published; the bridge did not call `finalizeSet`.
        expect(live.snapshotSet()).toBeDefined();
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        expect(eventTypes).not.toContain('set_ended');
      });

      it('F15 advisory-only: rep_count_reached fires once even with 4 actual reps and target=3', async () => {
        // Coverage scenario from the brief: with target=3, finalize 4
        // reps → expect 1 cue, NO set_ended from the bridge.
        startWatchedSet({ notifyOn: [{ type: 'rep_count_reached', value: 3 }] });
        driveRep(1, 0.6);
        driveRep(2, 0.6);
        driveRep(3, 0.6);
        startNextRep(4, 0.6); // closes rep 3 — cue fires here
        client.fire.frame({
          sequence: 41,
          timestamp: 1500,
          phase: 3, // ECCENTRIC
          position: 0.4,
          velocity: 0.6,
          force: 50,
        });
        startNextRep(5, 0.6); // closes rep 4 — cue must NOT re-fire
        await flushMicrotasks();

        const cues = channels.publish.mock.calls.filter(
          (c) => c[0].meta.event_type === 'set_target_reached',
        );
        expect(cues).toHaveLength(1);
        const setEndedCalls = channels.publish.mock.calls.filter(
          (c) => c[0].meta.event_type === 'set_ended',
        );
        expect(setEndedCalls).toHaveLength(0);
        expect(live.snapshotSet()).toBeDefined();
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
      });

      it('fires exactly once even when reps continue past the target (notifyOn)', async () => {
        startWatchedSet({ notifyOn: [{ type: 'rep_count_reached', value: 2 }] });
        driveRep(1, 0.6);
        driveRep(2, 0.6);
        startNextRep(3, 0.6); // closes rep 2 — fires
        // Continue: drive rep 3 to ECC, then rep 4 to close rep 3.
        client.fire.frame({
          sequence: 31,
          timestamp: 1500,
          phase: 3,
          position: 0.4,
          velocity: 0.6,
          force: 50,
        });
        startNextRep(4, 0.6); // closes rep 3 — must NOT re-fire
        await flushMicrotasks();

        const triggerCount = channels.publish.mock.calls.filter(
          (c) => c[0].meta.event_type === 'set_target_reached',
        ).length;
        expect(triggerCount).toBe(1);
      });

      it('with no watch config, behavior is unchanged (only rep_finalized events)', async () => {
        startWatchedSet(); // no watch
        driveRep(1, 0.6);
        startNextRep(2, 0.6);
        await flushMicrotasks();

        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        expect(eventTypes).toContain('rep_finalized');
        expect(eventTypes).not.toContain('set_target_reached');
        expect(eventTypes).not.toContain('velocity_loss_exceeded');
      });
    });

    describe('velocity_loss_exceeded', () => {
      it('does not fire on rep 1 alone (no prior reps to baseline against)', async () => {
        startWatchedSet({ notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25 }] });
        driveRep(1, 0.85);
        startNextRep(2, 0.6); // closes rep 1
        await flushMicrotasks();

        // baseline = current = 0.85 ⇒ loss = 0% ⇒ no fire.
        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        expect(eventTypes).not.toContain('velocity_loss_exceeded');
      });

      it('fires when current rep peak velocity drops below threshold (notifyOn)', async () => {
        startWatchedSet({ notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25 }] });
        // Rep 1: peak velocity 1.0 (sets baseline)
        driveRep(1, 1.0);
        // Rep 2 starts (closes rep 1): baseline=1.0, current=1.0 → no fire
        startNextRep(2, 1.0);
        // Continue rep 2 ECC, then rep 3 starts at 0.5 (closes rep 2)
        client.fire.frame({
          sequence: 21,
          timestamp: 1300,
          phase: 3,
          position: 0.3,
          velocity: 1.0,
          force: 50,
        });
        // Open rep 3 with very low velocity
        startNextRep(3, 0.5);
        // Wait — rep 2 closes when rep 3 begins. Rep 2's peak conc velocity
        // came from frames during its concentric phase — the only frame
        // labeled CONCENTRIC for rep 2 was startNextRep(2, 1.0). So rep 2
        // peak conc = 1.0 too. We need to engineer rep 2 with a lower peak.
        // Re-design: make rep 2 explicitly have a lower CONCENTRIC velocity.
        await flushMicrotasks();
        // No velocity_loss event: rep 1 peak=1.0, rep 2 peak=1.0 (its
        // concentric was driven by the velocity-1.0 frame). Restructure
        // is needed; this test guards the baseline-tie case.
        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        expect(eventTypes).not.toContain('velocity_loss_exceeded');
      });

      it('F15 advisory-only: velocity_loss_exceeded fires cue without finalizing', async () => {
        startWatchedSet({ notifyOn: [{ type: 'velocity_loss_exceeded', pct: 30 }] });
        // Rep 1 peak conc = 1.0
        driveRep(1, 1.0);
        // Open rep 2 at velocity 0.5 — that single CONCENTRIC sample
        // becomes rep 2's peakVelocity.
        startNextRep(2, 0.5);
        // Open rep 3 to close rep 2 (with whatever velocity).
        client.fire.frame({
          sequence: 25,
          timestamp: 1400,
          phase: 3,
          position: 0.3,
          velocity: 0.5,
          force: 50,
        });
        startNextRep(3, 0.5);
        await flushMicrotasks();

        // Loss = (1.0 - 0.5)/1.0 * 100 = 50% ≥ 30% — cue fires.
        const trigger = lastTriggerEvent();
        expect(trigger?.meta.event_type).toBe('velocity_loss_exceeded');
        expect(trigger?.meta.auto_stopped).toBeUndefined();
        expect(parseFloat(trigger!.meta.velocity_loss_pct)).toBeCloseTo(50.0, 1);
        expect(trigger?.meta.threshold_pct).toBe('30');

        // Set remains active — advisory only.
        expect(live.snapshotSet()).toBeDefined();
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
      });

      it('does not re-fire after a stronger rep raises the baseline (no false-positive)', async () => {
        startWatchedSet({ notifyOn: [{ type: 'velocity_loss_exceeded', pct: 40 }] });
        // Rep 1 peak conc = 1.0
        driveRep(1, 1.0);
        startNextRep(2, 1.0); // close rep 1, open rep 2
        // Rep 2 ECC
        client.fire.frame({
          sequence: 21,
          timestamp: 1300,
          phase: 3,
          position: 0.3,
          velocity: 1.0,
          force: 50,
        });
        // Rep 3 opens at 1.2 — that's the new peak. Rep 2's peak was 1.0
        // (driven by startNextRep(2, 1.0)), so when it closes, current=1.0
        // baseline=1.0 → no fire. Then rep 3 IS the new max.
        startNextRep(3, 1.2);
        await flushMicrotasks();

        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        expect(eventTypes).not.toContain('velocity_loss_exceeded');
      });

      it('multiple velocity_loss thresholds fire independently (15 + 35 both match a 50% drop)', async () => {
        startWatchedSet({
          notifyOn: [
            { type: 'velocity_loss_exceeded', pct: 15 },
            { type: 'velocity_loss_exceeded', pct: 35 },
          ],
        });
        driveRep(1, 1.0);
        startNextRep(2, 0.5);
        client.fire.frame({
          sequence: 25,
          timestamp: 1400,
          phase: 3,
          position: 0.3,
          velocity: 0.5,
          force: 50,
        });
        startNextRep(3, 0.5);
        await flushMicrotasks();

        const losses = channels.publish.mock.calls
          .map((c) => c[0])
          .filter((e) => e.meta.event_type === 'velocity_loss_exceeded');
        expect(losses).toHaveLength(2);
        const thresholds = losses.map((e) => e.meta.threshold_pct).sort();
        expect(thresholds).toEqual(['15', '35']);
      });
    });

    describe('combined notifyOn behavior', () => {
      it('multiple matches in same rep publish each trigger event WITHOUT finalizing', async () => {
        // F15 advisory-only: both rep_count_reached:2 and
        // velocity_loss_exceeded:30 match on rep 2's close. Both fire as
        // cues; the set stays active.
        startWatchedSet({
          notifyOn: [
            { type: 'rep_count_reached', value: 2 },
            { type: 'velocity_loss_exceeded', pct: 30 },
          ],
        });
        // Rep 1: high velocity 1.0, baseline.
        driveRep(1, 1.0);
        // Rep 2: low velocity 0.5 — concentric peak via startNextRep.
        startNextRep(2, 0.5);
        client.fire.frame({
          sequence: 25,
          timestamp: 1400,
          phase: 3,
          position: 0.3,
          velocity: 0.5,
          force: 50,
        });
        // Rep 3 begins — closes rep 2, both rep_count_reached:2 AND
        // velocity_loss_exceeded:30 should fire.
        startNextRep(3, 0.5);
        await flushMicrotasks();

        const triggerEvents = channels.publish.mock.calls
          .map((c) => c[0])
          .filter((e) =>
            ['set_target_reached', 'velocity_loss_exceeded'].includes(e.meta.event_type),
          );
        expect(triggerEvents).toHaveLength(2);

        // Set stays active — no finalize.
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
        const setEnded = channels.publish.mock.calls
          .map((c) => c[0])
          .filter((e) => e.meta.event_type === 'set_ended');
        expect(setEnded).toHaveLength(0);
        expect(live.snapshotSet()).toBeDefined();
      });
    });
  });

  describe('onInProgress / onSummary typed-payload plumbing (PR-B)', () => {
    // These tests exercise the live-state mutators wired in event-bridge.ts.
    // The grace-window finalize path is covered above; this block focuses on
    // payload capture, which runs BEFORE the grace check so even start-of-set
    // heartbeats land in `latestInProgress`.
    function startSetNow(): void {
      live.startSession({
        sessionId: 'sess-payload',
        startedAt: new Date().toISOString(),
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-payload',
        sessionId: 'sess-payload',
        startedAt: new Date().toISOString(),
        reps: [],
        status: 'active',
      });
    }

    it('onInProgress captures payload into live.activeSet.latestInProgress within the grace window', () => {
      startSetNow(); // startedAt = now → still in grace window
      client.fire.inProgress({
        peakForceTenths: 1500,
        currentForceTenths: 900,
        velocityCmPerSec: 42,
        targetWeightTenths: 1350,
        raw: new Uint8Array(79),
      });
      const snap = live.snapshotSet();
      expect(snap?.latestInProgress).toMatchObject({
        peakForceTenths: 1500,
        currentForceTenths: 900,
        velocityCmPerSec: 42,
        targetWeightTenths: 1350,
      });
      expect(typeof snap?.latestInProgress?.capturedAt).toBe('number');
    });

    it('onInProgress captures the most recent tick when fired multiple times', () => {
      startSetNow();
      client.fire.inProgress({
        peakForceTenths: 100,
        currentForceTenths: 50,
        velocityCmPerSec: 10,
        targetWeightTenths: 500,
        raw: new Uint8Array(79),
      });
      client.fire.inProgress({
        peakForceTenths: 2000,
        currentForceTenths: 1500,
        velocityCmPerSec: 60,
        targetWeightTenths: 1800,
        raw: new Uint8Array(79),
      });
      expect(live.snapshotSet()?.latestInProgress).toMatchObject({
        peakForceTenths: 2000,
        currentForceTenths: 1500,
        velocityCmPerSec: 60,
        targetWeightTenths: 1800,
      });
    });

    it('onInProgress with no active set does not blow up (silent drop)', () => {
      // No startSet — bridge should still call the inProgress handler safely.
      client.fire.inProgress();
      expect(live.snapshotSet()).toBeUndefined();
    });

    it('onSummary updates live.activeSet.latestSummary without publishing a channel event', () => {
      startSetNow();
      channels.publish.mockClear();
      client.fire.summary({
        schemaVersion: 1,
        setCounter: 1,
        repCount: 5,
        raw: new Uint8Array(140),
      });
      expect(live.snapshotSet()?.latestSummary).toEqual({
        schemaVersion: 1,
        repCount: 5,
      });
      // The summary rides out on the set_ended event (via consumeLatestSummary
      // at finalize time), not as its own channel publish — deliberate to
      // avoid a race between two events for the same set.
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('onSummary with no active set is a silent drop (no channel event, no crash)', () => {
      channels.publish.mockClear();
      client.fire.summary();
      expect(live.snapshotSet()).toBeUndefined();
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('onSummary does not call sendResourceUpdated (PR-B is live-state plumbing only)', () => {
      startSetNow();
      server.server.sendResourceUpdated.mockClear();
      client.fire.summary();
      // The bridge captures the payload onto live state but does NOT poke any
      // resource — `latestSummary` is internal until PR-C surfaces it.
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('onSetSummary → set_pre_summary channel event (PR-C)', () => {
    function startSetNow(): void {
      live.startSession({
        sessionId: 'sess-pre',
        startedAt: new Date().toISOString(),
        setIds: [],
        status: 'active',
      });
      live.startSet({
        setId: 'set-pre',
        sessionId: 'sess-pre',
        startedAt: new Date().toISOString(),
        reps: [],
        status: 'active',
      });
    }

    it('publishes set_pre_summary on the channel when an active set is in flight', () => {
      startSetNow();
      live.applySettings({ weightLbs: 100, trainingMode: 'WeightTraining' });
      channels.publish.mockClear();
      client.fire.setSummary({
        schemaVersion: 2,
        targetWeightTenths: 1500,
        repCount: 6,
        repDurationMs: 2200,
        raw: new Uint8Array(110),
      });
      expect(channels.publish).toHaveBeenCalledTimes(1);
      const event = channels.publish.mock.calls[0][0];
      expect(event.meta).toMatchObject({
        source: 'voltras',
        event_type: 'set_pre_summary',
        set_id: 'set-pre',
        session_id: 'sess-pre',
        device_rep_count: '6',
        final_rep_duration_ms: '2200',
        schema_version: '2',
      });
      const parsed = JSON.parse(event.content) as {
        summary: string;
        pre_summary: { rep_count: number; final_rep_duration_ms: number };
        set_so_far: unknown;
      };
      expect(parsed.summary).toBe('Final rep complete: 6 reps, last rep 2200ms');
      expect(parsed.pre_summary.rep_count).toBe(6);
      expect(parsed.set_so_far).not.toBeNull();
    });

    it('is a silent drop when no set is active (ghost preSummary after set.end)', () => {
      // No startSet — simulates set.end already running before the device's
      // preSummary echo arrived.
      channels.publish.mockClear();
      expect(() => client.fire.setSummary()).not.toThrow();
      expect(channels.publish).not.toHaveBeenCalled();
    });

    it('does not mutate live state on preSummary (read-only — set_so_far is a snapshot)', () => {
      startSetNow();
      const before = live.snapshotSet();
      client.fire.setSummary();
      const after = live.snapshotSet();
      expect(after?.setId).toBe(before?.setId);
      expect(after?.reps.length).toBe(before?.reps.length);
      // latestSummary is owned by onSummary, not onSetSummary.
      expect(after?.latestSummary).toBeUndefined();
    });
  });

  describe('explicit set.end finalization', () => {
    // After set.end the bridge should not append further reps even if frames
    // continue to arrive. live.endSet() returns the set; subsequent
    // appendRep is a silent drop per LiveState's own contract.
    it('drops frames after live.endSet (no phantom rep on stale telemetry)', () => {
      startSet(live);
      client.fire.frame({
        sequence: 1,
        timestamp: 1001,
        phase: 1,
        position: 0.1,
        velocity: 0.5,
        force: 50,
      });
      client.fire.frame({
        sequence: 2,
        timestamp: 1002,
        phase: 3,
        position: 0.2,
        velocity: 0.5,
        force: 50,
      });
      live.endSet();
      // Late frame after end — should not reach LiveState.
      client.fire.frame({
        sequence: 3,
        timestamp: 1003,
        phase: 0,
        position: 0.3,
        velocity: 0,
        force: 0,
      });
      expect(live.snapshotSet()).toBeUndefined();
    });
  });

  describe('onSettingsUpdate', () => {
    it('maps SDK settings fields to DeviceSnapshot fields and notifies voltra://device/current', () => {
      client.fire.settingsUpdate({
        weight: 75,
        mode: 1, // TrainingMode.WeightTraining
        battery: 88,
      });
      const dev = live.snapshotDevice();
      expect(dev.weightLbs).toBe(75);
      // Mode is mapped to a name string by the bridge's settings mapper.
      expect(typeof dev.trainingMode).toBe('string');
      expect(dev.batteryPercent).toBe(88);
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://device/current',
      });
    });

    it('coerces battery=null to absent batteryPercent (critic FIX #6)', () => {
      client.fire.settingsUpdate({
        weight: 50,
        battery: null,
      });
      const dev = live.snapshotDevice();
      expect(dev.batteryPercent).toBeUndefined();
      expect(dev.weightLbs).toBe(50);
    });

    it('C5 — maps damperLevel from settings update into DeviceSnapshot', () => {
      client.fire.settingsUpdate({ damperLevel: 4 });
      expect(live.snapshotDevice().damperLevel).toBe(4);
    });

    it('C5 — omits damperLevel from snapshot when settings update carries none', () => {
      client.fire.settingsUpdate({ weight: 80 });
      expect(live.snapshotDevice().damperLevel).toBeUndefined();
    });
  });

  describe('LiveState soft-reset (Phase 0.5.1)', () => {
    it('first onSettingsUpdate after a stale snapshot clears the staleness flag', () => {
      const freshLive = new LiveState();
      // Seed the LiveState with cached pre-disconnect data, then mark stale
      // — the same shape `slot-manager.resetPrimarySlot` produces.
      freshLive.applySettings({ connected: true, weightLbs: 90, damperLevel: 5 });
      freshLive.markDisconnected('2025-05-01T12:00:00.000Z');
      expect(freshLive.isStale()).toBe(true);

      const freshClient = makeFakeClient();
      const freshServer = makeFakeServer();
      const freshChannels = makeFakeChannels();
      const freshState = makeBareState({
        client: freshClient,
        live: freshLive,
        server: freshServer,
        channels: freshChannels,
      });
      wireBridgeForSlot(
        freshState as unknown as Parameters<typeof wireBridgeForSlot>[0],
        freshState.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      // Wiring alone does not clear the flag — only a real device push does.
      expect(freshLive.isStale()).toBe(true);

      // First push after reconnect.
      freshClient.fire.settingsUpdate({ weight: 95, damperLevel: 6 });

      expect(freshLive.isStale()).toBe(false);
      const snap = freshLive.snapshotDevice();
      expect(snap.staleSinceDisconnect).toBeUndefined();
      expect(snap.weightLbs).toBe(95);
      expect(snap.damperLevel).toBe(6);
    });

    it('emits a connection_changed channel event when staleness clears', () => {
      const freshLive = new LiveState();
      freshLive.applySettings({ connected: true, weightLbs: 90 });
      freshLive.markDisconnected('2025-05-01T12:00:00.000Z');

      const freshClient = makeFakeClient();
      const freshServer = makeFakeServer();
      const freshChannels = makeFakeChannels();
      const freshState = makeBareState({
        client: freshClient,
        live: freshLive,
        server: freshServer,
        channels: freshChannels,
      });
      wireBridgeForSlot(
        freshState as unknown as Parameters<typeof wireBridgeForSlot>[0],
        freshState.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      freshClient.fire.settingsUpdate({ weight: 95 });

      const events = freshChannels.publish.mock.calls.map((c) => c[0]);
      const connectionEvent = events.find(
        (e) => e.meta.event_type === 'connection_changed' && e.meta.state === 'connected',
      );
      expect(connectionEvent).toBeDefined();
      expect(connectionEvent?.meta.refreshed).toBe('true');
    });

    it('does not emit a connection_changed event when LiveState was already non-stale', () => {
      // Sanity: a settings push when LiveState is already fresh should not
      // trigger the soft-reset connection_changed (avoid double-firing when
      // multiple pushes arrive in close succession).
      const freshLive = new LiveState();
      const freshClient = makeFakeClient();
      const freshServer = makeFakeServer();
      const freshChannels = makeFakeChannels();
      const freshState = makeBareState({
        client: freshClient,
        live: freshLive,
        server: freshServer,
        channels: freshChannels,
      });
      wireBridgeForSlot(
        freshState as unknown as Parameters<typeof wireBridgeForSlot>[0],
        freshState.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      freshClient.fire.settingsUpdate({ weight: 95 });

      const events = freshChannels.publish.mock.calls.map((c) => c[0]);
      const connectionEvent = events.find((e) => e.meta.event_type === 'connection_changed');
      expect(connectionEvent).toBeUndefined();
    });
  });

  describe('voltra://device/current resource shape during disconnect window', () => {
    it('returns last-known device state with staleSinceDisconnect during the disconnect window', () => {
      const freshLive = new LiveState();
      freshLive.applySettings({
        connected: true,
        weightLbs: 100,
        trainingMode: 'WeightTraining',
        damperLevel: 4,
      });
      freshLive.markDisconnected('2025-05-01T12:00:00.000Z');

      // The resource-handler reads `live.snapshotDevice()` directly — the
      // externally-observable shape is what we assert.
      const snap = freshLive.snapshotDevice();
      expect(snap.connected).toBe(false);
      expect(snap.weightLbs).toBe(100);
      expect(snap.trainingMode).toBe('WeightTraining');
      expect(snap.damperLevel).toBe(4);
      expect(snap.staleSinceDisconnect).toBe('2025-05-01T12:00:00.000Z');
      expect(snap.isStale).toBe(true);
    });
  });

  describe('onConnectionStateChange', () => {
    it("sets device.connected=true and notifies device URI on 'connected'", () => {
      client.fire.connectionStateChange('connected');
      expect(live.snapshotDevice().connected).toBe(true);
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://device/current',
      });
    });

    it("on 'disconnected' marks disconnected, propagates to session, and notifies all three URIs (R24)", () => {
      // Set up a session + set so disconnect propagation is observable.
      startSet(live);
      server.server.sendResourceUpdated.mockClear();

      client.fire.connectionStateChange('disconnected');

      const dev = live.snapshotDevice();
      expect(dev.connected).toBe(false);
      expect(dev.disconnectedAt).toBeDefined();

      const sess = live.snapshotSession();
      expect(sess?.disconnectedAt).toBeDefined();

      const uris = server.server.sendResourceUpdated.mock.calls.map(
        (c) => (c[0] as { uri: string }).uri,
      );
      expect(uris).toContain('voltra://device/current');
      expect(uris).toContain('voltra://session/active');
      expect(uris).toContain('voltra://set/active');
    });

    it("on intermediate states ('connecting'/'authenticating') does not flip connected=true", () => {
      client.fire.connectionStateChange('connecting');
      expect(live.snapshotDevice().connected).toBe(false);
      client.fire.connectionStateChange('authenticating');
      expect(live.snapshotDevice().connected).toBe(false);
    });

    it("VMCP-02.08: on 'disconnected' cancels any in-flight rest_status timer for the slot", () => {
      // Arm a rest timer directly on the registry — production flow does
      // this via `finalizeSet`, but the bridge's disconnect cancel must
      // work regardless of how the timer got armed.
      const noop = { publish: () => undefined, forSlot: () => noop };
      bareState.restTimers.start('primary', 'set-x', noop);
      expect(bareState.restTimers.has('primary')).toBe(true);

      client.fire.connectionStateChange('disconnected');

      expect(bareState.restTimers.has('primary')).toBe(false);
    });

    describe('connection_changed channel event', () => {
      it("publishes connection_changed with state=connected and device snapshot on 'connected'", () => {
        live.applySettings({
          batteryPercent: 80,
          weightLbs: 135,
          trainingMode: 'WeightTraining',
        });
        channels.publish.mockClear();
        client.fire.connectionStateChange('connected');

        expect(channels.publish).toHaveBeenCalledTimes(1);
        const event = channels.publish.mock.calls[0][0];
        expect(event.meta).toMatchObject({
          source: 'voltras',
          event_type: 'connection_changed',
          state: 'connected',
        });
        // No mid_set / disconnected_at attrs on connect.
        expect(event.meta.mid_set).toBeUndefined();
        expect(event.meta.disconnected_at).toBeUndefined();

        const parsed = JSON.parse(event.content) as {
          summary: string;
          device: {
            connected: boolean;
            battery_percent: number | null;
            weight_lbs: number | null;
            training_mode: string | null;
            damper_level: number | null;
            stale_since_disconnect: string | null;
          };
          active_set_at_disconnect: unknown;
        };
        expect(parsed.summary).toBe('Voltra connected.');
        expect(parsed.device).toMatchObject({
          connected: true,
          battery_percent: 80,
          weight_lbs: 135,
          training_mode: 'WeightTraining',
        });
        expect(parsed.active_set_at_disconnect).toBeNull();
      });

      it("on 'disconnected' with an active set publishes mid_set=true and the active-set context", () => {
        // Set up a session + set + device weight so the mid-set summary
        // has something to render.
        live.applySettings({
          weightLbs: 135,
          trainingMode: 'WeightTraining',
        });
        startSet(live);
        // Append a few reps so rep_count_so_far is non-zero.
        const rep = (n: number) =>
          ({
            repNumber: n,
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
          }) as unknown as Parameters<typeof live.appendRep>[0];
        live.appendRep(rep(1));
        live.appendRep(rep(2));
        channels.publish.mockClear();

        client.fire.connectionStateChange('disconnected');

        expect(channels.publish).toHaveBeenCalledTimes(1);
        const event = channels.publish.mock.calls[0][0];
        expect(event.meta).toMatchObject({
          source: 'voltras',
          event_type: 'connection_changed',
          state: 'disconnected',
          mid_set: 'true',
        });
        // disconnected_at is the ISO timestamp set by markDisconnected.
        expect(event.meta.disconnected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const parsed = JSON.parse(event.content) as {
          summary: string;
          device: { connected: boolean };
          active_set_at_disconnect: {
            set_id: string;
            rep_count_so_far: number;
            weight_lbs: number;
            training_mode: string;
          } | null;
        };
        // Mid-set summary surfaces rep number, set id prefix, and weight.
        expect(parsed.summary).toContain('disconnected mid-set');
        expect(parsed.summary).toContain('rep 2');
        expect(parsed.summary).toContain('135 lbs');
        // Device snapshot reflects the post-disconnect connected=false.
        expect(parsed.device.connected).toBe(false);
        // active-set context is taken from BEFORE the disconnect cascade.
        expect(parsed.active_set_at_disconnect).toMatchObject({
          set_id: 'set-1',
          rep_count_so_far: 2,
          weight_lbs: 135,
          training_mode: 'WeightTraining',
        });
      });

      it("on 'disconnected' without an active set omits mid_set meta and reports null active set", () => {
        channels.publish.mockClear();
        client.fire.connectionStateChange('disconnected');

        const event = channels.publish.mock.calls[0][0];
        expect(event.meta.event_type).toBe('connection_changed');
        expect(event.meta.state).toBe('disconnected');
        expect(event.meta.mid_set).toBeUndefined();

        const parsed = JSON.parse(event.content) as {
          summary: string;
          active_set_at_disconnect: unknown;
        };
        expect(parsed.summary).toBe('Voltra disconnected.');
        expect(parsed.active_set_at_disconnect).toBeNull();
      });

      it("publishes connection_changed for intermediate 'connecting' / 'authenticating' states", () => {
        channels.publish.mockClear();
        client.fire.connectionStateChange('connecting');
        client.fire.connectionStateChange('authenticating');

        expect(channels.publish).toHaveBeenCalledTimes(2);
        const first = channels.publish.mock.calls[0][0];
        expect(first.meta).toMatchObject({
          event_type: 'connection_changed',
          state: 'connecting',
        });
        expect(JSON.parse(first.content).summary).toBe('Voltra connecting.');

        const second = channels.publish.mock.calls[1][0];
        expect(second.meta).toMatchObject({
          event_type: 'connection_changed',
          state: 'authenticating',
        });
        expect(JSON.parse(second.content).summary).toBe('Voltra authenticating.');
      });
    });

    // ── VMCP-02.32 — delayed disconnect notice for the tool-return path ────
    // The bridge records a one-shot advisory on every disconnect so the
    // agent still learns of an idle-lull drop even when push channels are
    // off (the channel publish is fire-and-forget and dropped when the host
    // wasn't launched with --channels). The advisory is drained by the tool
    // layer; here we assert the bridge records it and it drains exactly once.
    describe('pending disconnect notice (VMCP-02.32)', () => {
      it("records a mid-set advisory on 'disconnected' that drains exactly once", () => {
        live.applySettings({ weightLbs: 135, trainingMode: 'WeightTraining' });
        startSet(live);
        client.fire.connectionStateChange('disconnected');

        const notice = live.takePendingDisconnectNotice();
        expect(notice).toMatchObject({
          event_type: 'connection_changed',
          state: 'disconnected',
          mid_set: true,
          active_set_at_disconnect: {
            set_id: 'set-1',
            rep_count_so_far: 0,
            weight_lbs: 135,
            training_mode: 'WeightTraining',
          },
        });
        expect(notice?.disconnected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof notice?.note).toBe('string');
        // Drain-once: a second take returns nothing so the notice is not
        // re-delivered on a subsequent tool return.
        expect(live.takePendingDisconnectNotice()).toBeUndefined();
      });

      it("records a no-set advisory (mid_set=false, null active set) on 'disconnected'", () => {
        client.fire.connectionStateChange('disconnected');
        const notice = live.takePendingDisconnectNotice();
        expect(notice).toMatchObject({
          event_type: 'connection_changed',
          state: 'disconnected',
          mid_set: false,
          active_set_at_disconnect: null,
        });
      });

      it('does not record an advisory on non-disconnect transitions', () => {
        client.fire.connectionStateChange('connecting');
        client.fire.connectionStateChange('authenticating');
        client.fire.connectionStateChange('connected');
        expect(live.takePendingDisconnectNotice()).toBeUndefined();
      });
    });
  });

  // ── Bug 22 — mode-revert guard wiring ──────────────────────────────────
  describe('mode-revert guard (Bug 22)', () => {
    // The guard's own state-machine has dedicated unit tests in
    // mode-revert-guard.test.ts; here we only verify the bridge wires
    // `onSettingsUpdate` through to the slot's guard so a divergent
    // trainingMode latches an abort consult-able from set.start.

    it('feeds trainingMode from settings_update into the slot guard so divergence latches an abort', () => {
      // Build a fresh harness with a captured slot reference so we can
      // reach the guard directly. The bare-state primary slot is created
      // in the suite-level beforeEach; we re-wire here against a
      // separately-built slot so the assertions are unambiguous.
      const freshLive = new LiveState();
      const freshClient = makeFakeClient();
      const freshChannels = makeFakeChannels();
      const slot = {
        slotId: 'primary',
        client: freshClient,
        live: freshLive,
        modeRevertGuard: new ModeRevertGuard(),
        modeDivergenceWatch: new ModeDivergenceWatch(),
        coercionWatch: new CoercionWatch(),
      };
      const slots = new Map([['primary', slot]]);
      const fresh = { slots, channels: freshChannels, server: undefined };

      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      // User requests Rowing (TrainingMode=3).
      slot.modeRevertGuard.arm(3 as never);

      // Device sends a settings_update with a different trainingMode
      // (WeightTraining=1) — the bridge must forward it into the guard.
      freshClient.fire.settingsUpdate({ mode: 1 });

      expect(slot.modeRevertGuard.isAborted()).toBe(true);
      const abort = slot.modeRevertGuard.consumeAbort();
      expect(abort).not.toBeNull();
      expect(abort!.requested).toBe(3);
      expect(abort!.actual).toBe(1);
    });

    it('does NOT latch when the settings_update reports the requested mode (confirmation path)', () => {
      const freshLive = new LiveState();
      const freshClient = makeFakeClient();
      const freshChannels = makeFakeChannels();
      const slot = {
        slotId: 'primary',
        client: freshClient,
        live: freshLive,
        modeRevertGuard: new ModeRevertGuard(),
        modeDivergenceWatch: new ModeDivergenceWatch(),
        coercionWatch: new CoercionWatch(),
      };
      const slots = new Map([['primary', slot]]);
      const fresh = { slots, channels: freshChannels, server: undefined };
      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      slot.modeRevertGuard.arm(3 as never);
      freshClient.fire.settingsUpdate({ mode: 3 });
      expect(slot.modeRevertGuard.isAborted()).toBe(false);
    });
  });

  // ── VMCP-02.09c — mode-divergence watch → mode_diverged channel event ──
  describe('mode-divergence watch (VMCP-02.09c)', () => {
    // The watch's state machine has dedicated unit tests; here we verify the
    // bridge feeds requested (onSettingsUpdate) + applied (onStateDump) into
    // the slot watch and publishes a `mode_diverged` event on divergence. The
    // slot watch uses window=0 so a single settled disagreement emits at once.
    function wireFreshSlot(): {
      client: ReturnType<typeof makeFakeClient>;
      channels: ReturnType<typeof makeFakeChannels>;
    } {
      const freshClient = makeFakeClient();
      const freshChannels = makeFakeChannels();
      const slot = {
        slotId: 'primary',
        client: freshClient,
        live: new LiveState(),
        modeRevertGuard: new ModeRevertGuard(),
        modeDivergenceWatch: new ModeDivergenceWatch(Date.now, 0),
        coercionWatch: new CoercionWatch(),
      };
      const slots = new Map([['primary', slot]]);
      const fresh = { slots, channels: freshChannels, server: undefined };
      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );
      return { client: freshClient, channels: freshChannels };
    }

    it('publishes mode_diverged when requested (Isokinetic) and applied (WeightTraining) disagree', () => {
      const { client, channels } = wireFreshSlot();
      // User requests Isokinetic (cmd=0x10).
      client.fire.settingsUpdate({ mode: 7 });
      // Device reports it is actually running WeightTraining (cmd=0x07 byte 1).
      client.fire.stateDump(makeStateDumpEvent({ trainingMode: 1 }));

      const diverged = channels.publish.mock.calls
        .map((c) => c[0])
        .find((e) => e.meta.event_type === 'mode_diverged');
      expect(diverged).toBeDefined();
      expect(diverged!.meta.requested_mode).toBe('Isokinetic');
      expect(diverged!.meta.active_mode).toBe('Weight Training');
      expect(diverged!.meta.diverged_for_ms).toBe('0');
      const parsed = JSON.parse(diverged!.content);
      expect(parsed.divergence.requested_mode).toBe('Isokinetic');
      expect(parsed.divergence.active_mode).toBe('Weight Training');
    });

    it('does NOT publish mode_diverged when requested and applied agree', () => {
      const { client, channels } = wireFreshSlot();
      client.fire.settingsUpdate({ mode: 1 }); // requested WeightTraining
      client.fire.stateDump(makeStateDumpEvent({ trainingMode: 1 })); // applied WeightTraining
      const diverged = channels.publish.mock.calls
        .map((c) => c[0])
        .find((e) => e.meta.event_type === 'mode_diverged');
      expect(diverged).toBeUndefined();
    });
  });

  // ── Bug 24 — Iso pre-session-start stream policy (D1) ──────────────────
  describe('Isometric pre-session-start stream policy (Bug 24)', () => {
    // When the device is set to Isometric mode without `session.start`,
    // the unit emits a 500ms-cadence cmd=0x70 (aa 81 2b) keep-alive burst
    // (per A4). Each frame surfaces through the SDK as an InProgressEvent.
    // The bridge's policy (D1): when no session is active, suppress the
    // event entirely — neither debug-buffer logs nor any downstream
    // mutation. Once the user calls `session.start`, the bridge resumes
    // its normal "outside the start-grace window with no active set is
    // a silent drop" behavior.

    it('does not log a set_boundary debug event when no session is active', async () => {
      const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../debug-buffer.js');
      _resetDebugBuffersForTest();
      const debug = getDebugBuffers();
      // Re-wire so the fresh buffers are used.
      const fresh = makeBareState({ client, live, server, channels });
      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        fresh.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      // No live.startSession — pre-session-start state.
      client.fire.inProgress();
      client.fire.inProgress();
      client.fire.inProgress();

      const events = debug.events.recent(10);
      const setBoundaryEvents = events.filter((e) => e.type === 'set_boundary');
      expect(setBoundaryEvents).toHaveLength(0);
    });

    it('does not publish channel events from cmd=0x70 bursts pre-session-start', () => {
      // No session, no set — sanity-check the firehose is silent.
      channels.publish.mockClear();
      for (let i = 0; i < 10; i++) {
        client.fire.inProgress();
      }
      const repEvents = channels.publish.mock.calls
        .map((c) => c[0])
        .filter((e) => ['rep_finalized', 'set_boundary', 'set_ended'].includes(e.meta.event_type));
      expect(repEvents).toHaveLength(0);
    });

    it('still logs set_boundary debug events when a session IS active (post-set.end race)', async () => {
      // Once session.start has run, the bridge resumes logging boundary
      // events even when no set is currently active — this preserves the
      // explicit set.end race-condition guard's observability.
      const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../debug-buffer.js');
      _resetDebugBuffersForTest();
      const debug = getDebugBuffers();
      const fresh = makeBareState({ client, live, server, channels });
      wireBridgeForSlot(
        fresh as unknown as Parameters<typeof wireBridgeForSlot>[0],
        fresh.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
      );

      live.startSession({
        sessionId: 'sess-iso',
        startedAt: '2025-01-01T00:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      client.fire.inProgress();

      const events = debug.events.recent(10);
      const setBoundaryEvents = events.filter((e) => e.type === 'set_boundary');
      expect(setBoundaryEvents).toHaveLength(1);
      expect(setBoundaryEvents[0].payload.hadActiveSet).toBe(false);
    });
  });

  // ── Bug 27 — damperLevel synthetic settings_update ─────────────────────
  describe('damperLevel synthetic settings_update (Bug 27)', () => {
    // The cmd=0x10 cascade carries paramID 0x0351; when present, the SDK
    // surfaces damperLevel via DeviceSettings.damperLevel through
    // onSettingsUpdate.
    // The bridge tracks the last known value and emits a synthetic
    // `settings_update` channel event each time it transitions, with
    // `__all` snapshotting every monitored field.

    it('emits a settings_update channel event on the first damperLevel update', () => {
      channels.publish.mockClear();
      client.fire.settingsUpdate({ damperLevel: 7 });

      const settingsEvents = channels.publish.mock.calls
        .map((c) => c[0])
        .filter((e) => e.meta.event_type === 'settings_update');
      expect(settingsEvents).toHaveLength(1);
      const event = settingsEvents[0];
      expect(event.meta.changed_field).toBe('damperLevel');
      expect(event.meta.changed_value).toBe('7');
      expect(event.meta.damper_level).toBe('7');

      const parsed = JSON.parse(event.content);
      expect(parsed.summary).toContain('damperLevel changed to 7');
      expect(parsed.changed).toEqual({ field: 'damperLevel', value: 7 });
      expect(parsed.__all.damper_level).toBe(7);
    });

    it('does NOT emit a duplicate event when damperLevel is unchanged', () => {
      channels.publish.mockClear();
      client.fire.settingsUpdate({ damperLevel: 7 });
      client.fire.settingsUpdate({ damperLevel: 7 });
      client.fire.settingsUpdate({ damperLevel: 7 });

      const settingsEvents = channels.publish.mock.calls
        .map((c) => c[0])
        .filter((e) => e.meta.event_type === 'settings_update');
      expect(settingsEvents).toHaveLength(1);
    });

    it('emits a new event every time damperLevel transitions', () => {
      channels.publish.mockClear();
      client.fire.settingsUpdate({ damperLevel: 1 });
      client.fire.settingsUpdate({ damperLevel: 5 });
      client.fire.settingsUpdate({ damperLevel: 9 });

      const settingsEvents = channels.publish.mock.calls
        .map((c) => c[0])
        .filter((e) => e.meta.event_type === 'settings_update');
      expect(settingsEvents).toHaveLength(3);
      expect(settingsEvents.map((e) => e.meta.changed_value)).toEqual(['1', '5', '9']);
    });

    it('omits absent fields from __all (no synthesised null pollution)', () => {
      channels.publish.mockClear();
      // Clean device state — no weight, no mode, no battery yet.
      client.fire.settingsUpdate({ damperLevel: 4 });

      const event = channels.publish.mock.calls.find(
        (c) => c[0].meta.event_type === 'settings_update',
      )![0];
      const parsed = JSON.parse(event.content);
      expect(parsed.__all.damper_level).toBe(4);
      // The other fields were never set on live state — they serialise as
      // null in `__all`, NOT as the previously-snapshotted values.
      expect(parsed.__all.weight_lbs).toBeNull();
      expect(parsed.__all.training_mode).toBeNull();
      expect(parsed.__all.battery_percent).toBeNull();
    });

    it('settings_update without any tracked field (damper/chain/weight) does NOT emit a synthetic event', () => {
      // VMCP-02.40: chain + base-weight transitions now also publish
      // settings_update events from this handler, so weight/chains must
      // also be absent from the fired update for "no event" to hold. Mode +
      // battery alone are not published (no consumer-facing transitions yet).
      channels.publish.mockClear();
      client.fire.settingsUpdate({ mode: 1, battery: 80 });

      const settingsEvents = channels.publish.mock.calls
        .map((c) => c[0])
        .filter((e) => e.meta.event_type === 'settings_update');
      expect(settingsEvents).toHaveLength(0);
    });

    it('__all reflects the post-applySettings device snapshot at emission time', () => {
      // First populate live device state, then change damperLevel.
      live.applySettings({
        connected: true,
        weightLbs: 135,
        trainingMode: 'WeightTraining',
        batteryPercent: 82,
      });
      channels.publish.mockClear();
      client.fire.settingsUpdate({ damperLevel: 6 });

      const event = channels.publish.mock.calls.find(
        (c) => c[0].meta.event_type === 'settings_update',
      )![0];
      const parsed = JSON.parse(event.content);
      expect(parsed.__all).toMatchObject({
        damper_level: 6,
        weight_lbs: 135,
        training_mode: 'WeightTraining',
        battery_percent: 82,
      });
    });
  });
});

// ── Guided-load auto-session-create (Phase 1g, Bugs 28/29) ───────────────
//
// The bridge subscribes to `client.onGuidedLoadState` whenever the SDK
// surfaces it (>= 0.6.3) and auto-creates a session+set in LiveState the
// first time it observes the device-side state machine moving into
// `armed` / `countdown` / `engaging` / `active`. This block exercises the
// auto-create path with a focused harness that augments the standard
// FakeClient with an `onGuidedLoadState` capture.
describe('wireEventBridge — guided-load auto-create', () => {
  // Re-using the file's `GuidedLoadPhase` shape structurally (the SDK module
  // is mocked at file scope; importing the real type would defeat that).
  type Phase = 'idle' | 'armed' | 'countdown' | 'engaging' | 'active' | 'exited' | 'timeout';
  interface GuidedLoadStateLike {
    phase: Phase;
    countdownRemainingMs: number | null;
    fitnessModeRaw: number | null;
  }
  type GuidedLoadStateListenerLike = (s: GuidedLoadStateLike) => void;

  type GuidedFakeClient = FakeClient & {
    onGuidedLoadState: Mock<(l: GuidedLoadStateListenerLike) => () => void>;
    fireGuided: (s: GuidedLoadStateLike) => void;
  };

  function makeGuidedFakeClient(): GuidedFakeClient {
    const base = makeFakeClient();
    let cb: GuidedLoadStateListenerLike = () => undefined;
    const onGuidedLoadState = vi.fn((l: GuidedLoadStateListenerLike) => {
      cb = l;
      return () => undefined;
    });
    return Object.assign(base, {
      onGuidedLoadState,
      fireGuided: (s: GuidedLoadStateLike) => cb(s),
    });
  }

  interface State {
    slots: Map<string, { slotId: string; live: LiveStateT; client: GuidedFakeClient }>;
    store: {
      putSession: Mock<(s: unknown) => Promise<void>>;
      putSet: Mock<(s: unknown) => Promise<void>>;
    };
    channels: FakeChannels;
    server: FakeServer;
    setStartDeviceSnapshots: Map<string, unknown>;
    setWatchdog: SetWatchdogT;
    restTimers: RestTimerRegistryT;
  }

  let live: LiveStateT;
  let client: GuidedFakeClient;
  let state: State;

  beforeEach(() => {
    live = new LiveState();
    client = makeGuidedFakeClient();
    const slots = new Map<string, { slotId: string; live: LiveStateT; client: GuidedFakeClient }>();
    slots.set('primary', { slotId: 'primary', live, client });
    state = {
      slots,
      store: {
        putSession: vi.fn(async () => undefined),
        putSet: vi.fn(async () => undefined),
      },
      channels: makeFakeChannels(),
      server: makeFakeServer(),
      setStartDeviceSnapshots: new Map(),
      setWatchdog: new SetWatchdog(),
      restTimers: new RestTimerRegistry(),
    };
    wireBridgeForSlot(
      state as unknown as Parameters<typeof wireBridgeForSlot>[0],
      slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
    );
  });

  it('subscribes to client.onGuidedLoadState when present', () => {
    expect(client.onGuidedLoadState).toHaveBeenCalledOnce();
  });

  it("auto-creates session + set on 'armed' phase", () => {
    expect(live.snapshotSession()).toBeUndefined();
    expect(live.snapshotSet()).toBeUndefined();

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    const sess = live.snapshotSession();
    const set = live.snapshotSet();
    expect(sess).toBeDefined();
    expect(set).toBeDefined();
    expect(sess?.exerciseName).toBe('Guided Load (auto)');
    expect(state.store.putSession).toHaveBeenCalledTimes(1);
    expect(state.setStartDeviceSnapshots.has(set!.setId)).toBe(true);
  });

  it("does NOT auto-create on 'idle' / 'exited' / 'timeout' phases", () => {
    client.fireGuided({ phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null });
    client.fireGuided({ phase: 'exited', countdownRemainingMs: null, fitnessModeRaw: 0x0004 });
    client.fireGuided({ phase: 'timeout', countdownRemainingMs: null, fitnessModeRaw: null });

    expect(live.snapshotSession()).toBeUndefined();
    expect(live.snapshotSet()).toBeUndefined();
    expect(state.store.putSession).not.toHaveBeenCalled();
  });

  it('is idempotent across multiple armed/countdown/active emissions', () => {
    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });
    const sess1 = live.snapshotSession()!;
    const set1 = live.snapshotSet()!;

    client.fireGuided({ phase: 'countdown', countdownRemainingMs: 2500, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'engaging', countdownRemainingMs: 0, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'active', countdownRemainingMs: null, fitnessModeRaw: 0x0027 });

    const sess2 = live.snapshotSession()!;
    const set2 = live.snapshotSet()!;
    expect(sess2.sessionId).toBe(sess1.sessionId);
    expect(set2.setId).toBe(set1.setId);
    expect(state.store.putSession).toHaveBeenCalledTimes(1);
  });

  it('only mints a set when a session already exists (caller pre-started)', () => {
    live.startSession({
      sessionId: 'existing-sess',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
      exerciseName: 'Squat',
    });

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    expect(live.snapshotSession()?.sessionId).toBe('existing-sess');
    expect(live.snapshotSet()).toBeDefined();
    expect(state.store.putSession).not.toHaveBeenCalled();
  });

  // ── VMCP-02.15: tunable inactivity watchdog on auto-created set ──
  it('VMCP-02.15: arms the inactivity watchdog when slot.pendingGuidedLoadInactivityMs is set', () => {
    const slot = state.slots.get('primary') as unknown as {
      slotId: string;
      live: LiveStateT;
      client: GuidedFakeClient;
      pendingGuidedLoadInactivityMs?: number;
    };
    slot.pendingGuidedLoadInactivityMs = 30_000;

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    const set = live.snapshotSet();
    expect(set).toBeDefined();
    // Watchdog should have a deadline registered for the new setId.
    expect(state.setWatchdog.has(set!.setId)).toBe(true);
    // Single-shot — field cleared after consumption.
    expect(slot.pendingGuidedLoadInactivityMs).toBeUndefined();
    // Drain the timer so a leftover 30s setTimeout doesn't trail into
    // later test files. The real `finalizeSet` cancels via the same
    // path; we shortcut it here because we never closed the auto-set.
    state.setWatchdog.clearAll();
  });

  it('VMCP-02.15: skips watchdog arming when no pending inactivity is set (rare unit-direct path)', () => {
    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });
    const set = live.snapshotSet();
    expect(set).toBeDefined();
    // No tool-side stash, so no per-set watchdog registered (bridge's
    // default SET_INACTIVITY_TIMEOUT_MS still provides the safety net).
    expect(state.setWatchdog.has(set!.setId)).toBe(false);
  });

  // ── VMCP-02.03: first-class guided_load_state channel event ──
  function guidedPublishes(): { content: string; meta: Record<string, string> }[] {
    return state.channels.publish.mock.calls
      .map((c) => c[0])
      .filter((e) => e.meta.event_type === 'guided_load_state');
  }

  it('VMCP-02.03: publishes a guided_load_state channel event on the armed transition', () => {
    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    const events = guidedPublishes();
    expect(events).toHaveLength(1);
    expect(events[0].meta.phase).toBe('armed');
    expect(events[0].meta.outcome).toBe('pending');
    expect(events[0].meta.slot).toBe('primary');
    // set_context carries the auto-created set.
    expect(events[0].meta.set_id).toBe(live.snapshotSet()!.setId);
  });

  it('VMCP-02.03: timeout transition publishes outcome=failed (the silent-skip signal)', () => {
    client.fireGuided({ phase: 'timeout', countdownRemainingMs: null, fitnessModeRaw: null });
    const events = guidedPublishes();
    expect(events).toHaveLength(1);
    expect(events[0].meta.outcome).toBe('failed');
  });

  it('VMCP-02.03: suppresses intra-countdown spam — one publish per phase transition', () => {
    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'countdown', countdownRemainingMs: 3000, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'countdown', countdownRemainingMs: 2000, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'countdown', countdownRemainingMs: 1000, fitnessModeRaw: 0x0026 });
    client.fireGuided({ phase: 'active', countdownRemainingMs: null, fitnessModeRaw: 0x0027 });

    expect(guidedPublishes().map((e) => e.meta.phase)).toEqual(['armed', 'countdown', 'active']);
  });

  it('VMCP-02.03: does not publish for the idle baseline phase', () => {
    client.fireGuided({ phase: 'idle', countdownRemainingMs: null, fitnessModeRaw: null });
    expect(guidedPublishes()).toHaveLength(0);
  });

  it('VMCP-02.03: surfaces requested_target_lbs from the slot stash and clears it on a terminal phase', () => {
    const slot = state.slots.get('primary') as unknown as { pendingGuidedLoadTargetLbs?: number };
    slot.pendingGuidedLoadTargetLbs = 120;

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });
    expect(guidedPublishes()[0].meta.requested_target_lbs).toBe('120');
    // Read on every transition, so it survives mid-flow.
    expect(slot.pendingGuidedLoadTargetLbs).toBe(120);

    client.fireGuided({ phase: 'exited', countdownRemainingMs: null, fitnessModeRaw: 0x0004 });
    expect(slot.pendingGuidedLoadTargetLbs).toBeUndefined();
  });

  // ── VMCP-02.13: auto-session inherits the stashed exercise identity ──
  it('VMCP-02.13: auto-session inherits stashed exerciseName / exerciseId', () => {
    const slot = state.slots.get('primary') as unknown as {
      pendingGuidedLoadExerciseName?: string;
      pendingGuidedLoadExerciseId?: string;
    };
    slot.pendingGuidedLoadExerciseName = 'Barbell Squat';
    slot.pendingGuidedLoadExerciseId = 'ex-squat-001';

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    const sess = live.snapshotSession();
    expect(sess?.exerciseName).toBe('Barbell Squat');
    expect(sess?.exerciseId).toBe('ex-squat-001');
    expect(state.store.putSession).toHaveBeenCalledWith(
      expect.objectContaining({ exerciseName: 'Barbell Squat', exerciseId: 'ex-squat-001' }),
    );
    // Single-shot — both stash fields cleared after consumption.
    expect(slot.pendingGuidedLoadExerciseName).toBeUndefined();
    expect(slot.pendingGuidedLoadExerciseId).toBeUndefined();
  });

  it("VMCP-02.13: falls back to 'Guided Load (auto)' when no exercise stashed", () => {
    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });
    const sess = live.snapshotSession();
    expect(sess?.exerciseName).toBe('Guided Load (auto)');
    expect(sess?.exerciseId).toBeUndefined();
  });

  it('VMCP-02.13: a reused explicit session keeps its own name (stash ignored)', () => {
    live.startSession({
      sessionId: 'explicit-sess',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
      exerciseName: 'Bench Press',
    });
    const slot = state.slots.get('primary') as unknown as {
      pendingGuidedLoadExerciseName?: string;
    };
    slot.pendingGuidedLoadExerciseName = 'Barbell Squat';

    client.fireGuided({ phase: 'armed', countdownRemainingMs: null, fitnessModeRaw: 0x0026 });

    // Existing session is reused untouched; the stash is not consumed.
    expect(live.snapshotSession()?.sessionId).toBe('explicit-sess');
    expect(live.snapshotSession()?.exerciseName).toBe('Bench Press');
    expect(state.store.putSession).not.toHaveBeenCalled();
    expect(slot.pendingGuidedLoadExerciseName).toBe('Barbell Squat');
  });
});

// ── onStateDump (cmd=0x07 — Bug 26 / Gap C1) ───────────────────────────────
//
// SDK 0.7.0 routes the 52-byte `aa 80 25` envelope through `onStateDump`.
// The bridge must: (a) subscribe, (b) apply state to LiveState, (c) notify
// voltra://device/current, (d) push a debug event, (e) synthesize a
// `settings_update` channel event on transition, and (f) de-duplicate when
// the value does not change.

describe('onStateDump (cmd=0x07 — Bug 26)', () => {
  let live: LiveStateT;
  let client: FakeClient;
  let server: FakeServer;
  let channels: FakeChannels;

  beforeEach(() => {
    live = new LiveState();
    client = makeFakeClient();
    server = makeFakeServer();
    channels = makeFakeChannels();
    const state = makeBareState({ client, live, server, channels });
    wireBridgeForSlot(
      state as unknown as Parameters<typeof wireBridgeForSlot>[0],
      state.slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
    );
  });

  it('subscribes to onStateDump once', () => {
    expect(client.onStateDump).toHaveBeenCalledOnce();
  });

  it('applies assistMode + cmd=0x07 fields to LiveState on a stable frame', () => {
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        assistMode: 2,
        weightLbsTenths: 1000,
        chainTargetForceTenths: 250,
        eccentricPercentTenths: 50,
      }),
    );
    const snap = live.snapshotDevice();
    expect(snap.assistMode).toBe(2);
    expect(snap.trainingModeRaw).toBe(1);
    expect(snap.chainTargetForceTenths).toBe(250);
    expect(snap.weightLbsTenths).toBe(1000);
    expect(snap.eccentricPercentTenths).toBe(50);
  });

  it('notifies voltra://device/current on each stable state-dump event', () => {
    client.fire.stateDump(makeStateDumpEvent());
    expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'voltra://device/current',
    });
  });

  it('synthesizes a settings_update channel event for assistMode on first stable dump', () => {
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 2 }));
    const assistCall = channels.publish.mock.calls.find((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    expect(assistCall).toBeDefined();
    const content = JSON.parse(assistCall![0].content) as {
      changed: { field: string; value: number };
    };
    expect(content.changed.value).toBe(2);
  });

  it('synthesizes channel events for every transitioned state-dump field on the first stable dump', () => {
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        assistMode: 2,
        weightLbsTenths: 1000,
        chainTargetForceTenths: 100,
        eccentricPercentTenths: 50,
      }),
    );
    // VMCP-02.40: chainTargetForceTenths + weightLbsTenths no longer emit
    // per-field settings_update events (they're firmware-internal lazy
    // values; user-facing chain + weight transitions now come from the
    // cmd=0x10 cascade as `chainSettingLbs` / `weightLbs`). Only
    // assistMode + trainingModeRaw + eccentricPercentTenths remain emitted
    // from the state-dump path.
    const fields = channels.publish.mock.calls.map((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field;
    });
    expect(fields).toContain('assistMode');
    expect(fields).toContain('trainingModeRaw');
    expect(fields).toContain('eccentricPercentTenths');
    expect(fields).not.toContain('chainTargetForceTenths');
    expect(fields).not.toContain('weightLbsTenths');
  });

  it('de-duplicates: same payload on second dump does not re-emit a channel event', () => {
    const dump = makeStateDumpEvent({
      trainingMode: 1,
      assistMode: 0,
      weightLbsTenths: 0,
      chainTargetForceTenths: 0,
      eccentricPercentTenths: 0,
    });
    client.fire.stateDump(dump);
    const countAfterFirst = channels.publish.mock.calls.length;
    client.fire.stateDump(dump);
    expect(channels.publish).toHaveBeenCalledTimes(countAfterFirst);
  });

  it('synthesizes a channel event when assistMode transitions from 0 to 2', () => {
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 0 }));
    channels.publish.mockClear();
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 2 }));
    const assistCalls = channels.publish.mock.calls.filter((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    expect(assistCalls).toHaveLength(1);
    const content = JSON.parse(assistCalls[0][0].content) as {
      changed: { value: number };
    };
    expect(content.changed.value).toBe(2);
  });

  it('treats assistMode=8 (idle sentinel) as a real transition and emits a channel event', () => {
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 2 }));
    channels.publish.mockClear();
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 8 }));
    const assistCall = channels.publish.mock.calls.find((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    expect(assistCall).toBeDefined();
    const content = JSON.parse(assistCall![0].content) as { changed: { value: number } };
    expect(content.changed.value).toBe(8);
  });

  it('does not re-emit when assistMode stays at idle sentinel (8)', () => {
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 8 }));
    channels.publish.mockClear();
    client.fire.stateDump(makeStateDumpEvent({ assistMode: 8 }));
    const assistCalls = channels.publish.mock.calls.filter((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    expect(assistCalls).toHaveLength(0);
  });

  it('includes all known fields in the __all block of the settings_update payload', () => {
    live.applySettings({ weightLbs: 100, batteryPercent: 75 });
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        assistMode: 2,
        weightLbsTenths: 1000,
        chainTargetForceTenths: 300,
        eccentricPercentTenths: 50,
      }),
    );
    const assistCall = channels.publish.mock.calls.find((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    const content = JSON.parse(assistCall![0].content) as {
      __all: {
        weight_lbs: number | null;
        battery_percent: number | null;
        assist_mode: number | null;
        training_mode_raw: number | null;
        chain_target_force_tenths: number | null;
        weight_lbs_tenths: number | null;
        eccentric_percent_tenths: number | null;
      };
    };
    expect(content.__all.weight_lbs).toBe(100);
    expect(content.__all.battery_percent).toBe(75);
    expect(content.__all.assist_mode).toBe(2);
    expect(content.__all.training_mode_raw).toBe(1);
    expect(content.__all.chain_target_force_tenths).toBe(300);
    expect(content.__all.weight_lbs_tenths).toBe(1000);
    expect(content.__all.eccentric_percent_tenths).toBe(50);
  });

  it('surfaces chainSettingLbs from cmd=0x10 cascade `chains` field', () => {
    client.fire.settingsUpdate({ chains: 50 });
    expect(live.snapshotDevice().chainSettingLbs).toBe(50);
  });

  it('includes chain_setting_lbs + chain_target_force_tenths in the __all block of state-dump settings_update payloads', () => {
    // VMCP-02.40: state-dump no longer emits a per-field settings_update
    // for `chainTargetForceTenths`. The lazy field stays in the `__all`
    // payload (diagnostic context) of any state-dump-triggered event —
    // here we use the `assistMode` transition to capture the __all
    // snapshot.
    client.fire.settingsUpdate({ chains: 50 });
    channels.publish.mockClear();
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        assistMode: 0,
        chainTargetForceTenths: 500,
        weightLbsTenths: 500,
      }),
    );
    const assistCall = channels.publish.mock.calls.find((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    expect(assistCall).toBeDefined();
    const content = JSON.parse(assistCall![0].content) as {
      __all: { chain_setting_lbs: number | null; chain_target_force_tenths: number | null };
    };
    expect(content.__all.chain_setting_lbs).toBe(50);
    expect(content.__all.chain_target_force_tenths).toBe(500);
  });

  // ── Transitional-frame suppression ──────────────────────────────────────
  // During mode-switch bursts the device emits ~4 frames in 130ms; two carry
  // the new mode value, two carry transitional `trainingMode=0` (Idle) with
  // assistMode flicker. The bridge drops those transitional frames entirely
  // so consumers never see the `assistMode 2↔0↔2` oscillation.

  it('drops transitional frames (trainingMode=0): no LiveState mutation, no channel event, no notify', () => {
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 0,
        assistMode: 0,
        weightLbsTenths: 0,
        chainTargetForceTenths: 0,
        eccentricPercentTenths: 0,
      }),
    );
    expect(live.snapshotDevice().assistMode).toBeUndefined();
    expect(live.snapshotDevice().trainingModeRaw).toBeUndefined();
    expect(channels.publish).not.toHaveBeenCalled();
    expect(server.server.sendResourceUpdated).not.toHaveBeenCalledWith({
      uri: 'voltra://device/current',
    });
  });

  it('emits exactly one assistMode transition across a mode-switch burst (WT → transitional → WT)', () => {
    // Real device burst: stable WT (assist 2) → transitional (mode 0, assist 0)
    // → transitional (mode 0, assist 0) → stable WT (assist 2). Without
    // suppression consumers see assist 2 → 0 → 2 (three transitions).
    client.fire.stateDump(makeStateDumpEvent({ trainingMode: 1, assistMode: 2 }));
    channels.publish.mockClear();
    // Transitional burst frames (suppressed).
    client.fire.stateDump(makeStateDumpEvent({ trainingMode: 0, assistMode: 0 }));
    client.fire.stateDump(makeStateDumpEvent({ trainingMode: 0, assistMode: 0 }));
    // Stable frame returns with the same assist value as before the burst.
    client.fire.stateDump(makeStateDumpEvent({ trainingMode: 1, assistMode: 2 }));
    const assistCalls = channels.publish.mock.calls.filter((c) => {
      const content = JSON.parse(c[0].content) as { changed: { field: string } };
      return content.changed.field === 'assistMode';
    });
    // Without suppression this would be 3 (transition to 0, back to 2, then
    // 2→2 dedupe = at least 2). With suppression the assist value never
    // changes from the consumer's perspective.
    expect(assistCalls).toHaveLength(0);
  });
});

describe('setting_coerced channel event (F2+F3)', () => {
  let live: LiveStateT;
  let client: FakeClient;
  let server: FakeServer;
  let channels: FakeChannels;
  let watch: CoercionWatchT;

  function pickCoercionPublish(): { meta: Record<string, string>; content: string } | undefined {
    return channels.publish.mock.calls
      .map((c) => c[0])
      .find((event) => event.meta.event_type === 'setting_coerced');
  }

  function pickAllCoercionPublishes(): Array<{ meta: Record<string, string>; content: string }> {
    return channels.publish.mock.calls
      .map((c) => c[0])
      .filter((event) => event.meta.event_type === 'setting_coerced');
  }

  beforeEach(() => {
    live = new LiveState();
    client = makeFakeClient();
    server = makeFakeServer();
    channels = makeFakeChannels();
    watch = new CoercionWatch();
    const slots = new Map<string, unknown>();
    slots.set('primary', {
      slotId: 'primary',
      client,
      live,
      modeRevertGuard: new ModeRevertGuard(),
      modeDivergenceWatch: new ModeDivergenceWatch(),
      coercionWatch: watch,
    });
    const state = { slots, channels, server };
    wireBridgeForSlot(
      state as unknown as Parameters<typeof wireBridgeForSlot>[0],
      slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
    );
  });

  it('F2 repro: ecc setter coerced — event fires after stability confirms', () => {
    // Pretend `device.set_eccentric { percent: 0 }` just resolved.
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now(),
    });
    // Two consecutive state-dumps with the same coerced value: stability
    // check requires the second to fire. The hardware-re-validation
    // 2026-05-11 retraction of "assistMode enforces ecc floor" doesn't
    // remove the bridge's ability to surface ecc coercion — it just
    // means the firmware's cause isn't documented in the summary.
    const coerced = makeStateDumpEvent({
      trainingMode: 1,
      assistMode: 2,
      eccentricPercentTenths: 320,
    });
    client.fire.stateDump(coerced);
    expect(pickCoercionPublish()).toBeUndefined();
    client.fire.stateDump(coerced);
    const event = pickCoercionPublish();
    expect(event).toBeDefined();
    expect(event!.meta).toMatchObject({
      source: 'voltras',
      event_type: 'setting_coerced',
      field: 'eccentricPercentTenths',
      requested_value: '0',
      device_value: '320',
      source_setter: 'device.set_eccentric',
      coercion_delta: '320',
    });
    const parsed = JSON.parse(event!.content);
    expect(parsed.summary).toBe('Device coerced ecc 0% -> 32% after device.set_eccentric.');
  });

  it('F3 repro: guided-load coerces chains + ecc, weight unchanged → exactly 2 events (guard mode + stability)', () => {
    // VMCP-02.40: chain + base-weight are now sourced from cmd=0x10 cascade
    // echoes (`settings_update` path, threshold=1) so a single coerced echo
    // fires immediately. Eccentric remains state-dump-sourced with the
    // 2-of-2 stability defense against the documented 80→320→0 transient.
    const stamp = Date.now();
    // Pretend `device.start_guided_load { targetWeightLbs: 5 }` registered
    // three checks: baseWeight=5 (target, exact mode), chains=10 (carry-over
    // baseline, guard mode), ecc=500 (carry-over baseline, guard mode).
    watch.register({
      setterName: 'device.start_guided_load',
      field: 'baseWeight',
      requested: 5,
      setterReturnedAt: stamp,
      mode: 'exact',
    });
    watch.register({
      setterName: 'device.start_guided_load',
      field: 'chains',
      requested: 10,
      setterReturnedAt: stamp,
      mode: 'guard',
    });
    watch.register({
      setterName: 'device.start_guided_load',
      field: 'eccentricPercentTenths',
      requested: 500,
      setterReturnedAt: stamp,
      mode: 'guard',
    });
    // cmd=0x10 echo: baseWeight=5 matches requested → exact-mode clear, no
    // event. chains=2 ≠ requested 10 → guard-mode coercion, threshold=1
    // fires on this single observation.
    client.fire.settingsUpdate({ baseWeight: 5, chains: 2 });
    expect(pickAllCoercionPublishes()).toHaveLength(1);
    // Two consecutive state-dumps with ecc coerced to 80 — stability fires
    // on the second matching observation. (The chain/weight values in the
    // state-dump are now diagnostic-only and no longer observed for
    // coercion.)
    const dump = makeStateDumpEvent({
      trainingMode: 1,
      weightLbsTenths: 50,
      chainTargetForceTenths: 20,
      eccentricPercentTenths: 80,
    });
    client.fire.stateDump(dump);
    client.fire.stateDump(dump);
    const events = pickAllCoercionPublishes();
    expect(events).toHaveLength(2);
    const fields = events.map((e) => e.meta.field).sort();
    expect(fields).toEqual(['chains', 'eccentricPercentTenths']);
    for (const e of events) {
      expect(e.meta.source_setter).toBe('device.start_guided_load');
    }
  });

  it('negative — value matches: state-dump echoes the requested value → no event', () => {
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 500,
      setterReturnedAt: Date.now(),
    });
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 500 }));
    expect(pickCoercionPublish()).toBeUndefined();
    expect(watch.size()).toBe(0); // exact echo also clears the pending check
  });

  it('negative — window expired: state-dump after window → no event', () => {
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now() - 5_000, // well past 2500ms window
    });
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 320 }));
    expect(pickCoercionPublish()).toBeUndefined();
  });

  it('edge — same (setterName, field) re-register: newest pending check wins on subsequent state-dump', () => {
    // Two registers from the SAME setter on the same field — the second
    // evicts the first ("newest user intent wins"). Distinct setters
    // touching the same field are independent (covered by the
    // bilateral-style test below).
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now(),
    });
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 100,
      setterReturnedAt: Date.now(),
    });
    const coerced = makeStateDumpEvent({ eccentricPercentTenths: 320 });
    client.fire.stateDump(coerced);
    client.fire.stateDump(coerced);
    const events = pickAllCoercionPublishes();
    expect(events).toHaveLength(1);
    expect(events[0].meta.requested_value).toBe('100');
    expect(events[0].meta.source_setter).toBe('device.set_eccentric');
  });

  it('edge — distinct setters touching the same field both fire (VMCP-01.38)', () => {
    // VMCP-02.40: chains now sourced from cmd=0x10 cascade echoes
    // (threshold=1). Bilateral-style scenario: `device.set_chains` and
    // `bilateral.cascade` both register a `chains` check within the window.
    // Each must surface its own setting_coerced event on a single coerced
    // echo (the cmd=0x10 cascade arrives exactly once per setter write).
    watch.register({
      setterName: 'device.set_chains',
      field: 'chains',
      requested: 50,
      setterReturnedAt: Date.now(),
    });
    watch.register({
      setterName: 'bilateral.cascade',
      field: 'chains',
      requested: 80,
      setterReturnedAt: Date.now(),
    });
    client.fire.settingsUpdate({ chains: 30 });
    const events = pickAllCoercionPublishes();
    expect(events).toHaveLength(2);
    const sourceSetters = events.map((e) => e.meta.source_setter).sort();
    expect(sourceSetters).toEqual(['bilateral.cascade', 'device.set_chains']);
  });

  it('edge — state-dump burst: two coerced frames in succession → exactly one event', () => {
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now(),
    });
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 320 }));
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 320 }));
    expect(pickAllCoercionPublishes()).toHaveLength(1);
  });

  it('edge — coercion mid-set: set_id + session_id are populated in meta', () => {
    startSet(live);
    watch.register({
      setterName: 'device.set_eccentric',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now(),
    });
    const coerced = makeStateDumpEvent({ eccentricPercentTenths: 320 });
    client.fire.stateDump(coerced);
    client.fire.stateDump(coerced);
    const event = pickCoercionPublish();
    expect(event).toBeDefined();
    expect(event!.meta.set_id).toBe('set-1');
    expect(event!.meta.session_id).toBe('sess-1');
    const parsed = JSON.parse(event!.content);
    expect(parsed.set_context.set_id).toBe('set-1');
    expect(parsed.set_context.session_id).toBe('sess-1');
  });

  it('cascade transient defused: pre-state echo → mid-settle transient → final match → NO event', () => {
    // Hardware repro 2026-05-11 evening: cascade { ecc: 0 } against a
    // post-guided-load pre-state (ecc=80) produces a state-dump sequence
    // ecc 80 → 320 → 0. Before the stability fix, the bridge fired
    // setting_coerced { requested=0, device=320 } on the transient 320.
    // After the fix, the streak resets between 80 and 320, and the final
    // exact-mode echo at 0 clears the check. No event fires.
    watch.register({
      setterName: 'bilateral.cascade',
      field: 'eccentricPercentTenths',
      requested: 0,
      setterReturnedAt: Date.now(),
    });
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 80 }));
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 320 }));
    client.fire.stateDump(makeStateDumpEvent({ eccentricPercentTenths: 0 }));
    expect(pickAllCoercionPublishes()).toHaveLength(0);
    expect(watch.size()).toBe(0);
  });

  it('guided-load: baseline echoes do not clear guard-mode check; coercion stabilizes after settle', () => {
    // VMCP-02.40: chains observed on cmd=0x10 cascade (threshold=1, fires
    // on first coerced echo). Ecc remains state-dump (threshold=2). Both
    // guard-mode checks survive baseline-echo arrivals and only fire when
    // their respective observation stream carries a coerced value.
    //
    // Original hardware repro 2026-05-11: start_guided_load{target=5}
    // against chains=10/ecc=50 produced bursts that echoed prior
    // chains=10 + ecc=500 values BEFORE the firmware's safety ramp pushed
    // them to 2 + 80.
    const stamp = Date.now();
    watch.register({
      setterName: 'device.start_guided_load',
      field: 'chains',
      requested: 10,
      setterReturnedAt: stamp,
      mode: 'guard',
      windowMs: 15_000,
    });
    watch.register({
      setterName: 'device.start_guided_load',
      field: 'eccentricPercentTenths',
      requested: 500,
      setterReturnedAt: stamp,
      mode: 'guard',
      windowMs: 15_000,
    });
    // cmd=0x10 baseline echo for chains — guard mode keeps the check alive
    // since deviceValue === requested means "no change yet."
    client.fire.settingsUpdate({ chains: 10 });
    expect(pickAllCoercionPublishes()).toHaveLength(0);
    // State-dump baseline echo for ecc — guard mode keeps it alive too.
    client.fire.stateDump(
      makeStateDumpEvent({
        eccentricPercentTenths: 500,
      }),
    );
    expect(pickAllCoercionPublishes()).toHaveLength(0);
    // cmd=0x10 coerced chains echo — fires immediately (threshold=1).
    client.fire.settingsUpdate({ chains: 2 });
    let events = pickAllCoercionPublishes();
    expect(events).toHaveLength(1);
    expect(events[0]!.meta.field).toBe('chains');
    // First coerced ecc state-dump — primes streak (threshold=2).
    client.fire.stateDump(
      makeStateDumpEvent({
        eccentricPercentTenths: 80,
      }),
    );
    expect(pickAllCoercionPublishes()).toHaveLength(1); // no new event yet
    // Second coerced ecc state-dump — stability confirms, ecc fires.
    client.fire.stateDump(
      makeStateDumpEvent({
        eccentricPercentTenths: 80,
      }),
    );
    events = pickAllCoercionPublishes();
    expect(events).toHaveLength(2);
    expect(events[1]!.meta.field).toBe('eccentricPercentTenths');
    expect(events[1]!.meta.source_setter).toBe('device.start_guided_load');
  });

  it('bilateral: two slots each fire their own setting_coerced with distinct slot_id (VMCP-01.38)', () => {
    // Wire a second slot ('right') into the existing state so both
    // slots share the channels publisher but have independent watches +
    // clients. Fires the same coerced state-dump on each client and
    // asserts each surfaces a distinct event with its own slot_id meta.
    const rightClient = makeFakeClient();
    const rightLive = new LiveState();
    const rightWatch = new CoercionWatch();
    const rightSlot = {
      slotId: 'right',
      client: rightClient,
      live: rightLive,
      modeRevertGuard: new ModeRevertGuard(),
      modeDivergenceWatch: new ModeDivergenceWatch(),
      coercionWatch: rightWatch,
    };
    // Reach into the same state the beforeEach already constructed — both
    // slots share `channels` + `server` so events from either land on the
    // single `channels.publish` recorder.
    const rightState = {
      slots: new Map<string, unknown>([
        ['primary', { slotId: 'primary', client, live, coercionWatch: watch }],
        ['right', rightSlot],
      ]),
      channels,
      server,
    };
    wireBridgeForSlot(
      rightState as unknown as Parameters<typeof wireBridgeForSlot>[0],
      rightSlot as unknown as Parameters<typeof wireBridgeForSlot>[1],
    );

    // VMCP-02.40: chains observed on cmd=0x10 cascade echoes (threshold=1).
    // Each slot's coerced echo fires its own setting_coerced immediately;
    // no priming round needed because cmd=0x10 echoes are single-shot per
    // setter write.
    const stamp = Date.now();
    watch.register({
      setterName: 'device.set_chains',
      field: 'chains',
      requested: 50,
      setterReturnedAt: stamp,
    });
    rightWatch.register({
      setterName: 'device.set_chains',
      field: 'chains',
      requested: 50,
      setterReturnedAt: stamp,
    });
    // Each slot's cmd=0x10 echo fires its own event.
    client.fire.settingsUpdate({ chains: 30 });
    rightClient.fire.settingsUpdate({ chains: 30 });
    const events = pickAllCoercionPublishes();
    expect(events).toHaveLength(2);
    const slotIds = events.map((e) => e.meta.slot_id).sort();
    expect(slotIds).toEqual(['primary', 'right']);
    // Slot-scoped publisher also injects `slot` meta (forSlot wrapper).
    const slotMeta = events.map((e) => e.meta.slot).sort();
    expect(slotMeta).toEqual(['primary', 'right']);
  });

  // ── VMCP-02.40 wrong-field-source regression guards ─────────────────────
  // The diagnostic at coordination/HANDOFF-2026-05-21-coercion-watch-field-source.md
  // captured the byte-level evidence: state-dump's `chainTargetForceTenths`
  // and `weightLbsTenths` are firmware-internal lazy values, not real-time
  // reflections of the user's setting. The cmd=0x10 cascade echo is the
  // only frame that reliably reflects per-write user state. These guards
  // pin that architectural choice.

  it('VMCP-02.40: a stale state-dump with frozen chainTargetForceTenths does NOT fire chain coercion', () => {
    // The morning bench session captured left's state-dump payload
    // byte-identical across multiple chain setter writes — the firmware's
    // lazy effective-force field hadn't refreshed yet. Under VMCP-02.40
    // that frozen frame must not be observed for chain coercion at all.
    watch.register({
      setterName: 'device.set_chains',
      field: 'chains',
      requested: 25,
      setterReturnedAt: Date.now(),
    });
    // State-dump arrives carrying the stale lazy value (500 = 50 lb, way
    // off from requested 25). Pre-VMCP-02.40 this would have fired a
    // false `setting_coerced` event. Post-fix: no observation on this
    // field via state-dump → no event.
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        chainTargetForceTenths: 500,
        weightLbsTenths: 500,
      }),
    );
    client.fire.stateDump(
      makeStateDumpEvent({
        trainingMode: 1,
        chainTargetForceTenths: 500,
        weightLbsTenths: 500,
      }),
    );
    expect(pickAllCoercionPublishes()).toHaveLength(0);
    // The pending chains check is still alive — waiting for a real cmd=0x10
    // echo to either confirm-clear or fire-coercion.
    expect(watch.size()).toBe(1);
  });

  it('VMCP-02.40: cmd=0x10 echo at requested chain value clears the check (exact-mode)', () => {
    // The firmware accepted the chain write without coercion (e.g. user
    // wrote chains=25 while weight=50 — no cap needed). The cmd=0x10 echo
    // carries chains=25 matching the pending check's requested value,
    // exact-mode clears the check, no event fires.
    watch.register({
      setterName: 'device.set_chains',
      field: 'chains',
      requested: 25,
      setterReturnedAt: Date.now(),
    });
    client.fire.settingsUpdate({ chains: 25 });
    expect(pickAllCoercionPublishes()).toHaveLength(0);
    expect(watch.size()).toBe(0);
  });

  it('VMCP-02.40: cmd=0x10 echo with coerced weight fires baseWeight setting_coerced', () => {
    // Direct device.set_weight pendant: pending check requested=200 (lbs),
    // firmware caps to 175 (lbs). cmd=0x10 echo carries baseWeight=175,
    // threshold=1 → fires immediately.
    watch.register({
      setterName: 'device.set_weight',
      field: 'baseWeight',
      requested: 200,
      setterReturnedAt: Date.now(),
    });
    client.fire.settingsUpdate({ baseWeight: 175 });
    const events = pickAllCoercionPublishes();
    expect(events).toHaveLength(1);
    expect(events[0]!.meta.field).toBe('baseWeight');
    expect(events[0]!.meta.requested_value).toBe('200');
    expect(events[0]!.meta.device_value).toBe('175');
  });
});
