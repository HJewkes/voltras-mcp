// Unit tests for the SDK event-bridge (Wave 2C).
//
// Strategy: build a fake `VoltraClient` that captures every `on*` listener
// in a Map keyed by event name; tests then drive each listener directly to
// simulate SDK callbacks. The MCP server is replaced with a stub exposing a
// spy on `server.sendResourceUpdated` — the real `Server` is not constructed
// because all the bridge needs is the lower-level handle.
//
// Coverage targets (NF-03 floor 70% for event-bridge.ts):
//   - onRepBoundary fires sendResourceUpdated for voltra://set/active when a
//     set is active.
//   - onRepBoundary on no-active-set is a silent drop (EC-11).
//   - onSettingsUpdate maps SDK fields to DeviceSnapshot fields and notifies
//     voltra://device/current.
//   - onSettingsUpdate coerces battery=null to absent (FIX #6).
//   - onConnectionStateChange('connected') flips connected to true; on
//     'disconnected' calls markDisconnected and notifies all three URIs (R24).
//   - onSetBoundary subscribes but does not mutate state nor notify (gap
//     filed by the critic; bridge owns the no-action policy).
//   - Raw frame events (onFrame) are NOT subscribed by the bridge (R16:
//     typed-only, no Buffer leak).
//
// Note on the SDK signature: `client.onRepBoundary` is `() => void` in the
// installed `@voltras/node-sdk`. The bridge therefore cannot call
// `live.appendRep(rep)` from this signal alone — rep construction from the
// frame stream is Wave 3's responsibility. The bridge's role for the rep
// boundary is to (a) drop the signal when no set is active and (b) emit the
// resource-updated hint when one is. EC-11 (stale rep drop) is enforced at
// the bridge layer by the active-set check before the hint is sent.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

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
const { wireEventBridge } = await import('../event-bridge.js');

// Local typings for the fake client so the test file does not depend on the
// real SDK module shape — we only model the listener-registration surface
// the bridge uses.
type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';
type RepBoundaryListener = () => void;
type SetBoundaryListener = () => void;
type SettingsUpdateListener = (settings: SdkSettings) => void;
type ConnectionStateListener = (state: ConnectionState) => void;

interface SdkSettings {
  weight?: number;
  chains?: number;
  inverseChains?: number;
  eccentric?: number;
  mode?: number; // TrainingMode enum value
  battery?: number | null;
}

interface FakeClient {
  onRepBoundary: Mock<(l: RepBoundaryListener) => () => void>;
  onSetBoundary: Mock<(l: SetBoundaryListener) => () => void>;
  onSettingsUpdate: Mock<(l: SettingsUpdateListener) => () => void>;
  onConnectionStateChange: Mock<(l: ConnectionStateListener) => () => void>;
  // The bridge subscribes to onFrame to assemble Reps from the typed
  // telemetry stream (R16 — typed values, no raw buffers).
  onFrame: Mock<(l: (frame: unknown) => void) => () => void>;
  // Captured listeners for direct invocation.
  fire: {
    repBoundary: () => void;
    setBoundary: () => void;
    settingsUpdate: (settings: SdkSettings) => void;
    connectionStateChange: (state: ConnectionState) => void;
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

function makeFakeClient(): FakeClient {
  let repCb: RepBoundaryListener = () => undefined;
  let setCb: SetBoundaryListener = () => undefined;
  let settingsCb: SettingsUpdateListener = () => undefined;
  let connCb: ConnectionStateListener = () => undefined;

  const onRepBoundary = vi.fn((l: RepBoundaryListener) => {
    repCb = l;
    return () => undefined;
  });
  const onSetBoundary = vi.fn((l: SetBoundaryListener) => {
    setCb = l;
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
  let frameCb: (frame: unknown) => void = () => undefined;
  const onFrame = vi.fn((l: (f: unknown) => void) => {
    frameCb = l;
    return () => undefined;
  });

  return {
    onRepBoundary,
    onSetBoundary,
    onSettingsUpdate,
    onConnectionStateChange,
    onFrame,
    fire: {
      repBoundary: () => repCb(),
      setBoundary: () => setCb(),
      settingsUpdate: (s) => settingsCb(s),
      connectionStateChange: (s) => connCb(s),
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
}

function makeFakeChannels(): FakeChannels {
  return { publish: vi.fn() };
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

describe('wireEventBridge', () => {
  let live: LiveStateT;
  let client: FakeClient;
  let server: FakeServer;
  let channels: FakeChannels;

  beforeEach(() => {
    live = new LiveState();
    client = makeFakeClient();
    server = makeFakeServer();
    channels = makeFakeChannels();
    // Cast through unknown to keep test-only types decoupled from the SDK
    // module — the bridge accepts the structural surface we provide.
    wireEventBridge(
      client as unknown as Parameters<typeof wireEventBridge>[0],
      live,
      server as unknown as Parameters<typeof wireEventBridge>[2],
      channels as unknown as Parameters<typeof wireEventBridge>[3],
    );
  });

  describe('subscription surface', () => {
    it('subscribes to onRepBoundary, onSetBoundary, onSettingsUpdate, and onConnectionStateChange', () => {
      expect(client.onRepBoundary).toHaveBeenCalledOnce();
      expect(client.onSetBoundary).toHaveBeenCalledOnce();
      expect(client.onSettingsUpdate).toHaveBeenCalledOnce();
      expect(client.onConnectionStateChange).toHaveBeenCalledOnce();
    });

    it('subscribes to onFrame to assemble Reps from telemetry stream (R16)', () => {
      // Frames carry typed numeric values (no raw buffers). The bridge maps
      // each frame to a WorkoutSample and uses analytics' `addSampleToRep`
      // to assemble a Rep on each onRepBoundary signal.
      expect(client.onFrame).toHaveBeenCalledOnce();
    });
  });

  describe('onRepBoundary (debug-only post-fix)', () => {
    // The device fires onRepBoundary at every phase transition (concentric
    // → eccentric → idle), so it cannot be the "rep complete" signal — that
    // would double-count every rep. The bridge logs onRepBoundary to the
    // debug buffer but does NOT mutate live state or notify resources.
    it('does not mutate live state on bare boundary (no frames buffered)', () => {
      startSet(live);
      const before = live.snapshotSet();
      client.fire.repBoundary();
      expect(live.snapshotSet()).toEqual(before);
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });

    it('drops the signal silently when no set is active', () => {
      client.fire.repBoundary();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('frame-driven cycle detection', () => {
    function feedFrame(seq: number, phase: number): void {
      client.fire.frame({
        sequence: seq,
        timestamp: 1000 + seq,
        phase,
        position: 0.1 * seq,
        velocity: 0.5,
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

    it('publishes a rep_finalized claude/channel event when a new rep is detected', () => {
      startSet(live);
      // First rep: CONCENTRIC -> ECCENTRIC -> IDLE closes rep 1.
      feedFrame(1, 1);
      feedFrame(2, 3);
      feedFrame(3, 0);

      expect(channels.publish).toHaveBeenCalled();
      const event = channels.publish.mock.calls[0][0];
      expect(event.meta.source).toBe('voltras');
      expect(event.meta.event_type).toBe('rep_finalized');
      expect(event.meta.set_id).toBe('set-1');
      expect(event.meta.rep_count).toBe('1');
      expect(typeof event.content).toBe('string');
    });

    it('does not publish a channel event when no set is active', () => {
      feedFrame(1, 1);
      feedFrame(2, 3);
      expect(channels.publish).not.toHaveBeenCalled();
    });
  });

  describe('onSetBoundary', () => {
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
      // Feed half a rep (CONCENTRIC), then receive a spurious set_boundary
      // within the grace window — the cycle detector should keep its state.
      client.fire.frame({
        sequence: 1,
        timestamp: 1001,
        phase: 1,
        position: 0.1,
        velocity: 0.5,
        force: 50,
      });
      client.fire.setBoundary();

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

    it('outside the grace window emits no resource update and does not mutate live state', () => {
      // startSet() helper uses 2025-01-01 — well outside the 500ms grace.
      startSet(live);
      const before = live.snapshotSet();
      client.fire.setBoundary();
      expect(live.snapshotSet()).toEqual(before);
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
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
  });
});
