// Unit tests for the pinned live strip mapper (VW-429): which routes and phases show the
// strip, what it counts, and that bar bands and fatigue come from the same sources the live page
// reads. Real WA reps, so velocities take the same path `/api/snapshot` reps take.

import { describe, expect, it } from 'vitest';
import {
  addSampleToSet,
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
import type { ResolvedRest } from '../../analytics/rest-defaults.js';
import { setFatigueState } from '../spa/live-page/fatigue-state.js';
import { velocityLossPct } from '../spa/live-page/model.js';
import { mapStoreToFatigueModel } from '../spa/panels/fatigue-view.js';
import { mapStoreToDashboardModel } from '../spa/panels/live-view.js';
import type { LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import type { TrainingIntent } from '../../schemas/set.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

const EXERCISE = 'Cable Chest Press';
const GOALS: Route = { name: 'goals' };

/** A rep whose mean concentric velocity is exactly `mps`. */
function repSamples(mps: number, seq: number, t0: number, rom = 0.5): WorkoutSample[] {
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
    sample(1, 500, MovementPhase.CONCENTRIC, rom),
    sample(2, 600, MovementPhase.ECCENTRIC, rom),
    sample(3, 1600, MovementPhase.ECCENTRIC, 0),
  ];
}

function reps(velocities: number[], roms: number[] = []): Rep[] {
  let set = createSet();
  velocities.forEach((mps, i) => {
    for (const s of repSamples(mps, i * 4, 1000 + i * 2000, roms[i])) set = addSampleToSet(set, s);
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

/** The server-resolved rest (VW-441); the plan's 90 s unless a test says otherwise. */
function resolvedRest(over: Partial<ResolvedRest> = {}): ResolvedRest {
  return {
    seconds: 90,
    source: 'explicit_plan',
    intent: null,
    prevRepsToThreshold: null,
    currRepsToThreshold: null,
    extensionSeconds: 0,
    ...over,
  };
}

function snapshot(activeReps: Rep[] | null, rest: ResolvedRest | null = resolvedRest()): Snapshot {
  const active = activeReps === null ? null : { reps: activeReps };
  return {
    session: { sessionId: 's1', exerciseName: EXERCISE },
    devices: [{ slotId: 'primary', device: { connected: true, weightLbs: 140 }, sets: { active } }],
    sets: { active },
    rest,
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

  it('counts down a derived rest when the plan prescribes no length', () => {
    const sources = {
      ...restSources([closedSet([0.6])], 1000),
      snapshot: snapshot(null, resolvedRest({ seconds: 105, source: 'intent_default' })),
      prescription: prescription({ restSec: undefined }),
    };

    expect(mapStoreToLiveStrip(sources, GOALS)).toMatchObject({
      state: 'rest',
      restDurationMs: 105_000,
      restRemainingMs: 104_000,
    });
  });

  it('hides when no rest resolved (no session on the server)', () => {
    const sources = { ...restSources([closedSet([0.6])], 1000), snapshot: snapshot(null, null) };

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
  it("passes the set's stop bands, so its bars colour like the live hero's", () => {
    const strength = {
      ...setSources([0.6, 0.55]),
      snapshot: { ...snapshot(reps([0.6, 0.55])), fatigueStop: exerciseFatigueStop('strength') },
    };

    expect(mapStoreToLiveStrip(strength, GOALS)?.lossThresholds).toEqual([6.7, 13.3, 20]);
  });

  it("colours a rest by the closed set's own stop, not the exercise's", () => {
    const watched = {
      ...closedSet([0.6, 0.5]),
      watch: { notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25 }] },
    };
    const sources = restSources([watched], 1000);
    const strip = mapStoreToLiveStrip(
      {
        ...sources,
        snapshot: { ...sources.snapshot!, fatigueStop: exerciseFatigueStop('strength') },
      },
      GOALS,
    );

    expect(strip?.lossThresholds).toEqual([8.3, 16.7, 25]);
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

describe('the strip and the live page agree (VW-440, VW-441)', () => {
  const LIVE: StoreLiveModel = {
    connected: true,
    phase: 'con',
    phaseElapsedMs: 0,
    velocity: 0.5,
    position: 0,
    force: 0,
    repInProgress: 2,
    lastRep: null,
    peakForce: 0,
  };
  const WATCH_40 = {
    notifyOn: [{ type: 'velocity_loss_exceeded', pct: 40, thresholdSource: 'explicit' as const }],
  };

  interface Case {
    intent?: TrainingIntent;
    watch?: typeof WATCH_40;
    rest: ResolvedRest;
  }

  const CASES: [string, Case, number[]][] = [
    [
      'strength',
      { intent: 'strength', rest: resolvedRest({ seconds: 150, source: 'intent_default' }) },
      [12, 14, 22],
    ],
    [
      'power',
      { intent: 'power', rest: resolvedRest({ seconds: 120, source: 'intent_default' }) },
      [5, 7, 12],
    ],
    [
      'hypertrophy',
      {
        intent: 'hypertrophy',
        rest: resolvedRest({
          seconds: 135,
          source: 'intent_default_extended',
          extensionSeconds: 30,
        }),
      },
      [15, 22, 32],
    ],
    [
      'no plan intent',
      { rest: resolvedRest({ seconds: 120, source: 'intent_default' }) },
      [15, 22, 32],
    ],
    [
      'an explicit 40% watch',
      { intent: 'hypertrophy', watch: WATCH_40, rest: resolvedRest() },
      [22, 32, 42],
    ],
  ];

  function losing(lossPct: number): number[] {
    return [1, 1 - lossPct / 100];
  }

  function sourcesFor(c: Case, active: Rep[] | null, done: CompletedSet[]): LiveViewSources {
    const activeSet =
      active === null ? null : { reps: active, ...(c.watch ? { watch: c.watch } : {}) };
    return {
      snapshot: {
        ...snapshot(null, c.rest),
        devices: [{ slotId: 'primary', device: { connected: true }, sets: { active: activeSet } }],
        sets: { active: activeSet },
        fatigueStop: exerciseFatigueStop(c.intent),
      },
      accumulator: { ...initialAccumulatorState(), setLog: done, restStartMs: active ? null : 0 },
      live: active ? LIVE : null,
      prescription: prescription(),
      nowMs: 1000,
    };
  }

  it.each(CASES)('mid-set, a %s set turns red on both at the same loss', (_name, c, losses) => {
    for (const lossPct of losses) {
      const sources = sourcesFor(c, reps(losing(lossPct)), []);
      const live = mapStoreToDashboardModel(sources)!.live!;
      const page = setFatigueState({
        lossPct: live.velocityLossPct,
        stop: live.fatigueStop,
        verdict: mapStoreToFatigueModel(sources)?.verdict ?? null,
      });

      const strip = mapStoreToLiveStrip(sources, GOALS);
      expect(strip?.isFatigued, `${lossPct}%`).toBe(page === 'stop');
      // The hero and both dual wings read `live.fatigueStop.bands`; the strip must get the same.
      expect(strip?.lossThresholds).toEqual(live.fatigueStop.bands);
      expect(strip?.lossThresholds).toEqual(
        c.watch ? [13.3, 26.7, 40] : exerciseFatigueStop(c.intent).bands,
      );
    }
  });

  it.each(CASES)(
    'resting after a %s set, both read the same fatigue and rest',
    (_name, c, losses) => {
      for (const lossPct of losses) {
        const closed = { ...closedSet(losing(lossPct)), ...(c.watch ? { watch: c.watch } : {}) };
        const sources = sourcesFor(c, null, [closed]);
        const model = mapStoreToDashboardModel(sources)!;
        const last = model.session.completedSets[0];
        const page = setFatigueState({
          lossPct: velocityLossPct(last.reps),
          stop: last.fatigueStop,
          verdict: last.fatigueVerdict,
        });
        const strip = mapStoreToLiveStrip(sources, GOALS);

        expect(strip?.isFatigued, `${lossPct}%`).toBe(page === 'stop');
        expect(strip?.restDurationMs).toBe(model.session.restSec! * 1000);
        expect(strip?.restDurationMs).toBe(c.rest.seconds * 1000);
      }
    },
  );

  it('turns red on both when WA reads a form breakdown, whatever the loss', () => {
    const shortLastRep = reps([0.6, 0.6, 0.6, 0.6], [0.5, 0.5, 0.5, 0.2]);
    const sources = sourcesFor({ intent: 'hypertrophy', rest: resolvedRest() }, shortLastRep, []);
    const verdict = mapStoreToFatigueModel(sources)?.verdict ?? null;

    expect(verdict?.state).toBe('form-breakdown');
    expect(mapStoreToLiveStrip(sources, GOALS)?.isFatigued).toBe(true);
  });

  it('turns red at each goal’s own stop, not a shared one', () => {
    const at = (intent: TrainingIntent | undefined, lossPct: number) =>
      mapStoreToLiveStrip(
        sourcesFor({ intent, rest: resolvedRest() }, reps(losing(lossPct)), []),
        GOALS,
      )?.isFatigued;

    expect([at('power', 12), at('strength', 22), at('hypertrophy', 22), at(undefined, 32)]).toEqual(
      [true, true, false, true],
    );
  });
});
