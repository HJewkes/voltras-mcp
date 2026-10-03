// Regression tests for VW-809: a throw inside a bridge listener is logged and
// counted on the slot, and does not cost the next rep or the SDK's other
// listeners for the same event. VW-869: a throw in a step that runs before the
// listener's critical step does not skip that step.
//
// Frame phase values mirror the SDK's `MovementPhase` enum (numeric):
//   1 = CONCENTRIC, 3 = ECCENTRIC. An ECC to CONC transition closes the
// previous rep.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class VoltraSDKError extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'Weight Training' },
}));

vi.mock('../effort-pin.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markSettingChange: vi.fn(),
}));

vi.mock('../../tools/set-tools.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeSet: vi.fn(async () => undefined),
}));

const { LiveState } = await import('../live-state.js');
const { wireBridgeForSlot } = await import('../event-bridge.js');
const { guardListener } = await import('../guard-listener.js');
const { SetWatchdog } = await import('../set-watchdog.js');
const { ModeRevertGuard } = await import('../mode-revert-guard.js');
const { CoercionWatch } = await import('../coercion-watch.js');
const { RestTimerRegistry } = await import('../rest-timer.js');
const { markSettingChange } = await import('../effort-pin.js');
const { log } = await import('../../logger.js');
const { LiveSignalEmitter } = await import('../live-signal.js');
const { finalizeSet } = await import('../../tools/set-tools.js');

type Frame = { sequence: number; timestamp: number; phase: number } & Record<string, number>;

function makeFakeClient() {
  let frameCb: (frame: Frame) => void = () => undefined;
  let setSummaryCb: (payload: Record<string, unknown>) => void = () => undefined;
  const noop = vi.fn(() => () => undefined);
  return {
    onFrame: vi.fn((l: (f: Frame) => void) => {
      frameCb = l;
      return () => undefined;
    }),
    onPerRep: noop,
    onInProgress: noop,
    onSummary: noop,
    onSetSummary: vi.fn((l: (p: Record<string, unknown>) => void) => {
      setSummaryCb = l;
      return () => undefined;
    }),
    onSettingsUpdate: noop,
    onConnectionStateChange: noop,
    onStateDump: noop,
    endSet: vi.fn(async () => undefined),
    settings: null,
    fireFrame: (f: Frame) => frameCb(f),
    fireSetSummary: (p: Record<string, unknown>) => setSummaryCb(p),
  };
}

function makeHarness() {
  const live = new LiveState();
  const client = makeFakeClient();
  const publish = vi.fn();
  const channels = { publish, forSlot: () => ({ publish }) };
  const slot: { slotId: string; listenerFaults?: Record<string, number> } & Record<
    string,
    unknown
  > = {
    slotId: 'primary',
    client,
    live,
    modeRevertGuard: new ModeRevertGuard(),
    coercionWatch: new CoercionWatch(),
  };
  const state = {
    slots: new Map([['primary', slot]]),
    channels,
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
    setStartDeviceSnapshots: new Map(),
    config: { autoArm: 'off' },
    liveSignals: { emit: vi.fn() },
  };
  wireBridgeForSlot(
    state as unknown as Parameters<typeof wireBridgeForSlot>[0],
    slot as unknown as Parameters<typeof wireBridgeForSlot>[1],
  );
  return { live, client, publish, slot };
}

function startSet(live: InstanceType<typeof LiveState>): void {
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
  });
}

/** Feed one concentric then eccentric pass; the next concentric closes it. */
function feedRep(client: ReturnType<typeof makeFakeClient>, startSeq: number): number {
  const phases = [1, 1, 1, 3, 3, 3];
  phases.forEach((phase, i) => {
    const seq = startSeq + i;
    client.fireFrame({
      sequence: seq,
      timestamp: 1000 + seq * 100,
      phase,
      position: phase === 1 ? 250 * (i % 3) : 500 - 250 * (i % 3),
      velocity: 800,
      force: 500,
    });
  });
  return startSeq + phases.length;
}

function finalizedRepNumbers(publish: ReturnType<typeof vi.fn>): number[] {
  return publish.mock.calls
    .map(([event]) => event as { content: string; meta: Record<string, string> })
    .filter((event) => event.meta.event_type === 'rep_finalized')
    .map((event) => (JSON.parse(event.content) as { rep: { rep_number: number } }).rep.rep_number);
}

describe('bridge listener guard (VW-809)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.mocked(markSettingChange).mockReset();
    vi.mocked(finalizeSet).mockClear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('records the next rep after an analytics path throws on one rep', () => {
    const h = makeHarness();
    startSet(h.live);
    vi.mocked(markSettingChange).mockImplementationOnce(() => {
      throw new Error('injected analytics failure');
    });

    let seq = feedRep(h.client, 1);
    expect(() => {
      seq = feedRep(h.client, seq);
    }).not.toThrow();
    seq = feedRep(h.client, seq);
    h.client.fireFrame({ sequence: 99, timestamp: 20_000, phase: 1, position: 0, velocity: 800 });

    expect(finalizedRepNumbers(h.publish)).toHaveLength(3);
    expect(h.live.snapshotSet()?.reps.length).toBe(4);
    expect(h.slot.listenerFaults).toEqual({ frame: 1 });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      'event-bridge: frame listener step setting_change threw on slot primary',
    );
  });

  it('publishes the rep_finalized of a rep whose closing frame faults in a step before the publish', () => {
    const h = makeHarness();
    startSet(h.live);
    const closingFrameTimestamp = 1000 + 7 * 100;
    vi.spyOn(LiveSignalEmitter.prototype, 'frame').mockImplementation((input) => {
      if (input.t === closingFrameTimestamp) throw new Error('injected live-signal failure');
    });

    const seq = feedRep(h.client, 1);
    h.client.fireFrame({ sequence: seq, timestamp: closingFrameTimestamp, phase: 1, position: 0 });

    expect(finalizedRepNumbers(h.publish)).toEqual([1]);
    expect(h.slot.listenerFaults).toEqual({ frame: 1 });
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      'event-bridge: frame listener step live_signal threw on slot primary',
    );
  });

  it('runs the device close path when an analytics step of the set summary throws', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    startSet(h.live);
    feedRep(h.client, 1);
    vi.spyOn(h.live, 'finalizeFirmwareReps').mockImplementation(() => {
      throw new Error('injected firmware-rep failure');
    });

    h.client.fireSetSummary({
      schemaVersion: 1,
      targetWeightTenths: 1000,
      repCount: 1,
      totalPullMovingTimeMs: 900,
      raw: new Uint8Array(4),
    });

    expect(finalizeSet).toHaveBeenCalledOnce();
    expect(vi.mocked(finalizeSet).mock.calls[0]?.[2]).toMatchObject({ cause: 'device_signal' });
    expect(h.slot.listenerFaults).toEqual({ set_summary: 1 });
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      'event-bridge: set_summary listener step firmware_reps threw on slot primary',
    );
  });

  it('lets the other listeners for the same event run when one throws', () => {
    const slot: { slotId: string; listenerFaults?: Record<string, number> } = { slotId: 'left' };
    const later = vi.fn();
    const listeners = [
      guardListener('per_rep', slot, () => {
        throw new Error('boom');
      }),
      later,
    ];

    listeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());

    expect(later).toHaveBeenCalledTimes(2);
    expect(slot.listenerFaults).toEqual({ per_rep: 2 });
  });
});
