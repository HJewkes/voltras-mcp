// Unit tests for auto-arm (VW-164) — the bridge opening a set on the first
// idle rep of an open session, and the inactivity safety net honouring a
// set's own `watch.inactivityTimeoutMs`.
//
// Frame phase values mirror the SDK's `MovementPhase` enum (numeric):
//   0 = IDLE, 1 = CONCENTRIC, 3 = ECCENTRIC. An ECC → CONC transition closes
// the previous rep, which is what triggers the arm.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

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
const { ModeRevertGuard } = await import('../mode-revert-guard.js');
const { CoercionWatch } = await import('../coercion-watch.js');
const { RestTimerRegistry } = await import('../rest-timer.js');

interface FakeChannels {
  publish: Mock<(event: { content: string; meta: Record<string, string> }) => void>;
  forSlot: Mock<(slotId: string) => FakeChannels>;
}

function makeFakeChannels(): FakeChannels {
  const channels = {
    publish: vi.fn() as FakeChannels['publish'],
    forSlot: vi.fn() as FakeChannels['forSlot'],
  } as FakeChannels;
  channels.forSlot.mockImplementation((slotId: string) => {
    const scoped: FakeChannels = {
      publish: vi.fn((event) => {
        channels.publish({ content: event.content, meta: { slot: slotId, ...event.meta } });
      }) as FakeChannels['publish'],
      forSlot: vi.fn(),
    };
    scoped.forSlot.mockImplementation((nextSlotId) => makeFakeChannels().forSlot(nextSlotId));
    return scoped;
  });
  return channels;
}

function makeFakeClient() {
  let frameCb: (frame: unknown) => void = () => undefined;
  return {
    onFrame: vi.fn((l: (f: unknown) => void) => {
      frameCb = l;
      return () => undefined;
    }),
    onPerRep: vi.fn(() => () => undefined),
    onInProgress: vi.fn(() => () => undefined),
    onSummary: vi.fn(() => () => undefined),
    onSetSummary: vi.fn(() => () => undefined),
    onSettingsUpdate: vi.fn(() => () => undefined),
    onConnectionStateChange: vi.fn(() => () => undefined),
    onStateDump: vi.fn(() => () => undefined),
    endSet: vi.fn(async () => undefined),
    settings: null,
    fire: {
      frame: (f: {
        sequence: number;
        timestamp: number;
        phase: number;
        position: number;
        velocity: number;
        force: number;
      }) => frameCb(f),
    },
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

function makeHarness(opts: { autoArm?: 'on' | 'off' } = {}) {
  const live: LiveStateT = new LiveState();
  const client = makeFakeClient();
  const channels = makeFakeChannels();
  const slots = new Map<string, unknown>();
  slots.set('primary', {
    slotId: 'primary',
    client,
    live,
    modeRevertGuard: new ModeRevertGuard(),
    coercionWatch: new CoercionWatch(),
  });
  const state = {
    slots,
    channels,
    server: { server: { sendResourceUpdated: vi.fn(() => Promise.resolve()) } },
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
    setStartDeviceSnapshots: new Map(),
    config: { autoArm: opts.autoArm ?? 'on' },
  };
  wireBridgeForSlot(
    state as unknown as Parameters<typeof wireBridgeForSlot>[0],
    slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
  );
  return { live, client, channels, state };
}

function feedFrame(client: FakeClient, seq: number, phase: number): void {
  client.fire.frame({
    sequence: seq,
    timestamp: 1000 + seq,
    phase,
    position: 0.1 * seq,
    velocity: 0.5,
    force: 50,
  });
}

/** Feed a C→E→C cycle, which closes exactly one rep in whichever pipeline is live. */
function feedRepCycle(client: FakeClient, startSeq: number): void {
  feedFrame(client, startSeq, 1);
  feedFrame(client, startSeq + 1, 3);
  feedFrame(client, startSeq + 2, 1);
}

function startSession(live: LiveStateT): void {
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-09-07T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
}

describe('auto-arm on the first idle rep (VW-164)', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it('opens a set and counts the triggering rep into it', () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 170, trainingMode: 'Weight Training' });

    feedRepCycle(h.client, 1);

    expect(h.live.set).toBeDefined();
    expect(h.live.set?.autoCreatedBy).toBe('idle_rep');
    // The rep that triggered the arm belongs to the set, not to the idle ledger.
    expect(h.live.set!.reps.length).toBeGreaterThanOrEqual(1);
    expect(h.live.idleRepCount).toBe(0);
    expect(h.live.idleReps).toEqual([]);
  });

  it('publishes set_started with the auto_armed marker and the current weight', () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 170, trainingMode: 'Weight Training' });

    feedRepCycle(h.client, 1);

    const started = h.channels.publish.mock.calls
      .map((c) => c[0])
      .find((e) => e.meta.event_type === 'set_started');
    expect(started).toBeDefined();
    expect(started!.meta.auto_armed).toBe('true');
    expect(started!.meta.weight_lbs).toBe('170');
    expect(JSON.parse(started!.content).set.auto_armed).toBe(true);
  });

  it('records the start device snapshot so the set persists a header weight', () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 170, trainingMode: 'Weight Training' });

    feedRepCycle(h.client, 1);

    const setId = h.live.set!.setId;
    expect(h.state.setStartDeviceSnapshots.get(setId)).toMatchObject({ weightLbs: 170 });
  });

  it('continues to count reps into the auto-armed set', () => {
    startSession(h.live);
    feedRepCycle(h.client, 1);
    const setId = h.live.set!.setId;
    const afterFirst = h.live.set!.reps.length;

    feedFrame(h.client, 10, 3);
    feedFrame(h.client, 11, 1);

    expect(h.live.set!.setId).toBe(setId);
    expect(h.live.set!.reps.length).toBeGreaterThan(afterFirst);
  });

  it('reports idle reps as before when no session is open', () => {
    feedRepCycle(h.client, 1);

    expect(h.live.set).toBeUndefined();
    expect(h.live.idleRepCount).toBe(1);
  });

  it('reports idle reps as before when auto-arm is off', () => {
    h = makeHarness({ autoArm: 'off' });
    startSession(h.live);

    feedRepCycle(h.client, 1);

    expect(h.live.set).toBeUndefined();
    expect(h.live.idleRepCount).toBe(1);
  });
});

describe('inactivity safety net honours the requested timeout (VW-164)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function armSet(live: LiveStateT, inactivityTimeoutMs?: number): void {
    startSession(live);
    live.startSet({
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
      reps: [],
      status: 'active',
      ...(inactivityTimeoutMs === undefined
        ? {}
        : { watch: { notifyOn: [], inactivityTimeoutMs } }),
    });
  }

  it('keeps a 300s set alive past the 90s default', () => {
    const h = makeHarness({ autoArm: 'off' });
    armSet(h.live, 300_000);

    vi.advanceTimersByTime(120_000);

    expect(h.live.set).toBeDefined();
    vi.useRealTimers();
  });

  it('still force-closes a set with no requested timeout at the 90s default', () => {
    const h = makeHarness({ autoArm: 'off' });
    armSet(h.live);

    vi.advanceTimersByTime(120_000);

    expect(h.live.set).toBeUndefined();
    vi.useRealTimers();
  });
});
