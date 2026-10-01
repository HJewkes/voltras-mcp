// Pinning the set-risk reading at set start and on repin (VW-613, VW-152 S4).
// The store is a stub of the port; every set and value is synthetic.

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadSeedCatalog } from '../../exercises/__tests__/load-seed-catalog.js';
import type { StoredSet } from '../../store/types.js';
import { repinEffortContext } from '../effort-pin.js';
import { LiveState, type ActiveSet, type DeviceSnapshot } from '../live-state.js';
import type { ServerState } from '../server-state.js';
import { onSetStarted } from '../set-start-seam.js';

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

beforeAll(loadSeedCatalog);

const ISOLATION = 'cable-bicep-curl';
const LOADED = 'cable-squat';

function deviceAt(weightLbs: number): DeviceSnapshot {
  return { connected: true, weightLbs, trainingMode: 'Weight Training' };
}

function stubStore() {
  return {
    getAssignmentsForSession: vi.fn(async () => []),
    getPlannedExercisesForTemplate: vi.fn(async () => []),
    getPlannedExercise: vi.fn(async () => undefined),
    getRirVelocityModel: vi.fn(async () => undefined),
    getSetsForExercise: vi.fn(async () => HISTORY),
    getSetsForSession: vi.fn(async (): Promise<StoredSet[]> => []),
  };
}

type SetFields = Partial<Pick<ActiveSet, 'exerciseId' | 'lifter' | 'autoCreatedBy'>>;

function liveWithSet(setId: string, fields: SetFields): LiveState {
  const live = new LiveState();
  live.startSession({
    sessionId: 'sess-1',
    startedAt: '2026-09-21T12:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  live.startSet({
    setId,
    sessionId: 'sess-1',
    startedAt: '2026-09-21T12:00:00.000Z',
    reps: [],
    status: 'active',
    ...fields,
  });
  return live;
}

function harness(fields: SetFields = { exerciseId: ISOLATION }, weightLbs = 80) {
  const live = liveWithSet('set-1', fields);
  const store = stubStore();
  const state = {
    store,
    slots: new Map([['primary', { live }]]),
    setStartDeviceSnapshots: new Map([['set-1', deviceAt(weightLbs)]]),
  } as unknown as ServerState;
  return { live, store, state };
}

describe('set-risk pin at set start', () => {
  it('pins a reading marked with the started set', async () => {
    const { live, state } = harness();

    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });

    const reading = live.setRiskReadingFor('set-1');
    expect(reading).toBeDefined();
    expect(reading?.factors.exercise).toBe(0);
    expect(reading?.factors.intensity).toBe(0);
    expect(live.setRiskReadingFor('set-0')).toBeUndefined();
  });

  it('leaves no reading and an untouched set when an input reader throws', async () => {
    const { live, state, store } = harness();
    store.getSetsForSession.mockRejectedValue(new Error('store unavailable'));
    const before = live.snapshotSet();

    await expect(
      onSetStarted(state, { slotId: 'primary', setId: 'set-1' }),
    ).resolves.toBeUndefined();

    expect(live.setRiskReadingFor('set-1')).toBeUndefined();
    expect(live.set?.setId).toBe('set-1');
    expect(live.set?.effortContext).toBeDefined();
    expect({ ...live.snapshotSet(), effortContext: undefined }).toEqual({
      ...before,
      effortContext: undefined,
    });
  });

  it('never reads one set’s reading for the set that replaced it', async () => {
    const { live, state } = harness();
    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });

    live.endSet();
    live.startSet({
      setId: 'set-2',
      sessionId: 'sess-1',
      startedAt: '2026-09-21T12:02:00.000Z',
      reps: [],
      status: 'active',
      exerciseId: ISOLATION,
    });

    expect(live.setRiskReadingFor('set-2')).toBeUndefined();
    expect(live.setRiskReadingFor('set-1')).toBeUndefined();
  });

  it('holds an independent reading on each bilateral slot', async () => {
    const left = liveWithSet('set-L', { exerciseId: ISOLATION });
    const right = liveWithSet('set-R', { exerciseId: LOADED, lifter: 'Guest A' });
    const state = {
      store: stubStore(),
      slots: new Map([
        ['left', { live: left }],
        ['right', { live: right }],
      ]),
      setStartDeviceSnapshots: new Map([
        ['set-L', deviceAt(80)],
        ['set-R', deviceAt(120)],
      ]),
    } as unknown as ServerState;

    await Promise.all([
      onSetStarted(state, { slotId: 'left', setId: 'set-L' }),
      onSetStarted(state, { slotId: 'right', setId: 'set-R' }),
    ]);

    expect(left.setRiskReadingFor('set-L')).toMatchObject({
      factors: { exercise: 0, intensity: 0 },
    });
    expect(left.setRiskReadingFor('set-L')?.vetoes).not.toContain('guest_lifter');
    expect(right.setRiskReadingFor('set-R')).toMatchObject({
      band: 'red',
      factors: { exercise: 2, intensity: null },
    });
    expect(right.setRiskReadingFor('set-R')?.vetoes).toContain('guest_lifter');
    expect(left.setRiskReadingFor('set-R')).toBeUndefined();
    expect(right.setRiskReadingFor('set-L')).toBeUndefined();
  });
});

describe('set-risk pin on the effort repin triggers', () => {
  it('recomputes when the start snapshot is retaken at a new weight', async () => {
    const { live, state } = harness();
    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });
    expect(live.setRiskReadingFor('set-1')?.factors.intensity).toBe(0);

    state.setStartDeviceSnapshots.set('set-1', deviceAt(120));
    await repinEffortContext(state, live, 'set-1');

    expect(live.setRiskReadingFor('set-1')?.factors.intensity).toBe(2);
  });

  it('recomputes when an auto-armed set gains an exercise', async () => {
    const { live, state } = harness({ autoCreatedBy: 'idle_rep' });
    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });
    expect(live.setRiskReadingFor('set-1')).toMatchObject({
      band: 'red',
      factors: { exercise: null },
    });

    live.upgradeActiveSet({ exerciseId: LOADED, upgradedAt: '2026-09-21T12:00:05.000Z' });
    await repinEffortContext(state, live, 'set-1');

    expect(live.setRiskReadingFor('set-1')?.factors.exercise).toBe(2);
  });

  it('drops the old reading when the recompute fails', async () => {
    const { live, state, store } = harness();
    await onSetStarted(state, { slotId: 'primary', setId: 'set-1' });
    store.getSetsForSession.mockRejectedValue(new Error('store unavailable'));

    state.setStartDeviceSnapshots.set('set-1', deviceAt(120));
    await expect(repinEffortContext(state, live, 'set-1')).resolves.toBeUndefined();

    expect(live.setRiskReadingFor('set-1')).toBeUndefined();
  });
});
