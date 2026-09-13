// VW-300: the prescriptive load-drift flag.
//
// The fixture below is the Jimenez-Reyes et al. 2021 pattern this check
// exists to catch: a lifter calibrates a clean load-velocity line, a fixed
// absolute load is programmed as 80% of the e1RM that line implies, and by
// the time the lifter is measured at that same load their velocity has risen
// to what the line says a ~64%-1RM load should produce. Nothing about the
// load on the plan changed; the %1RM it represents did.

import { describe, expect, it } from 'vitest';
import {
  addSampleToSet,
  buildProfile,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

import {
  LOAD_DRIFT_THRESHOLD_PP,
  checkLoadDrift,
  evaluateLoadDrift,
  loadMatchesPrescription,
  type LoadDriftStore,
} from '../load-drift.js';
import { LOCAL_USER_ID, type StoredSet } from '../../store/types.js';

/**
 * A clean, perfectly linear calibration line: v = -0.004 * load + 1.10.
 * `buildProfile` fits this exactly (R² = 1), and at the default 0.17 m/s MVT
 * (no stored baseline) solves to e1RM = 232.5 lbs.
 */
const CALIBRATION = [
  { load: 100, velocity: 0.7 },
  { load: 150, velocity: 0.5 },
  { load: 200, velocity: 0.3 },
];
const DEFAULT_MVT = 0.17;
const E1RM = 232.5;

/** 80% of {@link E1RM}, the load Jimenez-Reyes' fixed-absolute-load arm would program. */
const PROGRAMMED_LOAD_LBS = 0.8 * E1RM; // 186

/** What the calibration line predicts at `PROGRAMMED_LOAD_LBS` — the no-drift velocity. */
const MATCHED_VELOCITY_MPS = -0.004 * PROGRAMMED_LOAD_LBS + 1.1; // 0.356

/**
 * What the calibration line says a load worth 64% of {@link E1RM} would move
 * at — the velocity Jimenez-Reyes measured (0.88-0.91 m/s vs a 0.67-0.68 m/s
 * target) once the fixed load quietly became this light for the lifter.
 */
const DRIFTED_VELOCITY_MPS = -0.004 * (0.64 * E1RM) + 1.1; // 0.5048

function profile() {
  return buildProfile(
    CALIBRATION.map((p) => ({ load: p.load, velocity: p.velocity })),
    DEFAULT_MVT,
  );
}

describe('evaluateLoadDrift', () => {
  it('fires on the Jimenez-Reyes pattern: programmed 80%, measured velocity implies ~64%', () => {
    const flag = evaluateLoadDrift({
      profile: profile(),
      mvt: DEFAULT_MVT,
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredVelocityMps: DRIFTED_VELOCITY_MPS,
    });

    expect(flag).not.toBeNull();
    expect(flag?.programmedPct).toBeCloseTo(80, 1);
    expect(flag?.impliedPct).toBeCloseTo(64, 1);
    expect(flag?.deltaPct).toBeCloseTo(-16, 1);
    expect(flag?.reason).toContain('Jimenez-Reyes');
    expect(flag?.reason).toContain(`${LOAD_DRIFT_THRESHOLD_PP}-point threshold`);
  });

  it('does not fire on a matched-intensity replay: measured velocity still implies ~80%', () => {
    const flag = evaluateLoadDrift({
      profile: profile(),
      mvt: DEFAULT_MVT,
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredVelocityMps: MATCHED_VELOCITY_MPS,
    });

    expect(flag).toBeNull();
  });

  it('does not fire when the drift sits under the named threshold', () => {
    // A load worth 74% of e1RM instead of the programmed 80% — a 6-point
    // gap, under the 10-point threshold Jimenez-Reyes' 16-point failure sits
    // well clear of.
    const velocityAt74Pct = -0.004 * (0.74 * E1RM) + 1.1;
    const flag = evaluateLoadDrift({
      profile: profile(),
      mvt: DEFAULT_MVT,
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredVelocityMps: velocityAt74Pct,
    });

    expect(flag).toBeNull();
  });

  it('does not fire against a profile with a non-negative slope', () => {
    const flag = evaluateLoadDrift({
      profile: {
        dataPoints: [],
        slope: 0,
        intercept: 0.5,
        rSquared: 0,
        estimated1RM: 0,
        confidence: 'low',
        mvt: DEFAULT_MVT,
      },
      mvt: DEFAULT_MVT,
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredVelocityMps: DRIFTED_VELOCITY_MPS,
    });

    expect(flag).toBeNull();
  });
});

describe('loadMatchesPrescription', () => {
  it('matches within half a pound and rejects an unrelated load', () => {
    expect(loadMatchesPrescription(186, 186)).toBe(true);
    expect(loadMatchesPrescription(186.3, 186)).toBe(true);
    expect(loadMatchesPrescription(200, 186)).toBe(false);
    expect(loadMatchesPrescription(undefined, 186)).toBe(false);
  });
});

/**
 * Four samples spanning one rep's concentric + eccentric at a CONSTANT
 * velocity — same shape `dashboard/__tests__/session-summary.test.ts` uses —
 * so `getSetMeanVelocity` reads back exactly the velocity the fixture names.
 */
function repSamples(concVel: number, seq: number, t0: number): WorkoutSample[] {
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + 500,
      phase: MovementPhase.CONCENTRIC,
      position: 0.5,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + 600,
      phase: MovementPhase.ECCENTRIC,
      position: 0.5,
      velocity: concVel * 0.5,
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + 1600,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: concVel * 0.5,
      force: 80,
    },
  ];
}

function buildReps(repCount: number, velocity: number): Rep[] {
  let set = createSet();
  let t = 1000;
  for (let i = 0; i < repCount; i += 1) {
    for (const sample of repSamples(velocity, i * 4, t)) set = addSampleToSet(set, sample);
    t += 3000;
  }
  return [...set.reps];
}

function storedSet(id: string, loadLbs: number, velocity: number): StoredSet {
  return {
    id,
    sessionId: 'sess-jr',
    exerciseId: 'bench-press',
    userId: LOCAL_USER_ID,
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T10:02:00.000Z',
    partial: false,
    weightLbs: loadLbs,
    reps: buildReps(3, velocity) as StoredSet['reps'],
  } as StoredSet;
}

function makeStore(history: StoredSet[]): LoadDriftStore {
  return {
    getSetsForExercise: async () => history,
    getBaseline: async () => undefined,
  };
}

describe('checkLoadDrift', () => {
  const calibrationSets = CALIBRATION.map((p, i) => storedSet(`cal-${i}`, p.load, p.velocity));

  it('replays the Jimenez-Reyes pattern through a store and fires the flag', async () => {
    const measured = storedSet('measured-drifted', PROGRAMMED_LOAD_LBS, DRIFTED_VELOCITY_MPS);
    const store = makeStore([...calibrationSets, measured]);

    const flag = await checkLoadDrift(store, {
      exerciseId: 'bench-press',
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredSet: measured,
    });

    expect(flag).not.toBeNull();
    expect(flag?.programmedPct).toBeCloseTo(80, 1);
    expect(flag?.impliedPct).toBeCloseTo(64, 1);
    expect(flag?.deltaPct).toBeCloseTo(-16, 1);
    expect(flag?.reason).toContain('Jimenez-Reyes');
  });

  it('does not fire on a matched-intensity replay through the same store shape', async () => {
    const measured = storedSet('measured-matched', PROGRAMMED_LOAD_LBS, MATCHED_VELOCITY_MPS);
    const store = makeStore([...calibrationSets, measured]);

    const flag = await checkLoadDrift(store, {
      exerciseId: 'bench-press',
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredSet: measured,
    });

    expect(flag).toBeNull();
  });

  it('returns null with fewer than two prior calibration points', async () => {
    const measured = storedSet('measured-drifted', PROGRAMMED_LOAD_LBS, DRIFTED_VELOCITY_MPS);
    const store = makeStore([calibrationSets[0]!, measured]);

    const flag = await checkLoadDrift(store, {
      exerciseId: 'bench-press',
      prescribedLoadLbs: PROGRAMMED_LOAD_LBS,
      measuredSet: measured,
    });

    expect(flag).toBeNull();
  });
});
