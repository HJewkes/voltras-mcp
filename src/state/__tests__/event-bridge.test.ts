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

  beforeEach(() => {
    live = new LiveState();
    client = makeFakeClient();
    server = makeFakeServer();
    // Cast through unknown to keep test-only types decoupled from the SDK
    // module — the bridge accepts the structural surface we provide.
    wireEventBridge(
      client as unknown as Parameters<typeof wireEventBridge>[0],
      live,
      server as unknown as Parameters<typeof wireEventBridge>[2],
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

  describe('onRepBoundary', () => {
    it('fires sendResourceUpdated for voltra://set/active when a set is active', () => {
      startSet(live);
      // Feed at least one frame so the bridge has samples to assemble a Rep.
      client.fire.frame({
        sequence: 1,
        timestamp: Date.now(),
        phase: 1, // CONCENTRIC
        position: 0.1,
        velocity: 0.5,
        force: 50,
      });
      client.fire.repBoundary();
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://set/active',
      });
      expect(server.server.sendResourceUpdated).toHaveBeenCalledOnce();
    });

    it('drops the signal silently when no set is active (EC-11 stale-rep policy)', () => {
      // No set started — this models a rep boundary arriving after endSet.
      client.fire.repBoundary();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });

    it('drops the signal after live.endSet() — stale rep after endSet (EC-11)', () => {
      startSet(live);
      live.endSet();
      client.fire.repBoundary();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('onSetBoundary', () => {
    it('is subscribed but takes no structural action and emits no resource update', () => {
      startSet(live);
      const before = live.snapshotSet();
      client.fire.setBoundary();
      expect(live.snapshotSet()).toEqual(before);
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
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
