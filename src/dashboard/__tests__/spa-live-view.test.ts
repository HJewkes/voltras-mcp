// Unit tests for the store→live-page read-model mapper (VW-42/44/51).
//
// Focus: fields that reach the ported north-star live page from a REAL source, and
// the contract that a field with no source stays null so the view hides it rather
// than rendering a fabricated number. Pure projection — no DOM, no I/O.

import { describe, expect, it } from 'vitest';

import type { Rep } from '@voltras/workout-analytics';

import {
  initialAccumulatorState,
  type CompletedSet as StoreCompletedSet,
  type PrescriptionView,
  type Snapshot,
} from '../spa/adapter.js';
import { type LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import {
  deriveActiveSetStates,
  derivePrescription,
  deriveRailExercises,
  deriveRailMetrics,
  peakVelocity,
  velocityLossPct,
  type CompletedSet,
  type DashboardModel,
  type PlannedExerciseModel,
  type SessionModel,
} from '../spa/live-page/model.js';
import { mapStoreToDashboardModel, type LiveViewSources } from '../spa/panels/live-view.js';

/** A session read-model with honest empty defaults, overridable per test. */
function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    weightLbs: 140,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: null,
    targetReps: null,
    ...over,
  };
}

/** Wrap a session in a rest-state (no live overlay) dashboard model. */
function railModel(session: SessionModel): DashboardModel {
  return { live: null, session, restElapsedMs: null };
}

/** A completed set tagged with the exercise that owned it (VW-50). */
function completed(exerciseName: string, repCount: number, weightLbs = 100): CompletedSet {
  return { exerciseName, weightLbs, mode: 'weight', repCount, reps: [], peakForceLbs: null };
}

/** A snapshot with an active session and no device/set activity. */
function snapshot(): Snapshot {
  return {
    session: { sessionId: 's1', exerciseName: 'Cable Chest Press' },
    devices: [],
    sets: { active: null },
  };
}

/** A live overlay carrying one finalized rep. */
function liveWithRep(rom: number, peakForce = 0): StoreLiveModel {
  return {
    connected: true,
    phase: 'con',
    phaseElapsedMs: 400,
    velocity: 0.42,
    position: 120,
    force: 480,
    repInProgress: 2,
    lastRep: { repIndex: 1, vCon: 0.41, rom, peakVelocity: 0.6, peakForceSoFar: peakForce },
    peakForce,
  };
}

function sources(over: Partial<LiveViewSources> = {}): LiveViewSources {
  return {
    snapshot: snapshot(),
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
    ...over,
  };
}

describe('mapStoreToDashboardModel', () => {
  describe('lastRep.rom (VW-44)', () => {
    it('surfaces the finalized rep range of motion in metres', () => {
      const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58) }));
      expect(model?.live?.lastRep?.rom).toBe(0.58);
    });

    it('reports no last rep before the first rep of a set lands', () => {
      const live: StoreLiveModel = { ...liveWithRep(0.58), lastRep: null };
      const model = mapStoreToDashboardModel(sources({ live }));
      expect(model?.live?.lastRep).toBeNull();
    });
  });

  describe('live.peakForce (VW-45)', () => {
    it('carries the set-level peak concentric force onto the live model', () => {
      const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58, 542) }));
      expect(model?.live?.peakForce).toBe(542);
    });

    it('has no live model at all when nothing is streaming', () => {
      const model = mapStoreToDashboardModel(sources({ live: null }));
      expect(model?.live).toBeNull();
    });
  });

  describe('session.plannedSets (VW-42)', () => {
    it('surfaces the prescribed set count when the session has a plan', () => {
      const prescription: PrescriptionView = { sets: 4 };
      const model = mapStoreToDashboardModel(sources({ prescription }));
      expect(model?.session.plannedSets).toBe(4);
    });

    it('leaves the set count null when the session carries no plan', () => {
      const model = mapStoreToDashboardModel(sources());
      expect(model?.session.plannedSets).toBeNull();
    });
  });

  describe('session.tempo (VW-41)', () => {
    it('carries the prescription target tempo tuple onto the session model', () => {
      const prescription: PrescriptionView = { sets: 4, tempo: [3, 0, 1, 0] };
      const model = mapStoreToDashboardModel(sources({ prescription }));
      expect(model?.session.tempo).toEqual([3, 0, 1, 0]);
    });

    it('leaves the tempo undefined when the prescription carries none', () => {
      const model = mapStoreToDashboardModel(sources({ prescription: { sets: 4 } }));
      expect(model?.session.tempo).toBeUndefined();
    });

    it('leaves the tempo undefined when the session carries no plan', () => {
      const model = mapStoreToDashboardModel(sources());
      expect(model?.session.tempo).toBeUndefined();
    });
  });

  describe('session.restSec (VW-51)', () => {
    it('carries the prescribed inter-set rest onto the session model', () => {
      const model = mapStoreToDashboardModel(sources({ prescription: { sets: 4, restSec: 120 } }));
      expect(model?.session.restSec).toBe(120);
    });

    it('leaves rest null when the prescription carries none', () => {
      const model = mapStoreToDashboardModel(sources({ prescription: { sets: 4 } }));
      expect(model?.session.restSec).toBeNull();
    });

    it('leaves rest null when the session carries no plan', () => {
      const model = mapStoreToDashboardModel(sources());
      expect(model?.session.restSec).toBeNull();
    });
  });

  describe('restElapsedMs (VW-60)', () => {
    it('reports the count-up since the last set closed (nowMs − restStartMs)', () => {
      const accumulator = { ...initialAccumulatorState(), restStartMs: 1_000 };
      const model = mapStoreToDashboardModel(sources({ accumulator, nowMs: 46_000 }));
      expect(model?.restElapsedMs).toBe(45_000);
    });

    it('clamps a backwards clock to zero rather than a negative elapsed', () => {
      const accumulator = { ...initialAccumulatorState(), restStartMs: 5_000 };
      const model = mapStoreToDashboardModel(sources({ accumulator, nowMs: 4_000 }));
      expect(model?.restElapsedMs).toBe(0);
    });

    it('is null before any set has closed (no rest clock running)', () => {
      const model = mapStoreToDashboardModel(sources({ nowMs: 46_000 }));
      expect(model?.restElapsedMs).toBeNull();
    });
  });

  describe('session.plannedExercises (VW-49)', () => {
    it('maps the ordered planned-exercise list, formatting rep ranges', () => {
      const prescription: PrescriptionView = {
        sets: 3,
        exercises: [
          { name: 'Squat', order: 0, sets: 3, repsLow: 5, active: false },
          {
            name: 'Bench',
            order: 1,
            sets: 3,
            repsLow: 8,
            repsHigh: 10,
            weightLbs: 135,
            active: true,
          },
        ],
      };
      const model = mapStoreToDashboardModel(sources({ prescription }));
      expect(model?.session.plannedExercises).toEqual([
        {
          name: 'Squat',
          plannedSets: 3,
          targetReps: 5,
          repsLabel: 5,
          weightLbs: null,
          active: false,
        },
        {
          name: 'Bench',
          plannedSets: 3,
          targetReps: 8,
          repsLabel: '8–10',
          weightLbs: 135,
          active: true,
        },
      ]);
    });

    it('leaves the list empty when the session carries no plan', () => {
      const model = mapStoreToDashboardModel(sources());
      expect(model?.session.plannedExercises).toEqual([]);
    });
  });
});

describe('deriveRailExercises — per-exercise completed sets (VW-50)', () => {
  it('counts only the active exercise’s own sets when the log spans exercises', () => {
    const session = sessionModel({
      exerciseName: 'Exercise B',
      completedSets: [
        completed('Exercise A', 8),
        completed('Exercise A', 8),
        completed('Exercise B', 8),
      ],
    });
    const [row] = deriveRailExercises(railModel(session));
    // Two of the three logged sets belong to Exercise A; only the one on B counts here.
    expect(row.setStates.filter((s) => s.status === 'done')).toHaveLength(1);
  });
});

describe('deriveRailExercises — planned-exercise list (VW-49)', () => {
  it('renders done / active / upcoming rows in plan order', () => {
    const session = sessionModel({
      exerciseName: 'Bench',
      completedSets: [completed('Squat', 5)],
      plannedExercises: [
        {
          name: 'Squat',
          plannedSets: 3,
          targetReps: 5,
          repsLabel: 5,
          weightLbs: 225,
          active: false,
        },
        {
          name: 'Bench',
          plannedSets: 3,
          targetReps: 8,
          repsLabel: '8–10',
          weightLbs: 135,
          active: true,
        },
        {
          name: 'Row',
          plannedSets: 3,
          targetReps: 10,
          repsLabel: '10–12',
          weightLbs: 95,
          active: false,
        },
      ],
    });
    const rows = deriveRailExercises(railModel(session));
    expect(rows.map((r) => r.name)).toEqual(['Squat', 'Bench', 'Row']);
    // Squat precedes the active exercise: a done row (not dimmed) carrying its logged set.
    expect(rows[0].upcoming).toBeUndefined();
    expect(rows[0].setStates.filter((s) => s.status === 'done')).toHaveLength(1);
    // Bench is the active exercise — never dimmed.
    expect(rows[1].upcoming).toBeUndefined();
    // Row follows the active exercise: dimmed, with todo columns sized to its plan.
    expect(rows[2].upcoming).toBe(true);
    expect(rows[2].setStates).toHaveLength(3);
    expect(rows[2].setStates.every((s) => s.status === 'todo')).toBe(true);
  });

  it('shows only the active exercise when no plan is attached', () => {
    const rows = deriveRailExercises(railModel(sessionModel({ exerciseName: 'Bench' })));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Bench');
  });

  it('converts the active row summary weight to the chosen display unit (VW-63)', () => {
    const session = sessionModel({ exerciseName: 'Bench', weightLbs: 140 });
    const [lbsRow] = deriveRailExercises(railModel(session), 'lbs');
    expect(lbsRow.summary).toMatchObject({ weight: 140, unit: 'lbs' });
    const [kgRow] = deriveRailExercises(railModel(session), 'kg');
    // 140 lb → 63.5 kg → 64.
    expect(kgRow.summary).toMatchObject({ weight: 64, unit: 'kg' });
  });
});

describe('deriveRailMetrics — session rollup tiles (VW-52)', () => {
  it('folds Volume (Σ reps) and Tonnage (Σ reps×weight) over the whole session', () => {
    const session = sessionModel({
      exerciseName: 'Bench',
      completedSets: [completed('Squat', 5, 200), completed('Bench', 8, 135)],
    });
    // 13 reps; 5*200 + 8*135 = 2080 lbs → "2.1k". The Tonnage tile suffixes its unit (VW-63).
    expect(deriveRailMetrics(railModel(session))).toEqual([
      { label: 'Volume', value: '13' },
      { label: 'Tonnage', value: '2.1k lbs' },
    ]);
  });

  it('labels the Σ reps×weight tile "Tonnage", not "Load" — the verdict "Load" is the weight', () => {
    // Disambiguation: the rail tonnage total and the verdict working-weight tile must not
    // share the word "Load" (they are different quantities — 200 lbs of tonnage vs 20 lbs).
    const session = sessionModel({ completedSets: [completed('Bench', 8, 135)] });
    expect(deriveRailMetrics(railModel(session))?.map((t) => t.label)).not.toContain('Load');
  });

  it('converts the Tonnage total to kg while leaving Volume (a rep count) untouched (VW-63)', () => {
    const session = sessionModel({
      exerciseName: 'Bench',
      completedSets: [completed('Squat', 5, 200), completed('Bench', 8, 135)],
    });
    // 2080 lbs × 0.45359237 = 943.5 kg → "943 kg"; the 13-rep Volume is unit-invariant.
    expect(deriveRailMetrics(railModel(session), 'kg')).toEqual([
      { label: 'Volume', value: '13' },
      { label: 'Tonnage', value: '943 kg' },
    ]);
  });

  it('omits the tiles entirely before any set closes', () => {
    expect(deriveRailMetrics(railModel(sessionModel()))).toBeNull();
  });

  it('surfaces no Fatigue tile — there is no honest session-wide fatigue signal', () => {
    const session = sessionModel({ completedSets: [completed('Bench', 8, 135)] });
    expect(deriveRailMetrics(railModel(session))?.map((t) => t.label)).toEqual([
      'Volume',
      'Tonnage',
    ]);
  });
});

describe('rest-recap derives (VW-60)', () => {
  describe('peakVelocity', () => {
    it('returns the fastest rep of the set', () => {
      expect(peakVelocity([0.55, 0.54, 0.52, 0.51])).toBe(0.55);
    });

    it('returns null for a set that logged no reps', () => {
      expect(peakVelocity([])).toBeNull();
    });
  });

  describe('velocityLossPct', () => {
    it('is the drop from the fastest rep to the last, as a percentage', () => {
      // best 0.5, last 0.4 → 20% loss.
      expect(velocityLossPct([0.5, 0.48, 0.45, 0.4])).toBeCloseTo(20, 5);
    });

    it('is null with fewer than two reps (no loss is computable from one point)', () => {
      expect(velocityLossPct([0.5])).toBeNull();
      expect(velocityLossPct([])).toBeNull();
    });

    it('clamps to zero when the last rep is the fastest (no loss, never negative)', () => {
      expect(velocityLossPct([0.4, 0.45, 0.5])).toBe(0);
    });
  });
});

describe('mapCompletedSet (VW-61 / VW-62)', () => {
  /** A closed store set carrying WA reps, injected via the accumulator's set log. */
  function storeSet(reps: Rep[], peakForceLbs: number | null): StoreCompletedSet {
    return {
      weightLbs: 140,
      mode: 'weight',
      repCount: reps.length,
      exerciseName: 'Cable Chest Press',
      bestPeakVelocityMms: null,
      peakForceLbs,
      reps,
    };
  }

  /** A rep whose MEAN concentric velocity (500 mm/s) differs from its PEAK (800). */
  function repMeanVsPeak(repNumber: number): Rep {
    return {
      repNumber,
      concentric: { peakVelocity: 800, _totalVelocity: 500, _movementSampleCount: 1 },
      eccentric: {},
    } as unknown as Rep;
  }

  function modelWithSet(set: StoreCompletedSet): CompletedSet {
    const accumulator = { ...initialAccumulatorState(), setLog: [set] };
    const model = mapStoreToDashboardModel(sources({ accumulator }));
    return model!.session.completedSets[0];
  }

  it('carries the set-close peak concentric force through to the view model (VW-61)', () => {
    expect(modelWithSet(storeSet([repMeanVsPeak(1)], 511)).peakForceLbs).toBe(511);
  });

  it('carries a null peak force through unchanged (hidden, never faked)', () => {
    expect(modelWithSet(storeSet([repMeanVsPeak(1)], null)).peakForceLbs).toBeNull();
  });

  it('builds the recap bars from MEAN concentric velocity, not peak (VW-62)', () => {
    // Mean is 500 mm/s → 0.5 m/s; peak is 800 → 0.8. The bars must read the mean so a
    // closing set does not flip peak→mean vs the live strip.
    expect(modelWithSet(storeSet([repMeanVsPeak(1)], null)).reps).toEqual([0.5]);
  });
});

describe('deriveRailExercises', () => {
  it('pads the set strip with todo sets up to the prescribed count', () => {
    const model = mapStoreToDashboardModel(
      sources({ live: liveWithRep(0.58), prescription: { sets: 3 } }),
    );
    // No rep target is configured, so a `todo` set cannot state its expected reps and
    // the strip honestly stops at the active set rather than guessing.
    const [exercise] = deriveRailExercises(model!);
    // summary.sets is PROGRESS now (VW-68): sets banked + the one in progress, not the
    // prescribed count — 0 done + 1 active = 1, regardless of the plan's 3.
    expect(exercise.summary.sets).toBe(1);
    expect(exercise.setStates.filter((s) => s.status === 'todo')).toHaveLength(0);
  });

  it('counts the in-progress set toward summary progress when no plan is attached', () => {
    const model = mapStoreToDashboardModel(sources({ live: liveWithRep(0.58) }));
    const [exercise] = deriveRailExercises(model!);
    // 0 completed + 1 active set in progress = 1 (VW-68 progress aggregate).
    expect(exercise.summary.sets).toBe(1);
  });
});

describe('0-rep force-closed sets are filtered from the wall (bench finding)', () => {
  /** A store set-log entry with a given rep count, tagged to the active exercise. */
  function storeSet(repCount: number, weightLbs = 20): StoreCompletedSet {
    return {
      weightLbs,
      mode: 'weight',
      repCount,
      exerciseName: 'Cable Chest Press',
      bestPeakVelocityMms: null,
      peakForceLbs: null,
      reps: [],
    };
  }

  /** Model built from a set log of a real set followed by an armed-then-abandoned empty. */
  function modelWithTimeoutSet(): DashboardModel {
    const accumulator = {
      ...initialAccumulatorState(),
      setLog: [storeSet(10), storeSet(0)],
    };
    return mapStoreToDashboardModel(sources({ accumulator }))!;
  }

  it('keeps only the real set in the read-model — the 0-rep timeout set is dropped', () => {
    const model = modelWithTimeoutSet();
    expect(model.session.completedSets).toHaveLength(1);
    expect(model.session.completedSets[0].repCount).toBe(10);
  });

  it('counts one set in the rail tally, not two', () => {
    const [exercise] = deriveRailExercises(modelWithTimeoutSet());
    expect(exercise.summary.sets).toBe(1);
    expect(exercise.setStates).toHaveLength(1);
  });

  it('folds only the real set into the session rollup tiles', () => {
    // Real set alone: 10 reps, 10×20 = 200 lbs tonnage → "200 lbs" (the empty set adds nothing).
    expect(deriveRailMetrics(railModel(modelWithTimeoutSet().session))).toEqual([
      { label: 'Volume', value: '10' },
      { label: 'Tonnage', value: '200 lbs' },
    ]);
  });

  it('a set the lifter actually worked keeps showing (repCount ≥ 1)', () => {
    const accumulator = { ...initialAccumulatorState(), setLog: [storeSet(1)] };
    const model = mapStoreToDashboardModel(sources({ accumulator }))!;
    expect(model.session.completedSets).toHaveLength(1);
  });
});

describe('derivePrescription — the page header lockup (VW-42)', () => {
  /** The active planned exercise, as `panels/live-view.ts` maps it from the prescription. */
  function planned(over: Partial<PlannedExerciseModel> = {}): PlannedExerciseModel {
    return {
      name: 'Cable Chest Press',
      plannedSets: 4,
      targetReps: 8,
      repsLabel: '8',
      weightLbs: 140,
      active: true,
      ...over,
    };
  }

  it('reads the rep target from the PLAN when the device registered no set watch', () => {
    // The regression: a fully planned 4 × 8 rendered NOTHING, because `targetReps` is
    // device-sourced (`resolveRepTarget` reads `set.watch.notifyOn`) and an unarmed set
    // leaves it null while the coach's rep target sits unused in the prescription.
    const cells = derivePrescription(
      sessionModel({ plannedSets: 4, targetReps: null, plannedExercises: [planned()] }),
    );
    expect(cells).toEqual({ sets: 4, reps: '8', load: 140, unit: 'lbs' });
  });

  it('keeps a prescribed rep RANGE as a range', () => {
    // Collapsing 8–10 to its floor would state a prescription the coach did not write.
    const cells = derivePrescription(
      sessionModel({
        plannedSets: 4,
        targetReps: null,
        plannedExercises: [planned({ repsLabel: '8–10' })],
      }),
    );
    expect(cells?.reps).toBe('8–10');
  });

  it('prefers the plan over the device set watch when the two disagree', () => {
    const cells = derivePrescription(
      sessionModel({ plannedSets: 4, targetReps: 5, plannedExercises: [planned()] }),
    );
    expect(cells?.reps).toBe('8');
  });

  it('ignores a planned exercise that is not the active one', () => {
    const cells = derivePrescription(
      sessionModel({
        plannedSets: 4,
        targetReps: null,
        plannedExercises: [planned({ active: false })],
      }),
    );
    expect(cells).toBeNull();
  });

  it('prefers the PRESCRIBED load over the live cascade weight', () => {
    // The live pin weight is the ACTUAL load and already shows in the rail summary; this
    // line is the target. Under mock the cascade never reports, so plan-first is also the
    // difference between showing `@ 140 lbs` and showing `@ — lbs`.
    const cells = derivePrescription(
      sessionModel({
        plannedSets: 4,
        weightLbs: 135,
        plannedExercises: [planned({ weightLbs: 140 })],
      }),
    );
    expect(cells?.load).toBe(140);
  });

  it('falls back to the live cascade weight when the plan prescribes no load', () => {
    const cells = derivePrescription(
      sessionModel({
        plannedSets: 4,
        weightLbs: 135,
        plannedExercises: [planned({ weightLbs: null })],
      }),
    );
    expect(cells?.load).toBe(135);
  });

  it('falls back to the device set watch for an unplanned but armed session', () => {
    expect(derivePrescription(sessionModel({ plannedSets: 3, targetReps: 6 }))?.reps).toBe(6);
  });

  it('reads sets × reps @ load when the plan states all three', () => {
    expect(
      derivePrescription(sessionModel({ plannedSets: 4, targetReps: 8, weightLbs: 140 })),
    ).toEqual({ sets: 4, reps: 8, load: 140, unit: 'lbs' });
  });

  it('keeps the prescription and marks an unset load with the em-dash', () => {
    // A discovery set (no prescribed weight) still has a real 4 × 8 claim to show;
    // dropping the whole lockup for a missing load would hide what the coach wrote.
    expect(
      derivePrescription(sessionModel({ plannedSets: 4, targetReps: 8, weightLbs: null })),
    ).toEqual({ sets: 4, reps: 8, load: '—', unit: 'lbs' });
  });

  it('returns null when no rep target is prescribed', () => {
    // The regression: `plannedSets: 1` with no rep target used to render `1 × —`,
    // which states a prescription the store never had.
    expect(derivePrescription(sessionModel({ plannedSets: 1, targetReps: null }))).toBeNull();
  });

  it('returns null when no set count is prescribed', () => {
    expect(derivePrescription(sessionModel({ plannedSets: null, targetReps: 8 }))).toBeNull();
  });

  it('converts the load to the display unit', () => {
    const cells = derivePrescription(
      sessionModel({ plannedSets: 3, targetReps: 10, weightLbs: 100 }),
      'kg',
    );
    expect(cells?.unit).toBe('kg');
    expect(cells?.load).not.toBe(100);
  });
});

describe('deriveActiveSetStates — shared by the rail row and the page header', () => {
  it('returns the same strip the rail row renders', () => {
    const model = mapStoreToDashboardModel(
      sources({ live: liveWithRep(0.58), prescription: { sets: 3, repsLow: 8 } }),
    );
    const [exercise] = deriveRailExercises(model!);
    expect(deriveActiveSetStates(model!)).toEqual(exercise.setStates);
  });

  it('is empty with no sets done and none in progress, so the header hides its strip', () => {
    expect(deriveActiveSetStates(railModel(sessionModel()))).toEqual([]);
  });
});

describe('set-strip columns read the PLAN rep target, not just the device watch', () => {
  /** A live model on a planned exercise: `plannedSets` sets of `targetReps`, one set live. */
  function plannedLive(over: Partial<SessionModel> = {}): DashboardModel {
    return {
      live: {
        connected: true,
        phase: 'con',
        phaseElapsedMs: 0,
        velocity: 0.5,
        position: 0,
        force: 0,
        repVelocities: [0.6, 0.5],
        velocityLossPct: null,
        lastRep: null,
        peakForce: null,
      },
      restElapsedMs: null,
      session: sessionModel({
        plannedSets: 3,
        targetReps: null,
        plannedExercises: [
          {
            name: 'Cable Chest Press',
            plannedSets: 3,
            targetReps: 8,
            repsLabel: '8',
            weightLbs: 140,
            active: true,
          },
        ],
        ...over,
      }),
    };
  }

  it('sizes the active column and emits todo sets from the plan with no device watch', () => {
    // The regression: `targetReps` is device-only, so a fully planned session produced one
    // full-width active bar and NO upcoming columns while the header claimed 3 × 8.
    const states = deriveActiveSetStates(plannedLive());
    expect(states.map((s) => s.status)).toEqual(['active', 'todo', 'todo']);
    expect(states[0]).toMatchObject({ planned: 8 });
    expect(states[1]).toMatchObject({ planned: 8 });
  });

  it('still emits no todo columns when neither the plan nor the device states a rep target', () => {
    const states = deriveActiveSetStates(plannedLive({ plannedExercises: [] }));
    expect(states.map((s) => s.status)).toEqual(['active']);
    // No rep target anywhere ⇒ the column is the reps actually landed, never a guess.
    expect(states[0]).toMatchObject({ planned: 2 });
  });
});

describe('set-strip velocities are normalized to the ratio domain titan bands on', () => {
  it("scales each rep against the set's own best, so the best rep reads 1", () => {
    // Raw m/s (0.4–0.8 on a real set) all fell under velocityZoneColor's 0.75 cut, so
    // every set painted orange-red regardless of how it went.
    const model = railModel(
      sessionModel({
        completedSets: [
          {
            exerciseName: 'Cable Chest Press',
            weightLbs: 140,
            mode: 'weight',
            repCount: 3,
            reps: [0.8, 0.6, 0.4],
            peakForceLbs: null,
          },
        ],
      }),
    );
    const [set] = deriveActiveSetStates(model);
    const velocities = 'velocities' in set ? set.velocities : [];
    expect(velocities[0]).toBe(1);
    expect(velocities[1]).toBeCloseTo(0.75, 10);
    expect(velocities[2]).toBeCloseTo(0.5, 10);
  });

  it('normalizes each set independently, not against the session', () => {
    const model = railModel(
      sessionModel({
        completedSets: [
          {
            exerciseName: 'Cable Chest Press',
            weightLbs: 140,
            mode: 'weight',
            repCount: 2,
            reps: [1, 0.5],
            peakForceLbs: null,
          },
          {
            exerciseName: 'Cable Chest Press',
            weightLbs: 140,
            mode: 'weight',
            repCount: 2,
            reps: [0.4, 0.2],
            peakForceLbs: null,
          },
        ],
      }),
    );
    const [first, second] = deriveActiveSetStates(model);
    // The slower set opens green too: the strip reads WITHIN-set decay, not absolute speed.
    expect(first).toMatchObject({ velocities: [1, 0.5] });
    expect(second).toMatchObject({ velocities: [1, 0.5] });
  });

  it('passes velocities through unscaled when no usable velocity landed', () => {
    const model = railModel(
      sessionModel({
        completedSets: [
          {
            exerciseName: 'Cable Chest Press',
            weightLbs: 140,
            mode: 'weight',
            repCount: 2,
            reps: [0, 0],
            peakForceLbs: null,
          },
        ],
      }),
    );
    expect(deriveActiveSetStates(model)[0]).toMatchObject({ velocities: [0, 0] });
  });
});
