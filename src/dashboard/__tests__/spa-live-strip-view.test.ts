// Unit tests for the pinned live strip mapper (VW-429): which routes and phases show the
// strip, what it counts, and that zone and fatigue come from the same sources the live page
// reads. Real WA reps, so velocities take the same path `/api/snapshot` reps take.

import { describe, expect, it } from 'vitest';
import {
  addSampleToSet,
  categorizeVelocity,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

import {
  initialAccumulatorState,
  type CompletedSet,
  type PrescriptionView,
  type Snapshot,
} from '../spa/adapter.js';
import { type LiveViewSources } from '../spa/panels/live-view.js';
import { mapStoreToLiveStrip } from '../spa/panels/live-strip-view.js';
import { type Route } from '../spa/routing.js';

const EXERCISE = 'Cable Chest Press';
const GOALS: Route = { name: 'goals' };

/** A rep whose mean concentric velocity is exactly `mps`. */
function repSamples(mps: number, seq: number, t0: number): WorkoutSample[] {
  const sample = (i: number, dt: number, phase: MovementPhase, position: number) => ({
    sequence: seq + i,
    timestamp: t0 + dt,
    phase,
    position,
    velocity: phase === MovementPhase.CONCENTRIC ? mps : mps / 2,
    force: 100,
  });
  return [
    sample(0, 0, MovementPhase.CONCENTRIC, 0),
    sample(1, 500, MovementPhase.CONCENTRIC, 0.5),
    sample(2, 600, MovementPhase.ECCENTRIC, 0.5),
    sample(3, 1600, MovementPhase.ECCENTRIC, 0),
  ];
}

function reps(velocities: number[]): Rep[] {
  let set = createSet();
  velocities.forEach((mps, i) => {
    for (const s of repSamples(mps, i * 4, 1000 + i * 2000)) set = addSampleToSet(set, s);
  });
  return [...set.reps];
}

function prescription(over: Partial<PrescriptionView> = {}): PrescriptionView {
  return {
    sets: 4,
    repsLow: 8,
    restSec: 90,
    exercises: [{ name: EXERCISE, order: 0, sets: 4, repsLow: 8, active: true }],
    ...over,
  };
}

function snapshot(activeReps: Rep[] | null): Snapshot {
  const active = activeReps === null ? null : { reps: activeReps };
  return {
    session: { sessionId: 's1', exerciseName: EXERCISE },
    devices: [{ slotId: 'primary', device: { connected: true, weightLbs: 140 }, sets: { active } }],
    sets: { active },
  };
}

function closedSet(velocities: number[], weightLbs = 135): CompletedSet {
  const setReps = reps(velocities);
  return {
    weightLbs,
    mode: 'WeightTraining',
    repCount: setReps.length,
    exerciseName: EXERCISE,
    bestPeakVelocityMps: null,
    peakForceLbs: null,
    reps: setReps,
    setPurpose: 'working',
  };
}

/** Mid-set: `velocities` performed so far, `done` sets already closed. */
function setSources(velocities: number[], done: CompletedSet[] = []): LiveViewSources {
  return {
    snapshot: snapshot(reps(velocities)),
    accumulator: { ...initialAccumulatorState(), setLog: done },
    live: null,
    prescription: prescription(),
    nowMs: 10_000,
  };
}

/** Between sets: `done` closed, rest began at 0 and `elapsedMs` has passed. */
function restSources(done: CompletedSet[], elapsedMs: number): LiveViewSources {
  return {
    snapshot: snapshot(null),
    accumulator: { ...initialAccumulatorState(), setLog: done, restStartMs: 0 },
    live: null,
    prescription: prescription(),
    nowMs: elapsedMs,
  };
}

describe('mapStoreToLiveStrip: set', () => {
  it('shows the set being lifted against the planned set count', () => {
    const strip = mapStoreToLiveStrip(setSources([0.6, 0.58, 0.55]), GOALS);

    expect(strip).toMatchObject({
      state: 'set',
      exerciseName: EXERCISE,
      setNumber: 1,
      setCount: 4,
      loadLabel: '140 lb',
      targetReps: 8,
      isFatigued: false,
    });
    expect(strip?.reps.map((r) => r.velocity)).toEqual([0.6, 0.58, 0.55]);
    expect(strip?.restRemainingMs).toBeUndefined();
  });

  it('numbers the set after the ones already closed for this exercise', () => {
    const strip = mapStoreToLiveStrip(setSources([0.6], [closedSet([0.6, 0.5])]), GOALS);

    expect(strip?.setNumber).toBe(2);
  });

  it('labels the load in the display unit', () => {
    const strip = mapStoreToLiveStrip({ ...setSources([0.6]), displayUnit: 'kg' }, GOALS);

    expect(strip?.loadLabel).toBe('64 kg');
  });
});

describe('mapStoreToLiveStrip: rest', () => {
  it('counts down the prescribed rest and names the NEXT set', () => {
    const strip = mapStoreToLiveStrip(restSources([closedSet([0.6, 0.55])], 30_000), GOALS);

    expect(strip).toMatchObject({
      state: 'rest',
      setNumber: 2,
      setCount: 4,
      loadLabel: '135 lb',
      restRemainingMs: 60_000,
      restDurationMs: 90_000,
    });
    expect(strip?.reps.map((r) => r.velocity)).toEqual([0.6, 0.55]);
  });

  it('disappears once the rest has run out', () => {
    expect(mapStoreToLiveStrip(restSources([closedSet([0.6])], 90_000), GOALS)).toBeNull();
  });

  it('hides when the plan prescribes no rest length (provisional)', () => {
    const sources = {
      ...restSources([closedSet([0.6])], 1000),
      prescription: prescription({ restSec: undefined }),
    };

    expect(mapStoreToLiveStrip(sources, GOALS)).toBeNull();
  });
});

describe('mapStoreToLiveStrip: when it renders nothing', () => {
  it('renders nothing on the live page itself', () => {
    expect(mapStoreToLiveStrip(setSources([0.6]), { name: 'live' })).toBeNull();
  });

  it('shows on every other route', () => {
    const routes: Route[] = [
      { name: 'plan' },
      { name: 'goals' },
      { name: 'body' },
      { name: 'summary', sessionId: 'latest' },
    ];
    for (const route of routes) {
      expect(mapStoreToLiveStrip(setSources([0.6]), route)?.state).toBe('set');
    }
  });

  it('renders nothing when a session is open but no set or rest runs', () => {
    const idle = { ...restSources([], 0), accumulator: initialAccumulatorState() };
    expect(mapStoreToLiveStrip(idle, GOALS)).toBeNull();
  });

  it('renders nothing with no session or before the first snapshot', () => {
    const noSession = {
      ...setSources([0.6]),
      snapshot: { ...snapshot(reps([0.6])), session: null },
    };

    expect(mapStoreToLiveStrip(noSession, GOALS)).toBeNull();
    expect(mapStoreToLiveStrip({ ...setSources([0.6]), snapshot: null }, GOALS)).toBeNull();
  });

  it('hides without a plan rather than inventing a set count (provisional)', () => {
    const unplanned = { ...setSources([0.6]), prescription: null };

    expect(mapStoreToLiveStrip(unplanned, GOALS)).toBeNull();
    expect(
      mapStoreToLiveStrip({ ...restSources([closedSet([0.6])], 0), prescription: null }, GOALS),
    ).toBeNull();
  });
});

describe('mapStoreToLiveStrip: analytics pass-through', () => {
  it("gives each rep workout-analytics' zone for its mean velocity", () => {
    const velocities = [0.3, 0.4, 0.6, 0.9, 1.2];
    const strip = mapStoreToLiveStrip(setSources(velocities), GOALS);

    expect(strip?.reps.map((r) => r.zone)).toEqual([
      'grinding',
      'maximalStrength',
      'strengthSpeed',
      'power',
      'speed',
    ]);
    expect(strip?.reps.map((r) => r.zone)).toEqual(velocities.map((v) => categorizeVelocity(v)));
  });

  it('is fatigued exactly when the live aura reads stop (30% loss or more)', () => {
    expect(mapStoreToLiveStrip(setSources([1.0, 0.7]), GOALS)?.isFatigued).toBe(true);
    expect(mapStoreToLiveStrip(setSources([1.0, 0.75]), GOALS)?.isFatigued).toBe(false);
  });

  it('carries the finished set’s fatigue into the rest', () => {
    const strip = mapStoreToLiveStrip(restSources([closedSet([1.0, 0.6])], 1000), GOALS);

    expect(strip?.isFatigued).toBe(true);
  });
});
