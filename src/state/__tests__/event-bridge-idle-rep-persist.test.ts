// Tests for durable idle-rep capture in the event-bridge (Wave 1-S).
//
// The bridge already detected idle reps, surfaced them on the channel, and
// dropped them. These cases cover the write that now happens alongside: the row
// carries the context that existed at detection and nothing more, and the live
// path is untouched by whatever the store does.
//
// Frame phase values mirror the SDK's numeric `MovementPhase`:
//   0 = IDLE, 1 = CONCENTRIC, 3 = ECCENTRIC. An ECC → CONC transition closes a
// rep, so a C/E/C triple produces exactly one idle-rep boundary.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { StoredIdleRep } from '../../store/types.js';

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

function makeFakeClient(connectedDeviceId: string | null) {
  let frameCb: (frame: unknown) => void = () => undefined;
  return {
    connectedDeviceId,
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

interface HarnessOpts {
  connectedDeviceId?: string | null;
  bindings?: Map<string, { physicalSide: 'left' | 'right' | null }>;
  putIdleRep?: Mock<(rep: StoredIdleRep) => Promise<void>>;
  omitStore?: boolean;
}

function makeHarness(opts: HarnessOpts = {}) {
  const live: LiveStateT = new LiveState();
  const client = makeFakeClient(opts.connectedDeviceId ?? null);
  const channels = makeFakeChannels();
  const putIdleRep = opts.putIdleRep ?? vi.fn(async () => undefined);
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
    slotBindings: opts.bindings,
    store: opts.omitStore === true ? undefined : { putIdleRep },
  };
  wireBridgeForSlot(
    state as unknown as Parameters<typeof wireBridgeForSlot>[0],
    slots.get('primary') as unknown as Parameters<typeof wireBridgeForSlot>[1],
  );
  return { live, client, channels, putIdleRep };
}

/** Feed a C→E→C cycle, which closes exactly one idle rep. */
function feedIdleRepCycle(client: FakeClient, startSeq: number): void {
  for (const [offset, phase] of [
    [0, 1],
    [1, 3],
    [2, 1],
  ] as const) {
    client.fire.frame({
      sequence: startSeq + offset,
      timestamp: 1000 + startSeq + offset,
      phase,
      position: 0.1 * (startSeq + offset),
      velocity: 0.5,
      force: 50,
    });
  }
}

describe('idle-rep durable capture', () => {
  it('persists a rep detected inside an active session with full context', async () => {
    const bindings = new Map([['AA:BB:CC', { physicalSide: 'right' as const }]]);
    const { live, client, putIdleRep } = makeHarness({
      connectedDeviceId: 'AA:BB:CC',
      bindings,
    });
    live.startSession({
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
    });
    live.applySettings({ weightLbs: 45 });

    feedIdleRepCycle(client, 1);

    expect(putIdleRep).toHaveBeenCalledTimes(1);
    const written = putIdleRep.mock.calls[0][0];
    expect(written.sessionId).toBe('sess-1');
    expect(written.slot).toBe('primary');
    expect(written.deviceId).toBe('AA:BB:CC');
    expect(written.side).toBe('right');
    expect(written.userId).toBe('local');
    expect(written.weightLbs).toBe(45);
    // The FULL rep, not the summarised ring entry.
    expect(written.rep?.concentric).toBeDefined();
    expect(written.rep?.eccentric).toBeDefined();
    expect(new Date(written.observedAt).toISOString()).toBe(written.observedAt);
  });

  it('persists a rep detected with NO active session, leaving sessionId absent', () => {
    const { client, putIdleRep } = makeHarness({ connectedDeviceId: 'AA:BB:CC' });

    feedIdleRepCycle(client, 1);

    expect(putIdleRep).toHaveBeenCalledTimes(1);
    const written = putIdleRep.mock.calls[0][0];
    expect('sessionId' in written).toBe(false);
    expect(written.slot).toBe('primary');
  });

  it('leaves side absent when the device is unbound', () => {
    const { client, putIdleRep } = makeHarness({
      connectedDeviceId: 'AA:BB:CC',
      bindings: new Map(),
    });

    feedIdleRepCycle(client, 1);

    const written = putIdleRep.mock.calls[0][0];
    expect(written.deviceId).toBe('AA:BB:CC');
    expect('side' in written).toBe(false);
  });

  it('leaves side and deviceId absent when there is no connected device id', () => {
    const bindings = new Map([['AA:BB:CC', { physicalSide: 'left' as const }]]);
    const { client, putIdleRep } = makeHarness({ connectedDeviceId: null, bindings });

    feedIdleRepCycle(client, 1);

    const written = putIdleRep.mock.calls[0][0];
    expect('deviceId' in written).toBe(false);
    expect('side' in written).toBe(false);
  });

  it('leaves side absent when the binding exists but names no physical side', () => {
    const bindings = new Map([['AA:BB:CC', { physicalSide: null }]]);
    const { client, putIdleRep } = makeHarness({ connectedDeviceId: 'AA:BB:CC', bindings });

    feedIdleRepCycle(client, 1);

    expect('side' in putIdleRep.mock.calls[0][0]).toBe(false);
  });

  it('omits weight rather than writing a 0 sentinel when the load is unknown', () => {
    const { client, putIdleRep } = makeHarness({ connectedDeviceId: 'AA:BB:CC' });

    feedIdleRepCycle(client, 1);

    expect('weightLbs' in putIdleRep.mock.calls[0][0]).toBe(false);
  });

  it('writes one row per detected rep with distinct ids', () => {
    const { client, putIdleRep } = makeHarness({ connectedDeviceId: 'AA:BB:CC' });

    feedIdleRepCycle(client, 1);
    feedIdleRepCycle(client, 10);
    feedIdleRepCycle(client, 20);

    expect(putIdleRep).toHaveBeenCalledTimes(3);
    const ids = putIdleRep.mock.calls.map((c) => c[0].id);
    expect(new Set(ids).size).toBe(3);
  });

  it('does not persist reps performed inside an armed set', () => {
    const { live, client, putIdleRep } = makeHarness({ connectedDeviceId: 'AA:BB:CC' });
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

    feedIdleRepCycle(client, 1);

    expect(putIdleRep).not.toHaveBeenCalled();
  });

  describe('a failing store never disturbs the live path', () => {
    let unhandled: unknown[];

    beforeEach(() => {
      unhandled = [];
      const onUnhandled = (err: unknown): void => {
        unhandled.push(err);
      };
      process.on('unhandledRejection', onUnhandled);
      return () => process.off('unhandledRejection', onUnhandled);
    });

    it('a rejecting putIdleRep still leaves the ring, count and channel event intact', async () => {
      const putIdleRep = vi.fn(async () => {
        throw new Error('disk on fire');
      });
      const { live, client, channels } = makeHarness({
        connectedDeviceId: 'AA:BB:CC',
        putIdleRep,
      });
      live.startSession({
        sessionId: 'sess-1',
        startedAt: '2025-01-01T00:00:00.000Z',
        setIds: [],
        status: 'active',
        verboseIdleReps: true,
      });

      expect(() => feedIdleRepCycle(client, 1)).not.toThrow();

      expect(live.idleRepCount).toBe(1);
      expect(live.idleReps.length).toBe(1);
      const idleEvents = channels.publish.mock.calls.filter(
        (c) => c[0].meta.event_type === 'idle_rep',
      );
      expect(idleEvents.length).toBe(1);

      // Let the detached rejection settle; the `.catch` must have swallowed it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    });

    it('a synchronously throwing putIdleRep does not escape the frame handler', () => {
      const putIdleRep = vi.fn(() => {
        throw new Error('store exploded');
      }) as unknown as Mock<(rep: StoredIdleRep) => Promise<void>>;
      const { live, client } = makeHarness({ connectedDeviceId: 'AA:BB:CC', putIdleRep });

      expect(() => feedIdleRepCycle(client, 1)).not.toThrow();
      expect(live.idleRepCount).toBe(1);
    });

    it('tolerates a state with no store at all', () => {
      const { live, client } = makeHarness({ omitStore: true, connectedDeviceId: 'AA:BB:CC' });

      expect(() => feedIdleRepCycle(client, 1)).not.toThrow();
      expect(live.idleRepCount).toBe(1);
    });
  });
});
