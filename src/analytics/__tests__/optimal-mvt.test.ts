// VW-299: the fitted MVT, and the thing it is supposed to beat.
//
// The fixture below is the case Banyard, Nosaka & Haff (2017) describe: a
// lifter whose 1RM is stable but whose velocity at 1RM is not. Two maximal
// singles at essentially the same load are recorded at 0.30 and 0.12 m/s.
// Reading the individual MVT off the heavier of them — the observed V1RM — is
// what this fit replaces.

import { describe, expect, it } from 'vitest';
import {
  MIN_ANCHORED_SESSIONS,
  MVT_FIT_BOUNDS,
  fitOptimalMvt,
  mvtErrorPct,
  type MvtSetObservation,
} from '../optimal-mvt.js';

interface SetSpec {
  loadLbs: number;
  velocity: number;
  reps: number;
  failure?: boolean;
}

function session(id: string, date: string, sets: SetSpec[]): MvtSetObservation[] {
  return sets.map((set) => ({
    sessionId: id,
    startedAt: `${date}T10:00:00.000Z`,
    loadLbs: set.loadLbs,
    bestRepVelocityMps: set.velocity,
    repCount: set.reps,
    failure: set.failure === true,
  }));
}

/**
 * Four sessions of one exercise. The submaximal ramp sits on a consistent
 * load-velocity line; the maximal efforts that anchor it do not, which is the
 * whole difficulty.
 */
const HISTORY: MvtSetObservation[] = [
  ...session('s1', '2026-06-01', [
    { loadLbs: 120, velocity: 0.56, reps: 5 },
    { loadLbs: 150, velocity: 0.42, reps: 3 },
    { loadLbs: 200, velocity: 0.3, reps: 1, failure: true },
  ]),
  ...session('s2', '2026-06-08', [
    { loadLbs: 130, velocity: 0.51, reps: 5 },
    { loadLbs: 160, velocity: 0.38, reps: 3 },
    { loadLbs: 175, velocity: 0.31, reps: 4, failure: true },
  ]),
  ...session('s3', '2026-06-15', [
    { loadLbs: 125, velocity: 0.54, reps: 5 },
    { loadLbs: 155, velocity: 0.4, reps: 3 },
    { loadLbs: 198, velocity: 0.12, reps: 1, failure: true },
  ]),
  ...session('s4', '2026-06-22', [
    { loadLbs: 135, velocity: 0.49, reps: 5 },
    { loadLbs: 165, velocity: 0.36, reps: 3 },
    { loadLbs: 180, velocity: 0.29, reps: 3, failure: true },
  ]),
];

describe('fitOptimalMvt', () => {
  it('lands away from the observed V1RM and predicts 1RM better than it does', () => {
    const fit = fitOptimalMvt(HISTORY);

    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.observedV1rm).toBe(0.3);
    // The fit lands 0.035 m/s below the velocity the heavier single was
    // recorded at, and predicting each session's 1RM from there is wrong by
    // 4.02 % instead of 6.63 %.
    expect(fit.mvt).toBe(0.265);
    expect(fit.errorPct).toBe(4.02);
    expect(mvtErrorPct(HISTORY, fit.observedV1rm)).toBe(6.63);
    expect(fit.sampleSize).toBe(4);
  });

  it('stays inside the bounded search interval', () => {
    const fit = fitOptimalMvt(HISTORY);
    expect(fit?.mvt).toBeGreaterThanOrEqual(MVT_FIT_BOUNDS.minMps);
    expect(fit?.mvt).toBeLessThanOrEqual(MVT_FIT_BOUNDS.maxMps);
  });

  it('returns null below the anchored-session minimum', () => {
    const short = HISTORY.filter((obs) => obs.sessionId !== 's4' && obs.sessionId !== 's3');
    expect(new Set(short.map((o) => o.sessionId)).size).toBeLessThan(MIN_ANCHORED_SESSIONS);
    expect(fitOptimalMvt(short)).toBeNull();
  });

  it('returns null when no set was taken to failure: nothing anchors a 1RM', () => {
    const unanchored = HISTORY.map((obs) => ({ ...obs, failure: false }));
    expect(fitOptimalMvt(unanchored)).toBeNull();
  });

  it('returns null when every session used one load: no slope to solve', () => {
    const flat = HISTORY.map((obs) => ({ ...obs, loadLbs: 150 }));
    expect(fitOptimalMvt(flat)).toBeNull();
  });
});
