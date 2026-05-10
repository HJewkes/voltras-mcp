// Unit tests for idle-rep surfacing in the event-bridge.
//
// Covers the case where the user completes a rep while no MCP set is armed —
// i.e., between a `set.end` and the next `set.start`, or before the very
// first `set.start` of a session. Prior to this feature, such reps were
// silently dropped; now they are captured in `LiveState.idleReps` / `idleRepCount`
// and published as `idle_rep` channel events.
//
// Frame phase values mirror the SDK's `MovementPhase` enum (numeric):
//   0 = IDLE, 1 = CONCENTRIC, 3 = ECCENTRIC.
// Rep boundary detection (via workout-analytics `addSampleToSet`):
//   ECC → CONC transition closes the previous rep and opens a new one.
//   The bridge's idle pipeline is structurally identical to the active-set
//   pipeline — the rep at index N-2 is "done" when the array grows from N-1
//   to N (i.e. `nextCount >= 2`).

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

function makeFakeServer() {
  return {
    server: {
      sendResourceUpdated: vi.fn(() => Promise.resolve()),
    },
  };
}

function makeFakeClient() {
  let frameCb: (frame: unknown) => void = () => undefined;
  const onFrame = vi.fn((l: (f: unknown) => void) => {
    frameCb = l;
    return () => undefined;
  });
  return {
    onFrame,
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

function makeBareState(opts: {
  client: FakeClient;
  live: LiveStateT;
  server: ReturnType<typeof makeFakeServer>;
  channels: FakeChannels;
}) {
  const slots = new Map<string, unknown>();
  slots.set('primary', {
    slotId: 'primary',
    client: opts.client,
    live: opts.live,
    modeRevertGuard: new ModeRevertGuard(),
  });
  return { slots, channels: opts.channels, server: opts.server, setWatchdog: new SetWatchdog() };
}

/** Feed a single frame directly into the wired client. Phase values: 0=IDLE, 1=CONC, 3=ECC. */
function feedFrame(client: FakeClient, seq: number, phase: number, velocity = 0.5): void {
  client.fire.frame({
    sequence: seq,
    timestamp: 1000 + seq,
    phase,
    position: 0.1 * seq,
    velocity,
    force: 50,
  });
}

/** Feed a complete C→E→C cycle that produces one idle rep boundary. */
function feedIdleRepCycle(client: FakeClient, startSeq: number): void {
  // First rep: C frames then E frames
  feedFrame(client, startSeq, 1); // CONC — opens rep 1
  feedFrame(client, startSeq + 1, 3); // ECC
  // Second C frame closes rep 1 and opens rep 2
  feedFrame(client, startSeq + 2, 1); // CONC — boundary: rep 1 closed
}

describe('idle-rep surfacing', () => {
  let live: LiveStateT;
  let client: FakeClient;
  let server: ReturnType<typeof makeFakeServer>;
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

  describe('single idle rep when no set is active', () => {
    it('increments idleRepCount by 1', () => {
      expect(live.idleRepCount).toBe(0);
      feedIdleRepCycle(client, 1);
      expect(live.idleRepCount).toBe(1);
    });

    it('appends one entry to idleReps', () => {
      feedIdleRepCycle(client, 1);
      expect(live.idleReps.length).toBe(1);
    });

    it('publishes an idle_rep channel event with correct meta', () => {
      feedIdleRepCycle(client, 1);
      expect(channels.publish).toHaveBeenCalledTimes(1);
      const event = channels.publish.mock.calls[0][0];
      expect(event.meta.event_type).toBe('idle_rep');
      expect(event.meta.idle_rep_count).toBe('1');
      expect(event.meta.slot).toBe('primary');
    });

    it('channel event content is valid JSON with summary, idle_rep, and idle_rep_count', () => {
      feedIdleRepCycle(client, 1);
      const event = channels.publish.mock.calls[0][0];
      const body = JSON.parse(event.content) as {
        summary: string;
        idle_rep: { ts: number; v_con: number | null; rom: number | null; slot: string };
        idle_rep_count: number;
      };
      expect(typeof body.summary).toBe('string');
      expect(body.idle_rep.slot).toBe('primary');
      expect(body.idle_rep_count).toBe(1);
    });

    it('captures velocity from concentric phase when frames have velocity', () => {
      feedIdleRepCycle(client, 1);
      const entry = live.idleReps[0];
      // velocity=0.5 in every frame, so mean concentric velocity > 0
      expect(entry.vCon).toBeGreaterThan(0);
    });
  });

  describe('multiple idle reps accumulate', () => {
    it('three idle rep cycles → idleRepCount=3, idleReps has 3 entries', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      feedIdleRepCycle(client, 20);
      expect(live.idleRepCount).toBe(3);
      expect(live.idleReps.length).toBe(3);
    });

    it('three idle reps → three idle_rep channel events published', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      feedIdleRepCycle(client, 20);
      const idleEvents = channels.publish.mock.calls.filter(
        (c) => c[0].meta.event_type === 'idle_rep',
      );
      expect(idleEvents.length).toBe(3);
    });

    it('idle_rep_count in successive events increments correctly', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      feedIdleRepCycle(client, 20);
      const counts = channels.publish.mock.calls
        .filter((c) => c[0].meta.event_type === 'idle_rep')
        .map((c) => c[0].meta.idle_rep_count);
      expect(counts).toEqual(['1', '2', '3']);
    });

    it('entries arrive in arrival order', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      feedIdleRepCycle(client, 20);
      // Each cycle starts at a higher seq → higher ts (frames use 1000+seq).
      // All three entries should have non-decreasing timestamps.
      const tss = live.idleReps.map((r) => r.ts);
      expect(tss[0]).toBeLessThanOrEqual(tss[1]);
      expect(tss[1]).toBeLessThanOrEqual(tss[2]);
    });
  });

  describe('active-set path is unaffected', () => {
    function startSet(): void {
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

    it('rep boundary while set IS active does not increment idleRepCount', () => {
      startSet();
      // Feed a full cycle — should go to active-set pipeline, not idle pipeline.
      feedFrame(client, 1, 1);
      feedFrame(client, 2, 3);
      feedFrame(client, 3, 1); // boundary: rep 1 closed in active set
      expect(live.idleRepCount).toBe(0);
    });

    it('rep boundary while set IS active does not append to idleReps', () => {
      startSet();
      feedFrame(client, 1, 1);
      feedFrame(client, 2, 3);
      feedFrame(client, 3, 1);
      expect(live.idleReps.length).toBe(0);
    });

    it('rep boundary while set IS active publishes rep_finalized, not idle_rep', () => {
      startSet();
      feedFrame(client, 1, 1);
      feedFrame(client, 2, 3);
      feedFrame(client, 3, 1);
      const eventTypes = channels.publish.mock.calls.map((c) => c[0].meta.event_type);
      expect(eventTypes).not.toContain('idle_rep');
      expect(eventTypes).toContain('rep_finalized');
    });
  });

  describe('buffer cap enforcement', () => {
    it('21 idle reps → idleReps has 20 entries (oldest dropped), idleRepCount is 21', () => {
      // Each cycle is 3 frames; use non-overlapping seq ranges.
      for (let i = 0; i < 21; i++) {
        feedIdleRepCycle(client, i * 10);
      }
      expect(live.idleRepCount).toBe(21);
      expect(live.idleReps.length).toBe(20);
    });

    it('after 21 idle reps, newest entry is the 21st, oldest was evicted', () => {
      // Mock Date.now to return incrementing values so we can identify entries.
      let tick = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => tick++);

      for (let i = 0; i < 21; i++) {
        feedIdleRepCycle(client, i * 10);
      }

      vi.restoreAllMocks();
      // The ring holds the 20 most recent entries; the very first rep was evicted.
      // First remaining entry's ts > initial value — the oldest is gone.
      expect(live.idleRepCount).toBe(21);
      expect(live.idleReps.length).toBe(20);
      // After eviction the 20 entries remaining are not the first rep (ts=1000).
      // Since tick increments once per recordIdleRep call, rep 1's ts=1000 was dropped.
      expect(live.idleReps[0].ts).toBeGreaterThan(1000);
    });
  });

  describe('session.start clears idle state', () => {
    it('idleRepCount resets to 0 after clearIdleReps()', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      expect(live.idleRepCount).toBe(2);
      live.clearIdleReps();
      expect(live.idleRepCount).toBe(0);
    });

    it('idleReps array is emptied after clearIdleReps()', () => {
      feedIdleRepCycle(client, 1);
      feedIdleRepCycle(client, 10);
      expect(live.idleReps.length).toBe(2);
      live.clearIdleReps();
      expect(live.idleReps.length).toBe(0);
    });

    it('new idle reps accumulate fresh after clearIdleReps()', () => {
      feedIdleRepCycle(client, 1);
      live.clearIdleReps();
      feedIdleRepCycle(client, 10);
      expect(live.idleRepCount).toBe(1);
      expect(live.idleReps.length).toBe(1);
    });
  });
});
