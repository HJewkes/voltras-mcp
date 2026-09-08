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

function feedFrame(
  client: FakeClient,
  seq: number,
  phase: number,
  positionMm = 0.1 * seq,
  velocityMms = 500,
): void {
  client.fire.frame({
    sequence: seq,
    timestamp: 1000 + seq * 100,
    phase,
    position: positionMm,
    velocity: velocityMms,
    force: 50,
  });
}

/** Feed a C→E→C cycle, which closes exactly one rep in whichever pipeline is live. */
function feedRepCycle(client: FakeClient, startSeq: number): void {
  feedFrame(client, startSeq, 1);
  feedFrame(client, startSeq + 1, 3);
  feedFrame(client, startSeq + 2, 1);
}

// Frame units are device-native: position in mm of cable extension, velocity in
// mm/s. The bridge converts both once (VW-160 / WA 2.0.0), so a 500 mm / 850
// mm/s rep reaches the eligibility rule as 0.5 m at 0.85 m/s — the 2026-09-07
// working-rep shape. The pull ran twice the cable at twice the speed.
const WORKING_SHAPE = { romMm: 500, velocityMms: 850 };
const PULL_SHAPE = { romMm: 1000, velocityMms: 1600 };

const SAMPLES_PER_PHASE = 3;

/**
 * Feed one complete rep (concentric out, eccentric back) and return the next
 * free sequence number. The rep does not CLOSE until the following rep's first
 * concentric sample arrives — that is the boundary the idle pipeline reports.
 */
function feedShapedRep(
  client: FakeClient,
  startSeq: number,
  shape: { romMm: number; velocityMms: number },
): number {
  const step = shape.romMm / (SAMPLES_PER_PHASE - 1);
  for (let i = 0; i < SAMPLES_PER_PHASE; i++) {
    feedFrame(client, startSeq + i, 1, step * i, shape.velocityMms);
  }
  for (let i = 0; i < SAMPLES_PER_PHASE; i++) {
    feedFrame(
      client,
      startSeq + SAMPLES_PER_PHASE + i,
      3,
      shape.romMm - step * i,
      shape.velocityMms * 0.6,
    );
  }
  return startSeq + SAMPLES_PER_PHASE * 2;
}

function startSession(live: LiveStateT): void {
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-09-07T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
}

describe('auto-arm on the lifter’s idle reps (VW-164)', () => {
  let h: ReturnType<typeof makeHarness>;

  /** Two working reps, then the frame that closes the second one and arms. */
  function feedTwoWorkingReps(): void {
    const next = feedShapedRep(h.client, 1, WORKING_SHAPE);
    const after = feedShapedRep(h.client, next, WORKING_SHAPE);
    feedFrame(h.client, after, 1, 0, WORKING_SHAPE.velocityMms);
  }

  beforeEach(() => {
    h = makeHarness();
  });

  it('opens a set and counts both performed reps into it', () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 170, trainingMode: 'Weight Training' });

    feedTwoWorkingReps();

    expect(h.live.set).toBeDefined();
    expect(h.live.set?.autoCreatedBy).toBe('idle_rep');
    // Both performed reps plus the in-progress one belong to the set, and
    // neither is left claimed by the idle ledger.
    expect(h.live.set!.reps.length).toBe(3);
    expect(h.live.idleRepCount).toBe(0);
    expect(h.live.idleReps).toEqual([]);
  });

  it('publishes set_started with the auto_armed marker and the current weight', () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 170, trainingMode: 'Weight Training' });

    feedTwoWorkingReps();

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

    feedTwoWorkingReps();

    const setId = h.live.set!.setId;
    expect(h.state.setStartDeviceSnapshots.get(setId)).toMatchObject({ weightLbs: 170 });
  });

  it('continues to count reps into the auto-armed set', () => {
    startSession(h.live);
    feedTwoWorkingReps();
    const setId = h.live.set!.setId;
    const afterArm = h.live.set!.reps.length;

    feedFrame(h.client, 40, 3);
    feedFrame(h.client, 41, 1);

    expect(h.live.set!.setId).toBe(setId);
    expect(h.live.set!.reps.length).toBeGreaterThan(afterArm);
  });

  it('holds off on the first closed rep — one rep says nothing about itself', () => {
    startSession(h.live);

    const next = feedShapedRep(h.client, 1, WORKING_SHAPE);
    feedFrame(h.client, next, 1, 0, WORKING_SHAPE.velocityMms);

    expect(h.live.set).toBeUndefined();
    expect(h.live.idleRepCount).toBe(1);
  });

  it('reports idle reps as before when no session is open', () => {
    feedRepCycle(h.client, 1);

    expect(h.live.set).toBeUndefined();
    expect(h.live.idleRepCount).toBe(1);
  });

  it('reports idle reps as before when auto-arm is off', () => {
    h = makeHarness({ autoArm: 'off' });
    startSession(h.live);

    feedTwoWorkingReps();

    expect(h.live.set).toBeUndefined();
    expect(h.live.idleRepCount).toBe(2);
  });
});

describe('a rope-positioning pull does not arm the set (VW-181)', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 40, trainingMode: 'Weight Training' });
  });

  /** The 2026-09-07 shape: a positioning pull, then the lifter's first rep. */
  function feedPullThenWorkingRep(): void {
    const next = feedShapedRep(h.client, 1, PULL_SHAPE);
    const after = feedShapedRep(h.client, next, WORKING_SHAPE);
    feedFrame(h.client, after, 1, 0, WORKING_SHAPE.velocityMms);
  }

  it('arms on the working rep and leaves the pull out of the set', () => {
    feedPullThenWorkingRep();

    expect(h.live.set).toBeDefined();
    // The working rep and the in-progress rep behind it — not the pull.
    expect(h.live.set!.reps).toHaveLength(2);
    const firstRom = h.live.set!.reps[0].concentric.endPosition;
    expect(firstRom).toBeCloseTo(WORKING_SHAPE.romMm / 1000, 3);
  });

  it('still reports the pull as an idle rep, so nothing is lost', () => {
    feedPullThenWorkingRep();

    expect(h.live.idleRepCount).toBe(1);
    expect(h.live.idleReps).toHaveLength(1);
  });

  it('does not cancel the rest timer on the pull', () => {
    const cancel = vi.spyOn(h.state.restTimers, 'cancel');

    const next = feedShapedRep(h.client, 1, PULL_SHAPE);
    feedFrame(h.client, next, 1, 0, WORKING_SHAPE.velocityMms); // closes the pull

    expect(cancel).not.toHaveBeenCalled();

    // The rest timer is cancelled only once a real rep actually arms the set.
    const after = feedShapedRep(h.client, next + 1, WORKING_SHAPE);
    feedFrame(h.client, after, 1, 0, WORKING_SHAPE.velocityMms);

    expect(h.live.set).toBeDefined();
    expect(cancel).toHaveBeenCalledWith('primary', 'next_set');
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
