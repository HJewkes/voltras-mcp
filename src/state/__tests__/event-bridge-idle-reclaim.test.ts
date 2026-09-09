// Unit tests for VW-185 — reconciling an auto-arm reclaim with the idle
// reporting already on the wire.
//
// Auto-arm waits for a second closed rep before it fires, so the rep it
// adopts may already have been counted by a flushed `idle_rep_summary`. The
// batch decrement that withdraws a still-pending rep would drive the counter
// below the reps it actually holds in that case, and the next window would
// under-report. A published rep is corrected with `idle_rep_reclaimed`
// instead.
//
// Frame phase values mirror the SDK's `MovementPhase` enum (numeric):
//   0 = IDLE, 1 = CONCENTRIC, 3 = ECCENTRIC. A rep closes when the NEXT rep's
// first concentric frame arrives, so every case below drives the two halves
// of a rep separately to place the 5s window flush between them.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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

interface PublishedEvent {
  content: string;
  meta: Record<string, string>;
}

interface FakeChannels {
  publish: Mock<(event: PublishedEvent) => void>;
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

function makeHarness() {
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
    config: { autoArm: 'on' },
  };
  wireBridgeForSlot(
    state as unknown as Parameters<typeof wireBridgeForSlot>[0],
    slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
  );
  return { live, client, channels, state };
}

// Device-native frame units: position in mm of cable extension, velocity in
// mm/s. The bridge converts both once (VW-160 / WA 2.0.0), so a 500 mm /
// 850 mm/s rep reaches the eligibility rule as 0.5 m at 0.85 m/s — the
// 2026-09-07 working-rep shape. The positioning pull ran twice the cable at
// twice the speed, and disagrees with a working rep.
const WORKING_SHAPE = { romMm: 500, velocityMms: 850 };
const PULL_SHAPE = { romMm: 1000, velocityMms: 1600 };

const SAMPLES_PER_PHASE = 3;

type Shape = { romMm: number; velocityMms: number };

function feedFrame(
  client: FakeClient,
  seq: number,
  phase: number,
  positionMm: number,
  velocityMms: number,
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

/** Concentric half of a rep — opens it, and CLOSES the rep before it. */
function feedConcentric(client: FakeClient, startSeq: number, shape: Shape): number {
  const step = shape.romMm / (SAMPLES_PER_PHASE - 1);
  for (let i = 0; i < SAMPLES_PER_PHASE; i++) {
    feedFrame(client, startSeq + i, 1, step * i, shape.velocityMms);
  }
  return startSeq + SAMPLES_PER_PHASE;
}

/** Eccentric half of a rep — the return to the start position. */
function feedEccentric(client: FakeClient, startSeq: number, shape: Shape): number {
  const step = shape.romMm / (SAMPLES_PER_PHASE - 1);
  for (let i = 0; i < SAMPLES_PER_PHASE; i++) {
    feedFrame(client, startSeq + i, 3, shape.romMm - step * i, shape.velocityMms * 0.6);
  }
  return startSeq + SAMPLES_PER_PHASE;
}

function eventsOfType(channels: FakeChannels, type: string): PublishedEvent[] {
  return channels.publish.mock.calls.map((c) => c[0]).filter((e) => e.meta.event_type === type);
}

const WINDOW_MS = 5_000;

describe('auto-arm reclaim vs a published idle_rep_summary (VW-185)', () => {
  let h: ReturnType<typeof makeHarness>;
  let seq: number;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeHarness();
    seq = 1;
    h.live.startSession({
      sessionId: 'sess-reclaim',
      startedAt: '2026-09-08T00:00:00.000Z',
      setIds: [],
      status: 'active',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Perform a rep and leave it open; it closes on the next concentric. */
  function performRep(shape: Shape = WORKING_SHAPE): void {
    seq = feedConcentric(h.client, seq, shape);
    seq = feedEccentric(h.client, seq, shape);
  }

  /** The concentric that closes the rep before it (and opens the next one). */
  function closeRep(shape: Shape = WORKING_SHAPE): void {
    seq = feedConcentric(h.client, seq, shape);
  }

  it('publishes idle_rep_reclaimed when the summary already went out', () => {
    performRep();
    closeRep(); // first rep closes: reported as idle, batch = 1
    vi.advanceTimersByTime(WINDOW_MS); // summary of 1 goes out
    feedEccentric(h.client, seq, WORKING_SHAPE);
    seq += SAMPLES_PER_PHASE;
    closeRep(); // second rep closes: the arm adopts both

    expect(eventsOfType(h.channels, 'idle_rep_summary')).toHaveLength(1);
    const reclaimed = eventsOfType(h.channels, 'idle_rep_reclaimed');
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].meta.count).toBe('1');
    expect(reclaimed[0].meta.set_id).toBe(h.live.set?.setId);
    expect(h.live.idleRepCount).toBe(0);
  });

  it('carries the same envelope as every other push', () => {
    performRep();
    closeRep();
    vi.advanceTimersByTime(WINDOW_MS);
    feedEccentric(h.client, seq, WORKING_SHAPE);
    seq += SAMPLES_PER_PHASE;
    closeRep();

    const reclaimed = eventsOfType(h.channels, 'idle_rep_reclaimed')[0];
    expect(reclaimed.meta.source).toBe('voltras');
    expect(reclaimed.meta.slot).toBe('primary');
    const body = JSON.parse(reclaimed.content) as {
      summary: string;
      idle_rep_reclaimed: { count: number; set_id: string; slot: string };
      idle_rep_count: number;
    };
    expect(Object.keys(body)[0]).toBe('summary');
    expect(body.idle_rep_reclaimed).toEqual({
      count: 1,
      set_id: h.live.set?.setId,
      slot: 'primary',
    });
    expect(body.idle_rep_count).toBe(0);
  });

  it('never lets the pending batch go negative after a published reclaim', () => {
    performRep();
    closeRep();
    vi.advanceTimersByTime(WINDOW_MS);
    feedEccentric(h.client, seq, WORKING_SHAPE);
    seq += SAMPLES_PER_PHASE;
    closeRep(); // arms; the reclaimed rep was already published
    h.live.endSet();

    // A negative batch would swallow this rep instead of reporting it.
    performRep();
    closeRep();
    vi.advanceTimersByTime(WINDOW_MS);

    const summaries = eventsOfType(h.channels, 'idle_rep_summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[1].meta.count).toBe('1');
  });

  it('decrements the batch and stays silent when the arm lands inside the window', () => {
    performRep();
    closeRep();
    performRep();
    closeRep(); // arms within the same 5s window

    vi.advanceTimersByTime(WINDOW_MS);

    expect(eventsOfType(h.channels, 'idle_rep_summary')).toHaveLength(0);
    expect(eventsOfType(h.channels, 'idle_rep_reclaimed')).toHaveLength(0);
    expect(h.live.set).toBeDefined();
    expect(h.live.idleRepCount).toBe(0);
  });

  // A single arm reclaims at most one ledger entry, so published and pending
  // reps cannot both be reclaimed at once. They CAN sit in the ledger
  // together: a positioning pull is left behind by the arm it did not
  // corroborate, and is still published, while the next set's idle rep is
  // pending. The reclaim has to read the entry it drops, not the ledger.
  it('reclaims a pending rep while a published one stays counted', () => {
    performRep(PULL_SHAPE);
    closeRep(WORKING_SHAPE); // the pull closes; it is reported as idle
    vi.advanceTimersByTime(WINDOW_MS); // ...and published
    feedEccentric(h.client, seq, WORKING_SHAPE);
    seq += SAMPLES_PER_PHASE;
    closeRep(); // arms on the working pair; the pull is not adopted
    h.live.endSet();

    performRep();
    closeRep(); // a fresh idle rep, still pending
    performRep();
    closeRep(); // arms and reclaims it
    vi.advanceTimersByTime(WINDOW_MS);

    expect(eventsOfType(h.channels, 'idle_rep_reclaimed')).toHaveLength(0);
    expect(eventsOfType(h.channels, 'idle_rep_summary')).toHaveLength(1);
    // The pull, already reported, is the only thing left in the ledger.
    expect(h.live.idleReps).toHaveLength(1);
    expect(h.live.idleRepCount).toBe(1);
  });
});

describe('auto-arm reclaim in verbose mode (VW-185)', () => {
  let h: ReturnType<typeof makeHarness>;
  let seq: number;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeHarness();
    seq = 1;
    h.live.startSession({
      sessionId: 'sess-verbose',
      startedAt: '2026-09-08T00:00:00.000Z',
      setIds: [],
      status: 'active',
      verboseIdleReps: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Verbose mode publishes each idle rep the moment it closes, so there is no
  // batch to withdraw from and the correcting event is the only signal.
  it('corrects the per-occurrence idle_rep it already published', () => {
    seq = feedConcentric(h.client, seq, WORKING_SHAPE);
    seq = feedEccentric(h.client, seq, WORKING_SHAPE);
    seq = feedConcentric(h.client, seq, WORKING_SHAPE); // first rep closes
    seq = feedEccentric(h.client, seq, WORKING_SHAPE);
    seq = feedConcentric(h.client, seq, WORKING_SHAPE); // second closes, arms

    expect(eventsOfType(h.channels, 'idle_rep')).toHaveLength(1);
    const reclaimed = eventsOfType(h.channels, 'idle_rep_reclaimed');
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].meta.count).toBe('1');
    expect(reclaimed[0].meta.set_id).toBe(h.live.set?.setId);

    vi.advanceTimersByTime(WINDOW_MS);
    expect(eventsOfType(h.channels, 'idle_rep_summary')).toHaveLength(0);
  });
});
