// Set-risk input readers (VW-612, VW-152 S3) against a temp store. Every set is synthetic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import type { DeviceSnapshot } from '../live-state.js';
import { readSetRiskInputs, type SetRiskStart } from '../set-risk-inputs.js';

const EXERCISE = 'synthetic-press';
const OTHER_EXERCISE = 'synthetic-curl';
const HISTORY_SESSION = 'sess-history';
const LIVE_SESSION = 'sess-live';
const GUEST = 'Guest A';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

const PHASE: Phase = {
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
};

function repsAt(setId: string, velocities: readonly number[]): StoredRep[] {
  return velocities.map((mps, index) => ({
    id: `${setId}-rep-${index + 1}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...PHASE, _totalVelocity: mps, _movementSampleCount: 1, peakVelocity: mps },
    eccentric: PHASE,
  })) as StoredRep[];
}

const STEADY = [0.6, 0.6, 0.59, 0.58, 0.58];
const DECAYED = [0.6, 0.58, 0.5, 0.42, 0.36];

let minute = 0;

function storedSet(id: string, fields: Partial<StoredSet> & { velocities?: number[] }): StoredSet {
  minute += 1;
  const { velocities = STEADY, ...rest } = fields;
  const stamp = `2026-09-20T12:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    id,
    sessionId: LIVE_SESSION,
    startedAt: stamp,
    endedAt: stamp,
    partial: false,
    userId: 'local',
    exerciseId: EXERCISE,
    weightLbs: 100,
    trainingMode: 'Weight Training',
    effortContext: watchAt(20),
    reps: repsAt(id, velocities),
    ...rest,
  };
}

function liveStart(fields: Partial<SetRiskStart> = {}): SetRiskStart {
  return { setId: 'set-live', sessionId: LIVE_SESSION, exerciseId: EXERCISE, ...fields };
}

let store: SessionStore;

beforeEach(async () => {
  minute = 0;
  store = openTestStore();
  await store.putSession({ id: HISTORY_SESSION, startedAt: '2026-09-01T12:00:00.000Z' });
  await store.putSession({ id: LIVE_SESSION, startedAt: '2026-09-20T12:00:00.000Z' });
});

afterEach(async () => {
  await store.close();
});

async function seedHistory(...sets: StoredSet[]): Promise<void> {
  for (const set of sets) await store.putSet({ ...set, sessionId: HISTORY_SESSION });
  await store.setSessionKind([HISTORY_SESSION], 'training');
}

async function seedLive(...sets: StoredSet[]): Promise<void> {
  for (const set of sets) await store.putSet(set);
}

describe('relative intensity', () => {
  it('reads load over the rep-based reference with no RIR model stored', async () => {
    await seedHistory(storedSet('h1', { weightLbs: 120, velocities: [0.5, 0.5, 0.5, 0.5, 0.5] }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(await store.getRirVelocityModel('local', EXERCISE)).toBeUndefined();
    expect(inputs.relativeIntensity).toBeCloseTo(100 / (120 * (1 + 5 / 30)), 6);
  });

  it('is null when the exercise has no weighted working set', async () => {
    await seedHistory(
      storedSet('h-warm', { weightLbs: 80, setPurpose: 'warmup', isWarmup: true }),
      storedSet('h-unweighted', { weightLbs: undefined }),
    );

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.relativeIntensity).toBeNull();
  });

  it('is null when the device reports no load', async () => {
    await seedHistory(storedSet('h1', { weightLbs: 120 }));

    const inputs = await readSetRiskInputs(store, liveStart(), { ...DEVICE, weightLbs: undefined });

    expect(inputs.relativeIntensity).toBeNull();
    expect(inputs.loadLbs).toBeNull();
  });

  it("ignores a guest's heavier set when reading the owner's reference", async () => {
    await seedHistory(
      storedSet('h-owner', { weightLbs: 120 }),
      storedSet('h-guest', { weightLbs: 300, lifter: GUEST }),
    );

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.relativeIntensity).toBeCloseTo(100 / (120 * (1 + 5 / 30)), 6);
  });
});

describe('live set index', () => {
  it('counts same-exercise working sets in the session plus one', async () => {
    await seedLive(
      storedSet('w1', {}),
      storedSet('warm', { setPurpose: 'warmup', isWarmup: true }),
      storedSet('w2', {}),
      storedSet('curl', { exerciseId: OTHER_EXERCISE }),
      storedSet('guest', { lifter: GUEST }),
    );

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.setIndexInExercise).toBe(3);
  });

  it('is 1 on the first working set of the exercise', async () => {
    await seedLive(storedSet('warm', { setPurpose: 'warmup', isWarmup: true }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.setIndexInExercise).toBe(1);
  });

  it('does not count the live set if it is already stored', async () => {
    await seedLive(storedSet('w1', {}), storedSet('set-live', {}));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.setIndexInExercise).toBe(2);
  });

  it('is null, with prior decay null, when the set names no exercise', async () => {
    await seedLive(storedSet('w1', {}));

    const inputs = await readSetRiskInputs(store, liveStart({ exerciseId: undefined }), DEVICE);

    expect(inputs.setIndexInExercise).toBeNull();
    expect(inputs.priorSetDecayed).toBeNull();
  });
});

describe('prior-set decay', () => {
  it('is true when the previous same-exercise set tripped its velocity-loss watch', async () => {
    await seedLive(storedSet('w1', { velocities: DECAYED }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(true);
  });

  it('is false when the previous set stayed inside its own threshold', async () => {
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: watchAt(50) }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(false);
  });

  it('reads only the most recent same-exercise set, not an earlier one', async () => {
    await seedLive(
      storedSet('w1', { velocities: DECAYED }),
      storedSet('w2', { velocities: STEADY }),
      storedSet('curl', { exerciseId: OTHER_EXERCISE, velocities: DECAYED }),
    );

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(false);
  });

  it('is false on the first set of the exercise', async () => {
    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(false);
  });

  it('is false when the previous set had its watch suppressed', async () => {
    const suppressed = { ...watchAt(20), velocitySignalValid: false };
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: suppressed }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(false);
  });

  it('skips the eccentric lead-in reps the live watch skips', async () => {
    const leadInOnlyDrop = [0.9, 0.5, 0.5, 0.5, 0.5];
    await seedLive(storedSet('w1', { velocities: leadInOnlyDrop, eccentricPct: 20 }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(false);
  });

  it('reads the watch pct from a loss goal the watch itself set', async () => {
    const goalFromWatch = {
      ...watchAt(20),
      goal: { kind: 'velocity_loss', lossPct: 20, source: 'set_intent' },
      guard: { effortCapRpe: null, effortCapSource: null, lossPct: null, lossSource: null },
    };
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: goalFromWatch }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBe(true);
  });

  it('is null, never true, for a set whose context shows no loss watch', async () => {
    const noLossWatch = {
      ...watchAt(20),
      guard: { effortCapRpe: null, effortCapSource: null, lossPct: null, lossSource: null },
    };
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: noLossWatch }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBeNull();
  });

  it('is null for an assumed-stop watch whose pct differs from the band reference', async () => {
    const assumedStop = {
      ...watchAt(10),
      guard: { effortCapRpe: null, effortCapSource: null, lossPct: 10, lossSource: 'plan_intent' },
    };
    const lossPastBandReference = [0.6, 0.6, 0.55, 0.52, 0.51];
    await seedLive(
      storedSet('w1', { velocities: lossPastBandReference, effortContext: assumedStop }),
    );

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBeNull();
  });

  it('is null when the loss goal came from the plan, not the watch', async () => {
    const planGoal = {
      ...watchAt(20),
      goal: { kind: 'velocity_loss', lossPct: 20, source: 'plan' },
      guard: { effortCapRpe: null, effortCapSource: null, lossPct: null, lossSource: null },
    };
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: planGoal }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBeNull();
  });

  it('is null when the previous set carries no pinned threshold', async () => {
    await seedLive(storedSet('w1', { velocities: DECAYED, effortContext: undefined }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.priorSetDecayed).toBeNull();
  });
});

describe('lifter scoping', () => {
  it("reports a guest lifter and reads only the guest's own sets", async () => {
    await seedHistory(storedSet('h-owner', { weightLbs: 120 }));
    await seedLive(
      storedSet('owner-1', { velocities: DECAYED }),
      storedSet('owner-2', { velocities: DECAYED }),
      storedSet('guest-1', { lifter: GUEST, velocities: STEADY }),
    );

    const inputs = await readSetRiskInputs(store, liveStart({ lifter: GUEST }), DEVICE);

    expect(inputs.guestLifter).toBe(true);
    expect(inputs.setIndexInExercise).toBe(2);
    expect(inputs.priorSetDecayed).toBe(false);
    expect(inputs.relativeIntensity).toBeNull();
  });

  it("reports the owner as no guest and never counts a guest's set", async () => {
    await seedLive(storedSet('guest-1', { lifter: GUEST, velocities: DECAYED }));

    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.guestLifter).toBe(false);
    expect(inputs.setIndexInExercise).toBe(1);
    expect(inputs.priorSetDecayed).toBe(false);
  });
});

describe('resistance family', () => {
  it('reports constant load for a plain weight mode', async () => {
    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.resistanceFamily).toBe('constant');
  });

  it('reports a non-constant mode as other', async () => {
    const chains: DeviceSnapshot = { ...DEVICE, chainSettingLbs: 20 };

    const inputs = await readSetRiskInputs(store, liveStart(), chains);

    expect(inputs.resistanceFamily).toBe('other');
  });

  it('reports a device with no known mode as other, never as constant', async () => {
    const inputs = await readSetRiskInputs(store, liveStart(), { connected: true, weightLbs: 100 });

    expect(inputs.resistanceFamily).toBe('other');
  });
});

describe('the scorer input shape', () => {
  it('passes the live load through and leaves an unclassified exercise null', async () => {
    const inputs = await readSetRiskInputs(store, liveStart(), DEVICE);

    expect(inputs.loadLbs).toBe(100);
    expect(inputs.exerciseClass).toBeNull();
  });
});

/** A pinned context whose loss guard came from the set's own explicit watch spec. */
function watchAt(pct: number): NonNullable<StoredSet['effortContext']> {
  return {
    goal: { kind: 'rep_range', repsLow: 5, repsHigh: 5, source: 'explicit' },
    guard: { effortCapRpe: null, effortCapSource: null, lossPct: pct, lossSource: 'explicit' },
    bandReferenceLossPct: pct,
    velocitySignalValid: true,
  };
}
