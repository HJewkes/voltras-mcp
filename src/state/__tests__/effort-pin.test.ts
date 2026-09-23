// Pinning the effort context onto a live set (VW-540), and the set-start seam
// that runs it. The store is a stub of the port; every value is synthetic.

import { describe, expect, it, vi } from 'vitest';

import { RIR_VELOCITY_MODEL_VERSION, type RirVelocityModel } from '../../analytics/rir-velocity.js';
import type { StoredPlannedExercise, StoredSet } from '../../store/types.js';
import { pinEffortContext } from '../effort-pin.js';
import { LiveState, type DeviceSnapshot } from '../live-state.js';
import type { ServerState } from '../server-state.js';
import { onSetStarted, type SetStartSubscriber } from '../set-start-seam.js';

const NOW_MODEL: RirVelocityModel = {
  form: 'linear',
  version: RIR_VELOCITY_MODEL_VERSION,
  resistanceFamily: 'constant',
  interceptMps: 0.2,
  slopeMpsPerRir: 0.05,
  r2: 0.9,
  seeMps: 0.05,
  rirErrorReps: 1,
  pointCount: 30,
  setCount: 6,
  sessionCount: 3,
  rirRange: [0, 5],
  intensityRange: [0.6, 0.85],
  anchorSources: { failure: 2, selfReport: 4 },
  observedFrom: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  observedTo: new Date(Date.now() - 86_400_000).toISOString(),
  heldOutErrorReps: 1,
};

const ROW: StoredPlannedExercise = {
  id: 'pe-1',
  workoutTemplateId: 'tpl-1',
  exerciseId: 'ex-1',
  orderIndex: 0,
  targetSets: 3,
  targetRepsLow: 8,
  targetRepsHigh: 10,
  targetRpe: 8,
  goalKind: 'rep_range',
};

/** One owner set at 10 reps x 100 lb: an Epley reference of about 133 lb. */
const HISTORY: StoredSet[] = [
  {
    id: 'old-1',
    sessionId: 'sess-old',
    startedAt: '2026-09-01T12:00:00.000Z',
    endedAt: '2026-09-01T12:01:00.000Z',
    partial: false,
    trainingMode: 'Weight Training',
    weightLbs: 100,
    reps: Array.from({ length: 10 }, (_, i) => ({ repNumber: i + 1 }) as never),
  },
];

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

function stubStore(model: RirVelocityModel | undefined = undefined) {
  return {
    getAssignmentsForSession: vi.fn(async () => [
      { id: 'a1', sessionId: 'sess-1', workoutTemplateId: 'tpl-1', assignedAt: '2026-09-21' },
    ]),
    getPlannedExercisesForTemplate: vi.fn(async () => [ROW]),
    getPlannedExercise: vi.fn(async () => undefined),
    getRirVelocityModel: vi.fn(async () =>
      model === undefined ? undefined : { model: model as unknown as Record<string, unknown> },
    ),
    getSetsForExercise: vi.fn(async () => HISTORY),
  };
}

function harness(opts: { lifter?: string; store?: ReturnType<typeof stubStore> } = {}) {
  const live = new LiveState();
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-09-21T12:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId: 'set-1',
    sessionId: 'sess-1',
    startedAt: '2026-09-21T12:00:00.000Z',
    reps: [],
    status: 'active',
    exerciseId: 'ex-1',
    ...(opts.lifter !== undefined ? { lifter: opts.lifter } : {}),
  });
  const store = opts.store ?? stubStore(NOW_MODEL);
  const state = {
    store,
    slots: new Map([['primary', { live }]]),
    setStartDeviceSnapshots: new Map([['set-1', DEVICE]]),
  } as unknown as ServerState;
  return { live, store, state };
}

describe('pinEffortContext', () => {
  it('pins the plan goal, the row cap and a trusted curve at the set start load', async () => {
    const { live, state } = harness();

    await pinEffortContext(state, live, 'set-1');

    expect(live.set?.effortContext).toMatchObject({
      goal: { kind: 'rep_range', repsLow: 8, repsHigh: 10, source: 'plan' },
      guard: { effortCapRpe: 8, effortCapSource: 'plan', lossPct: null, lossSource: null },
      resistance: { family: 'constant', signature: 'none' },
      profile: { interceptMps: 0.2, resistanceFamily: 'constant' },
      profileWithheld: null,
    });
    expect(live.set?.effortContext?.relativeIntensity).toBeCloseTo(0.75, 2);
  });

  it('keeps the reason beside the context when the curve is not trusted', async () => {
    const { live, state } = harness({ store: stubStore({ ...NOW_MODEL, heldOutErrorReps: null }) });

    await pinEffortContext(state, live, 'set-1');

    expect(live.set?.effortContext).toMatchObject({
      profile: null,
      relativeIntensity: null,
      profileWithheld: 'held_out_miss',
    });
  });

  it("never pins the owner's curve on a guest's set", async () => {
    const { live, state, store } = harness({ lifter: 'guest' });

    await pinEffortContext(state, live, 'set-1');

    expect(live.set?.effortContext).toMatchObject({
      profile: null,
      profileWithheld: 'guest_lifter',
    });
    expect(store.getRirVelocityModel).not.toHaveBeenCalled();
  });

  it('drops a pin whose watch changed while the store reads were in flight', async () => {
    const { live, state } = harness();

    const pin = pinEffortContext(state, live, 'set-1');
    live.upgradeActiveSet({
      upgradedAt: '2026-09-21T12:00:05.000Z',
      watch: { notifyOn: [{ type: 'rep_count_reached', value: 5 }] },
    });
    await pin;

    expect(live.set?.effortContext).toBeUndefined();
  });

  it('drops a pin whose start snapshot was retaken while the store reads were in flight', async () => {
    const { live, state } = harness();

    const pin = pinEffortContext(state, live, 'set-1');
    state.setStartDeviceSnapshots.set('set-1', { ...DEVICE, weightLbs: 120 });
    await pin;

    expect(live.set?.effortContext).toBeUndefined();
  });

  it('never lands a late pin on the set that replaced its own', async () => {
    const { live, state } = harness();

    const pin = pinEffortContext(state, live, 'set-1');
    live.endSet();
    live.startSet({
      setId: 'set-2',
      sessionId: 'sess-1',
      startedAt: '2026-09-21T12:02:00.000Z',
      reps: [],
      status: 'active',
      exerciseId: 'ex-1',
    });
    await pin;

    expect(live.set?.setId).toBe('set-2');
    expect(live.set?.effortContext).toBeUndefined();
  });
});

describe('onSetStarted', () => {
  it('pins the context through the registered subscriber', async () => {
    const { live, state } = harness();

    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });

    expect(live.set?.effortContext).toBeDefined();
  });

  it('runs every subscriber even when one fails, and never rejects', async () => {
    const { state } = harness();
    const second = vi.fn<SetStartSubscriber>(async () => undefined);
    const failing: SetStartSubscriber = async () => {
      throw new Error('store unavailable');
    };

    await expect(
      onSetStarted(state, { slotId: 'primary', setId: 'set-1' }, [failing, second]),
    ).resolves.toBeUndefined();

    expect(second).toHaveBeenCalledWith(state, { slotId: 'primary', setId: 'set-1' });
  });
});
