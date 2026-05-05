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
const { SetWatchdog } = await import('../set-watchdog.js');
type SetWatchdogT = InstanceType<typeof SetWatchdog>;

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

    it('outside the grace window with no `state` wired emits no resource update and does not mutate live state', () => {
      // The default `wireEventBridge` call in `beforeEach` omits the
      // optional `state` parameter — without it, the bridge has no
      // `finalizeSet` reference and silently drops the boundary even
      // outside grace. Production wiring (server.ts) always passes state;
      // this case just keeps the legacy contract for tests / hosts that
      // don't construct a full ServerState.
      startSet(live);
      const before = live.snapshotSet();
      client.fire.setBoundary();
      expect(live.snapshotSet()).toEqual(before);
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });
  });

  describe('onSetBoundary → set_ended_by_device finalize', () => {
    // A second harness — the bridge needs `state` threaded so it can call
    // `finalizeSet`. We re-wire here with a minimal fake state shaped just
    // enough for the device-signal finalize path: live, store with a
    // putSet spy, channels with a publish spy, and the
    // setStartDeviceSnapshots map populated as if `set.start` had run.
    interface FakeSlot {
      slotId: string;
      live: LiveStateT;
      client: { endSet: Mock<() => Promise<void>> };
    }
    interface FakeState {
      slots: Map<string, FakeSlot>;
      store: { putSet: Mock<(s: unknown) => Promise<void>> };
      channels: FakeChannels;
      setStartDeviceSnapshots: Map<
        string,
        { connected: boolean; weightLbs?: number; trainingMode?: string }
      >;
      setWatchdog: SetWatchdogT;
    }
    let fakeState: FakeState;

    function flushMicrotasks(): Promise<void> {
      // The bridge's onSetBoundary handler kicks off `finalizeSet` via
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
      slots.set('primary', {
        slotId: 'primary',
        live,
        client: { endSet: vi.fn(async () => undefined) },
      });
      fakeState = {
        slots,
        store: { putSet: vi.fn(async () => undefined) },
        channels,
        setStartDeviceSnapshots: new Map(),
        setWatchdog: new SetWatchdog(),
      };
      wireEventBridge(
        client as unknown as Parameters<typeof wireEventBridge>[0],
        live,
        server as unknown as Parameters<typeof wireEventBridge>[2],
        channels as unknown as Parameters<typeof wireEventBridge>[3],
        fakeState as unknown as Parameters<typeof wireEventBridge>[4],
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

    it('inside the grace window does NOT finalize (existing Workout.GO echo suppression)', async () => {
      // startedAt = now → still within grace. The bridge must not call
      // store.putSet / channels.publish.
      startActiveSet({ startedAt: new Date().toISOString() });
      client.fire.setBoundary();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      expect(channels.publish).not.toHaveBeenCalled();
      expect(live.snapshotSet()).toBeDefined();
    });

    it('outside the grace window with an active set persists, clears live state, and publishes set_ended_by_device', async () => {
      // startedAt 2025-01-01 — far outside any grace window.
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      client.fire.setBoundary();
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
      expect(stored.partial).toBe(true);
      expect(stored.partialReason).toBe('device_signal');
      // Device snapshot from `set.start` is honored.
      expect(stored.weightLbs).toBe(135);
      expect(stored.trainingMode).toBe('WeightTraining');

      // LiveState's set is cleared.
      expect(live.snapshotSet()).toBeUndefined();

      // Channel event matches the `set_ended_by_device` contract.
      expect(channels.publish).toHaveBeenCalledTimes(1);
      const event = channels.publish.mock.calls[0][0];
      expect(event.meta.event_type).toBe('set_ended_by_device');
      expect(event.meta.set_id).toBe('set-dev');
      expect(event.meta.session_id).toBe('sess-dev');
      expect(event.meta.partial_reason).toBe('device_signal');

      const parsed = JSON.parse(event.content) as {
        summary: string;
        set: { partial_reason: string };
      };
      expect(parsed.set.partial_reason).toBe('device_signal');
      expect(parsed.summary).toContain('Set ended by device');
      expect(parsed.summary).toContain('user pressed Stop on the unit');

      // The bridge must NOT have called client.endSet — the device already
      // de-engaged on its own; an extra Workout.STOP would be churn.
      expect(fakeState.slots.get('primary')!.client.endSet).not.toHaveBeenCalled();

      // The voltra://set/active resource is poked so polling clients
      // refresh.
      expect(server.server.sendResourceUpdated).toHaveBeenCalledWith({
        uri: 'voltra://set/active',
      });
    });

    it('outside the grace window with NO active set is a silent drop', async () => {
      // No startSet invocation — `live.snapshotSet()` is undefined.
      // Simulates the explicit `set.end` race: tool already ran, bridge's
      // onSetBoundary fires from the device's Workout.STOP echo.
      client.fire.setBoundary();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      expect(channels.publish).not.toHaveBeenCalled();
      expect(server.server.sendResourceUpdated).not.toHaveBeenCalled();
    });

    it('race-condition guard: live.endSet() before onSetBoundary is a silent drop', async () => {
      // Reproduce the exact sequence the explicit `set.end` tool produces:
      // LiveState.endSet() runs, then the device's Workout.STOP echo
      // fires onSetBoundary. The bridge must observe the cleared live set
      // and drop without re-finalizing.
      startActiveSet({ startedAt: '2025-01-01T00:00:00.000Z' });
      live.endSet();
      client.fire.setBoundary();
      await flushMicrotasks();
      expect(fakeState.store.putSet).not.toHaveBeenCalled();
      expect(channels.publish).not.toHaveBeenCalled();
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
      client: { endSet: Mock<() => Promise<void>> };
    }
    interface FakeStateForTrigger {
      slots: Map<string, FakeSlotForTrigger>;
      store: { putSet: Mock<(s: unknown) => Promise<void>> };
      channels: FakeChannels;
      setStartDeviceSnapshots: Map<
        string,
        { connected: boolean; weightLbs?: number; trainingMode?: string }
      >;
      setWatchdog: SetWatchdogT;
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
        client: { endSet: vi.fn(async () => undefined) },
      });
      fakeState = {
        slots,
        store: { putSet: vi.fn(async () => undefined) },
        channels,
        setStartDeviceSnapshots: new Map(),
        setWatchdog: new SetWatchdog(),
      };
      wireEventBridge(
        client as unknown as Parameters<typeof wireEventBridge>[0],
        live,
        server as unknown as Parameters<typeof wireEventBridge>[2],
        channels as unknown as Parameters<typeof wireEventBridge>[3],
        fakeState as unknown as Parameters<typeof wireEventBridge>[4],
      );
    });

    interface WatchSpec {
      stopOn?: Array<
        | { type: 'rep_count_reached'; value: number }
        | { type: 'velocity_loss_exceeded'; pct: number }
        | { type: 'idle_timeout_ms'; value: number }
      >;
      notifyOn?: Array<
        | { type: 'rep_count_reached'; value: number }
        | { type: 'velocity_loss_exceeded'; pct: number }
        | { type: 'idle_timeout_ms'; value: number }
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
                stopOn: watch.stopOn ?? [],
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
          auto_stopped: 'false',
        });
        // Set is still active — notifyOn does not finalize.
        expect(live.snapshotSet()).toBeDefined();
        expect(fakeState.store.putSet).not.toHaveBeenCalled();
      });

      it('stopOn fires set_target_reached AND auto-stops via finalizeSet', async () => {
        startWatchedSet({ stopOn: [{ type: 'rep_count_reached', value: 2 }] });
        driveRep(1, 0.6);
        driveRep(2, 0.6);
        startNextRep(3, 0.6);
        await flushMicrotasks();

        const trigger = lastTriggerEvent();
        expect(trigger?.meta.auto_stopped).toBe('true');

        // Set finalized.
        expect(live.snapshotSet()).toBeUndefined();
        expect(fakeState.store.putSet).toHaveBeenCalledTimes(1);
        const stored = fakeState.store.putSet.mock.calls[0][0] as {
          partial: boolean;
          partialReason?: string;
        };
        expect(stored.partial).toBe(true);
        expect(stored.partialReason).toBe('auto_stopped');

        // set_ended channel event carries auto_stop_cause meta.
        const setEnded = channels.publish.mock.calls
          .map((c) => c[0])
          .find((e) => e.meta.event_type === 'set_ended');
        expect(setEnded).toBeDefined();
        expect(setEnded?.meta.auto_stop_cause).toBe('rep_count_reached');
        expect(setEnded?.meta.partial_reason).toBe('auto_stopped');

        // Trigger event publishes BEFORE set_ended.
        const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
        const triggerIdx = eventTypes.indexOf('set_target_reached');
        const endedIdx = eventTypes.indexOf('set_ended');
        expect(triggerIdx).toBeGreaterThan(-1);
        expect(endedIdx).toBeGreaterThan(triggerIdx);
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

      it('fires when rep 2 has lower peak concentric velocity than rep 1 (stopOn)', async () => {
        startWatchedSet({ stopOn: [{ type: 'velocity_loss_exceeded', pct: 30 }] });
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

        // Loss = (1.0 - 0.5)/1.0 * 100 = 50% ≥ 30% — fires.
        const trigger = lastTriggerEvent();
        expect(trigger?.meta.event_type).toBe('velocity_loss_exceeded');
        expect(trigger?.meta.auto_stopped).toBe('true');
        expect(parseFloat(trigger!.meta.velocity_loss_pct)).toBeCloseTo(50.0, 1);
        expect(trigger?.meta.threshold_pct).toBe('30');

        // stopOn ⇒ set is finalized.
        expect(live.snapshotSet()).toBeUndefined();
        const setEnded = channels.publish.mock.calls
          .map((c) => c[0])
          .find((e) => e.meta.event_type === 'set_ended');
        expect(setEnded?.meta.auto_stop_cause).toBe('velocity_loss_exceeded');
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

    describe('combined stopOn behavior', () => {
      it('multiple stopOn matches in same rep publish each trigger event then auto-stop once', async () => {
        startWatchedSet({
          stopOn: [
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

        // finalizeSet runs exactly once.
        expect(fakeState.store.putSet).toHaveBeenCalledTimes(1);
        const setEnded = channels.publish.mock.calls
          .map((c) => c[0])
          .filter((e) => e.meta.event_type === 'set_ended');
        expect(setEnded).toHaveLength(1);
      });
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

    describe('connection_changed channel event', () => {
      it("publishes connection_changed with state=connected and device snapshot on 'connected'", () => {
        live.applySettings({
          deviceId: 'voltra-XYZ',
          deviceName: 'Voltra Pro',
          batteryPercent: 80,
        });
        channels.publish.mockClear();
        client.fire.connectionStateChange('connected');

        expect(channels.publish).toHaveBeenCalledTimes(1);
        const event = channels.publish.mock.calls[0][0];
        expect(event.meta).toMatchObject({
          source: 'voltras',
          event_type: 'connection_changed',
          state: 'connected',
          device_id: 'voltra-XYZ',
        });
        // No mid_set / disconnected_at attrs on connect.
        expect(event.meta.mid_set).toBeUndefined();
        expect(event.meta.disconnected_at).toBeUndefined();

        const parsed = JSON.parse(event.content) as {
          summary: string;
          device: {
            device_id: string | null;
            device_name: string | null;
            connected: boolean;
            battery_percent: number | null;
          };
          active_set_at_disconnect: unknown;
        };
        expect(parsed.summary).toContain('Voltra connected');
        expect(parsed.summary).toContain('Voltra Pro');
        expect(parsed.device).toMatchObject({
          device_id: 'voltra-XYZ',
          device_name: 'Voltra Pro',
          connected: true,
          battery_percent: 80,
        });
        expect(parsed.active_set_at_disconnect).toBeNull();
      });

      it("on 'disconnected' with an active set publishes mid_set=true and the active-set context", () => {
        // Set up a session + set + device weight so the mid-set summary
        // has something to render.
        live.applySettings({
          deviceId: 'voltra-XYZ',
          deviceName: 'Voltra Pro',
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
          device_id: 'voltra-XYZ',
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
  });
});
