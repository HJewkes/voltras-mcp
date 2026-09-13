// Pure-function tests for the isometric assessment analysis layer.
//
// These cases drive `analyzeTrial`, `aggregateSide`, `computeImbalance`,
// and `decideTestOrder` with hand-crafted force-sample inputs. No SDK,
// no timers, no network — every assertion is a deterministic data
// transformation. Protocol expectations come straight from
// sources/research/isometric-protocol-2026-05-09.md.

import { describe, expect, it } from 'vitest';

import {
  aggregateSide,
  analyzeTrial,
  asymmetryEquationFor,
  computeImbalance,
  computePeakForceBaseline,
  decideTestOrder,
  directionOfMeasurement,
  evaluateJointAngleGate,
  evaluatePeakForceChange,
  occasionPeakForcesLbs,
  summarizeDirectionHistory,
  JOINT_ANGLE_MISMATCH_THRESHOLD_DEG,
  type ForceSample,
  type TrialAnalysis,
} from '../isometric-protocol.js';

/**
 * Helper to construct a synthetic force-sample trace at 40 Hz (25 ms
 * intervals). `shape` is a function from t (0..1, fraction of total
 * duration) to force lbs.
 */
function buildTrace(durationMs: number, shape: (t: number) => number): ForceSample[] {
  const samples: ForceSample[] = [];
  const stepMs = 25;
  for (let tMs = 0; tMs <= durationMs; tMs += stepMs) {
    samples.push({ tMs, forceLbs: shape(tMs / durationMs) });
  }
  return samples;
}

/**
 * Smooth ramp to a plateau, then a soft decline at the very end. The
 * plateau is held flat (no sin-wave noise) so the 500ms-around-peak mean
 * cleanly clears the 90% gate. Models a textbook isometric pull.
 */
function plateauTrace(durationMs: number, peakLbs: number): ForceSample[] {
  return buildTrace(durationMs, (t) => {
    if (t < 0.4) return peakLbs * (t / 0.4);
    if (t < 0.9) return peakLbs;
    return peakLbs * Math.max(0, 1 - (t - 0.9) * 5);
  });
}

describe('analyzeTrial — validity gates', () => {
  it('marks a textbook plateau trace as valid', () => {
    const samples = plateauTrace(5000, 200);
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(true);
    expect(result.peakForceLbs).toBeGreaterThan(180);
    expect(result.plateauForceLbs).toBeGreaterThan(180);
    expect(result.invalidReason).toBeUndefined();
  });

  it('rejects a trial with empty samples', () => {
    const result = analyzeTrial([], 1);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe('no samples captured');
  });

  it('rejects a trial whose force does not rise continuously from onset', () => {
    // Pull, drop hard, then pull again to peak — the prefix-to-peak has a
    // big dip that violates the continuous-rise gate.
    const samples = buildTrace(5000, (t) => {
      if (t < 0.2) return 100 * (t / 0.2);
      if (t < 0.4) return 30; // drop
      return 100 + (t - 0.4) * 200; // ramp again to peak
    });
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('continuously');
  });

  it('rejects a trial whose peak occurs before the first second', () => {
    // Spike at 500ms then decay — the brief calls this a jerk impulse.
    const samples = buildTrace(5000, (t) => {
      if (t < 0.1) return 200 * (t / 0.1);
      return 200 * Math.max(0, 1 - (t - 0.1) * 1.2);
    });
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('peak occurred at');
  });

  it('rejects a trial whose 500ms plateau averages below 90% of peak', () => {
    // Sharp spike at 2s, then immediate fall-off → plateau window mean
    // drops well below 90% of the spike peak.
    const samples = buildTrace(5000, (t) => {
      if (t < 0.4) return 100 * (t / 0.4);
      if (t < 0.42) return 200; // brief spike
      return 50; // immediate collapse
    });
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('plateau');
  });

  it('records peakForceLbs and plateauForceLbs even when invalid', () => {
    const samples = buildTrace(5000, (t) => (t < 0.1 ? 200 : 50));
    const result = analyzeTrial(samples, 3);
    expect(result.valid).toBe(false);
    expect(result.peakForceLbs).toBeGreaterThan(0);
    expect(result.index).toBe(3);
  });
});

// VW-271: RFD and impulse-to-peak are DIAGNOSTIC ONLY — Grgic et al. (2022)
// puts early-phase force CV at 5.5-23.3% and Weakley et al. (2024) calls RFD
// "not recommended" for monitoring change, so nothing downstream may trend
// these, but they are still computed for every trial the same way peak and
// plateau force are.
describe('analyzeTrial — diagnostic-only RFD and impulse', () => {
  it('computes RFD and impulse-to-peak from onset to peak on a valid trial', () => {
    // plateauTrace ramps linearly 0 -> 200 lb over the first 2000ms of a
    // 5000ms trial, then holds flat — peak first occurs at t=2000ms.
    const samples = plateauTrace(5000, 200);
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(true);
    // RFD = peak force / time-to-peak = 200 lb / 2s = 100 lb/s.
    expect(result.diagnostic.rfdLbPerS).toBeCloseTo(100, 1);
    // Impulse under a linear ramp to peak = triangle area = 0.5 x 2s x 200 lb.
    expect(result.diagnostic.impulseLbS).toBeCloseTo(200, 0);
  });

  it('computes diagnostics even when the trial fails a validity gate', () => {
    // Peak at 500ms (fails the peak-after-1s gate), ramping 0 -> 200 lb.
    const samples = buildTrace(5000, (t) => {
      if (t < 0.1) return 200 * (t / 0.1);
      return 200 * Math.max(0, 1 - (t - 0.1) * 1.2);
    });
    const result = analyzeTrial(samples, 1);
    expect(result.valid).toBe(false);
    expect(result.diagnostic.rfdLbPerS).toBeGreaterThan(0);
    expect(result.diagnostic.impulseLbS).toBeGreaterThan(0);
  });

  it('returns zero diagnostics for an empty trial', () => {
    const result = analyzeTrial([], 1);
    expect(result.diagnostic).toEqual({ rfdLbPerS: 0, impulseLbS: 0 });
  });
});

// VW-271: aggregation picks and averages by PEAK force, not plateau force —
// peak is the metric the reliability literature validated. `plateauLbs`
// defaults to the peak value so a test that doesn't care about the
// distinction can pass one number.
describe('aggregateSide — best-2-of-3 selection and CV', () => {
  function validTrial(idx: number, peakLbs: number, plateauLbs: number = peakLbs): TrialAnalysis {
    return {
      index: idx,
      peakForceLbs: peakLbs,
      plateauForceLbs: plateauLbs,
      plateauStartMs: 1750,
      plateauEndMs: 2250,
      valid: true,
    };
  }

  it('returns null mean when fewer than 2 valid trials', () => {
    const result = aggregateSide([validTrial(1, 150)]);
    expect(result.meanPeakForceLbs).toBeNull();
    expect(result.cvPct).toBeNull();
    expect(result.inferredWorkingWeightLbs).toBeNull();
  });

  it('picks the highest 2 peak forces from 3 valid trials', () => {
    // Three trials within ~10% of each other so the session-mean CV gate
    // (15%) does not discard any. Best 2 = 200 and 195; mean = 197.5.
    const trials = [validTrial(1, 190), validTrial(2, 200), validTrial(3, 195)];
    const result = aggregateSide(trials);
    expect(result.meanPeakForceLbs).toBeCloseTo(197.5, 5);
    expect(result.validTrialCount).toBe(3);
  });

  it('ranks by PEAK force, not plateau force, when the two disagree on which trials win', () => {
    // Peak ranking: trial1(200) > trial2(190) > trial3(180) -> best 2 = 1+2, mean 195.
    // Plateau ranking: trial2(200) > trial3(195) > trial1(100) -> best 2 = 2+3, mean 197.5.
    // A plateau-based aggregation would pick trial2+trial3 and report 197.5;
    // a peak-based one picks trial1+trial2 and reports 195. The two headline
    // means, and the two SETS of trials selected, differ — this is the case
    // "picks the highest 2 peak forces" above cannot distinguish, because
    // that fixture keeps peak and plateau in the same rank order.
    const trials = [validTrial(1, 200, 100), validTrial(2, 190, 200), validTrial(3, 180, 195)];
    const result = aggregateSide(trials);
    expect(result.meanPeakForceLbs).toBeCloseTo(195, 5);
  });

  it('computes CV across the 2 best trials as sd / mean × 100', () => {
    // Best 2 = 200 and 180; mean = 190.
    // Sample SD with n=2 = |200-180| × √(1/2) = 14.142...
    // CV = 14.142 / 190 × 100 ≈ 7.44.
    const trials = [validTrial(1, 170), validTrial(2, 180), validTrial(3, 200)];
    const result = aggregateSide(trials);
    expect(result.cvPct).toBeCloseTo(7.44, 1);
  });

  it('inferred working weight is 70% of mean peak force, rounded to 5 lb', () => {
    // Best 2 = 200 and 195; mean = 197.5; 70% = 138.25; rounded to 5 = 140.
    const trials = [validTrial(1, 190), validTrial(2, 200), validTrial(3, 195)];
    const result = aggregateSide(trials);
    expect(result.inferredWorkingWeightLbs).toBe(140);
  });

  it('clamps inferred working weight up to the 5 lb device minimum', () => {
    // Arrange: two very low peaks (~3 lb). 70% = 2.1, which rounds to 0 —
    // below the device set_weight floor of 5 lb.
    const trials = [validTrial(1, 3), validTrial(2, 3)];
    // Act
    const result = aggregateSide(trials);
    // Assert: never emit an unsettable (< 5 lb) target.
    expect(result.inferredWorkingWeightLbs).toBe(5);
    expect(result.inferredWorkingWeightLbs).toBeGreaterThanOrEqual(5);
  });

  it('discards a session-level outlier (peak > 15% from session mean)', () => {
    // Two strong trials at 200 and one outlier at 50 — session mean ≈ 150,
    // outlier diverges ~66.7% so it gets re-marked invalid. Two strong
    // trials remain valid; the best-2 mean = 200.
    const trials = [validTrial(1, 200), validTrial(2, 200), validTrial(3, 50)];
    const result = aggregateSide(trials);
    const trial3 = result.trials.find((t) => t.index === 3)!;
    expect(trial3.valid).toBe(false);
    expect(trial3.invalidReason).toContain('diverges');
    expect(result.validTrialCount).toBe(2);
    expect(result.meanPeakForceLbs).toBeCloseTo(200, 5);
  });

  it('keeps all 3 valid when peaks cluster within 15% of the median', () => {
    // Median is 195; trial1 (190) diverges 2.5%, trial3 (200) diverges 2.5% — none exceed 15%.
    const trials = [validTrial(1, 190), validTrial(2, 195), validTrial(3, 200)];
    const result = aggregateSide(trials);
    expect(result.validTrialCount).toBe(3);
  });
});

// VW-270: the verdict is the athlete's own intra-limb CV, never a constant.
// The old 10%/15% pair is gone; these cases pin what replaced it.
describe('computeImbalance — the intra-limb CV gate', () => {
  it('gives no verdict when either side lacks a mean', () => {
    const result = computeImbalance(
      { meanPeakForceLbs: null, cvPct: null },
      { meanPeakForceLbs: 150, cvPct: 2 },
    );
    expect(result.asymmetryPct).toBeNull();
    expect(result.direction).toBeNull();
    expect(result.real).toBe(false);
    expect(result.interpretation).toContain('fewer than 2 valid trials');
  });

  it('does NOT call a 10% asymmetry real when the limbs vary by 12% themselves', () => {
    // The retired constant said 10% was noteworthy. Against a 12% intra-limb
    // CV the same 10% is inside the measurement's own spread.
    const result = computeImbalance(
      { meanPeakForceLbs: 100, cvPct: 12 },
      { meanPeakForceLbs: 90, cvPct: 4 },
    );
    expect(result.asymmetryPct).toBeCloseTo(10, 5);
    expect(result.noiseFloorCvPct).toBe(12);
    expect(result.real).toBe(false);
    expect(result.interpretation).toContain('within');
  });

  it('calls a 10% asymmetry real when the limbs vary by 4% themselves', () => {
    const result = computeImbalance(
      { meanPeakForceLbs: 100, cvPct: 4 },
      { meanPeakForceLbs: 90, cvPct: 3 },
    );
    expect(result.asymmetryPct).toBeCloseTo(10, 5);
    expect(result.noiseFloorCvPct).toBe(4);
    expect(result.real).toBe(true);
    expect(result.direction).toBe('left');
  });

  it('compares against the HIGHER of the two sides CVs', () => {
    // 5% asymmetry, left steady at 1%, right noisy at 9%: the noisy limb sets
    // the floor, because the difference has to clear both limbs' own spread.
    const result = computeImbalance(
      { meanPeakForceLbs: 100, cvPct: 1 },
      { meanPeakForceLbs: 95, cvPct: 9 },
    );
    expect(result.noiseFloorCvPct).toBe(9);
    expect(result.real).toBe(false);
  });

  it('withholds the verdict when a side has no CV to judge against', () => {
    const result = computeImbalance(
      { meanPeakForceLbs: 100, cvPct: null },
      { meanPeakForceLbs: 70, cvPct: 3 },
    );
    expect(result.asymmetryPct).toBeCloseTo(30, 5);
    expect(result.noiseFloorCvPct).toBeNull();
    expect(result.real).toBe(false);
  });

  it('names the equation it used', () => {
    const result = computeImbalance(
      { meanPeakForceLbs: 100, cvPct: 2 },
      { meanPeakForceLbs: 130, cvPct: 2 },
    );
    expect(result.equation).toBe('standard-percentage-difference');
    expect(result.direction).toBe('right');
    expect(result.intraLimbCvPct).toEqual({ left: 2, right: 2 });
  });

  it('reports no direction at an exact tie', () => {
    const result = computeImbalance(
      { meanPeakForceLbs: 200, cvPct: 2 },
      { meanPeakForceLbs: 200, cvPct: 2 },
    );
    expect(result.direction).toBeNull();
    expect(result.real).toBe(false);
  });
});

describe('asymmetryEquationFor — fixed per test type (VW-295)', () => {
  it('always returns the same label for the same test type', () => {
    expect(asymmetryEquationFor('bilateral-imbalance')).toBe('standard-percentage-difference');
    expect(asymmetryEquationFor('bilateral-imbalance')).toBe('standard-percentage-difference');
  });

  it('names no equation for a unilateral-max run, which computes no comparison', () => {
    expect(asymmetryEquationFor('unilateral-max')).toBeNull();
    expect(asymmetryEquationFor('unilateral-max')).toBeNull();
  });
});

describe('summarizeDirectionHistory — direction stability across tests', () => {
  const at = (day: number, direction: 'left' | 'right' | null) => ({
    measuredAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    direction,
  });

  it('withholds a label under three tests with a direction', () => {
    const result = summarizeDirectionHistory([at(1, 'left'), at(2, 'left')]);
    expect(result.label).toBe('insufficient-history');
    expect(result.testsCompared).toBe(2);
    expect(result.agreementPct).toBeNull();
  });

  it('calls dominance consistent when the same limb wins every test', () => {
    const result = summarizeDirectionHistory([at(1, 'left'), at(2, 'left'), at(3, 'left')]);
    expect(result.label).toBe('consistent-left');
    expect(result.agreementPct).toBe(100);
    expect(result.interpretation).toContain('closer look');
  });

  it('calls dominance fluctuating when the direction flips', () => {
    const result = summarizeDirectionHistory([at(1, 'left'), at(2, 'right'), at(3, 'left')]);
    expect(result.label).toBe('fluctuating');
    expect(result.agreementPct).toBeCloseTo(66.7, 1);
    expect(result.interpretation).toContain('does not warrant attention');
  });

  it('does not count a test that produced no direction', () => {
    const result = summarizeDirectionHistory([at(1, 'right'), at(2, null), at(3, 'right')]);
    expect(result.testsCompared).toBe(2);
    expect(result.label).toBe('insufficient-history');
  });

  it('orders directions newest first regardless of input order', () => {
    const result = summarizeDirectionHistory([at(2, 'right'), at(9, 'left'), at(5, 'right')]);
    expect(result.directions).toEqual(['left', 'right', 'right']);
  });
});

describe('directionOfMeasurement — direction recomputed from stored trials', () => {
  const trial = (index: number, plateauForceLbs: number) => ({
    index,
    peakForceLbs: plateauForceLbs + 2,
    plateauForceLbs,
    plateauStartMs: 1500,
    plateauEndMs: 2000,
    valid: true,
  });

  it('reads the stronger limb off the persisted per-trial forces', () => {
    const direction = directionOfMeasurement({
      sides: [
        { side: 'left', trials: [trial(1, 100), trial(2, 99)] },
        { side: 'right', trials: [trial(1, 80), trial(2, 81)] },
      ],
    });
    expect(direction).toBe('left');
  });

  it('returns null when a stored side has too few valid trials', () => {
    const direction = directionOfMeasurement({
      sides: [
        { side: 'left', trials: [trial(1, 100)] },
        { side: 'right', trials: [trial(1, 80), trial(2, 81)] },
      ],
    });
    expect(direction).toBeNull();
  });
});

// VW-271: a per-athlete peak-force baseline, and the adjusted-SEM change check
// (SEM x sqrt(2), Weakley et al. 2024) it drives.
describe('computePeakForceBaseline — per-athlete mean/SEM/CV over past occasions', () => {
  it('returns null under 3 occasions', () => {
    expect(computePeakForceBaseline([100, 105])).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(computePeakForceBaseline([])).toBeNull();
  });

  it('derives mean, SEM (sample SD) and CV from 3+ occasions', () => {
    // Mean = 100; sample SD (n-1) of [95,100,105] = 5; CV = 5/100 x 100 = 5%.
    const baseline = computePeakForceBaseline([95, 100, 105]);
    expect(baseline).not.toBeNull();
    expect(baseline!.sampleSize).toBe(3);
    expect(baseline!.meanLbs).toBeCloseTo(100, 5);
    expect(baseline!.semLbs).toBeCloseTo(5, 5);
    expect(baseline!.cvPct).toBeCloseTo(5, 5);
  });
});

describe('evaluatePeakForceChange — the adjusted-SEM (SEM x sqrt(2)) threshold', () => {
  const baseline = { sampleSize: 3, meanLbs: 100, semLbs: 5, cvPct: 5 };

  it('does not flag a change within the adjusted SEM', () => {
    // Adjusted SEM = 5 x sqrt(2) ≈ 7.07. A 107 lb result is 7 lb off — inside it.
    const result = evaluatePeakForceChange(107, baseline);
    expect(result.changed).toBe(false);
    expect(result.deltaLbs).toBeCloseTo(7, 5);
    expect(result.thresholdLbs).toBeCloseTo(7.071, 2);
    expect(result.interpretation).toContain('cannot be distinguished');
  });

  it('flags a change once it clears the adjusted SEM', () => {
    const result = evaluatePeakForceChange(115, baseline);
    expect(result.changed).toBe(true);
    expect(result.deltaLbs).toBeCloseTo(15, 5);
    expect(result.interpretation).toContain('likely a real');
  });

  it('flags a drop the same way it flags a gain', () => {
    const result = evaluatePeakForceChange(85, baseline);
    expect(result.changed).toBe(true);
    expect(result.deltaLbs).toBeCloseTo(-15, 5);
  });
});

describe('occasionPeakForcesLbs — pooled per-side peak forces for the baseline', () => {
  const trial = (index: number, peakForceLbs: number) => ({
    index,
    peakForceLbs,
    plateauForceLbs: peakForceLbs,
    plateauStartMs: 1500,
    plateauEndMs: 2000,
    valid: true,
  });

  it('pools one value per side per occasion that has a mean', () => {
    const peaks = occasionPeakForcesLbs([
      {
        sides: [
          { trials: [trial(1, 100), trial(2, 102)] },
          { trials: [trial(1, 80), trial(2, 82)] },
        ],
      },
      { sides: [{ trials: [trial(1, 110), trial(2, 108)] }] },
    ]);
    expect(peaks).toHaveLength(3);
    expect(peaks.every((p) => p > 0)).toBe(true);
  });

  it('skips a side with fewer than 2 valid trials', () => {
    const peaks = occasionPeakForcesLbs([{ sides: [{ trials: [trial(1, 100)] }] }]);
    expect(peaks).toEqual([]);
  });
});

describe('decideTestOrder — non-dominant first reordering', () => {
  it('returns primary-then-secondary when testNonDominantFirst is false', () => {
    const order = decideTestOrder('left', 'right', false, 'right');
    expect(order).toEqual(['left', 'right']);
  });

  it('returns primary-then-secondary when dominantSide is unknown', () => {
    const order = decideTestOrder('left', 'right', true, 'unknown');
    expect(order).toEqual(['left', 'right']);
  });

  it('swaps to put the non-dominant (secondary) side first when primary is dominant', () => {
    // primary = left, dominant = left → swap so the non-dominant (right) goes first.
    const order = decideTestOrder('left', 'right', true, 'left');
    expect(order).toEqual(['right', 'left']);
  });

  it('keeps primary first when primary is already the non-dominant side', () => {
    const order = decideTestOrder('left', 'right', true, 'right');
    expect(order).toEqual(['left', 'right']);
  });
});

describe('evaluateJointAngleGate — VW-296', () => {
  it('is angle_unverified with no exerciseId', () => {
    const verdict = evaluateJointAngleGate(undefined, 90);
    expect(verdict.comparability).toBe('angle_unverified');
    expect(verdict.exercisePeakAngleDeg).toBeNull();
    expect(verdict.deltaDeg).toBeNull();
  });

  it('is angle_unverified for an exercise with no known peak angle', () => {
    const verdict = evaluateJointAngleGate('cable-row', 90);
    expect(verdict.comparability).toBe('angle_unverified');
    expect(verdict.exercisePeakAngleDeg).toBeNull();
    expect(verdict.reason).toContain('cable-row');
  });

  it('is angle_unverified with no setupAngleDeg, even for a known exercise', () => {
    const verdict = evaluateJointAngleGate('cable-squat', undefined);
    expect(verdict.comparability).toBe('angle_unverified');
    expect(verdict.exercisePeakAngleDeg).toBe(90);
    expect(verdict.setupAngleDeg).toBeNull();
  });

  it('is comparable inside the mismatch threshold', () => {
    const verdict = evaluateJointAngleGate('cable-squat', 90 + JOINT_ANGLE_MISMATCH_THRESHOLD_DEG);
    expect(verdict.comparability).toBe('comparable');
    expect(verdict.deltaDeg).toBe(JOINT_ANGLE_MISMATCH_THRESHOLD_DEG);
  });

  it('is angle_mismatch just past the threshold, citing the source', () => {
    const verdict = evaluateJointAngleGate(
      'cable-squat',
      90 + JOINT_ANGLE_MISMATCH_THRESHOLD_DEG + 1,
    );
    expect(verdict.comparability).toBe('angle_mismatch');
    expect(verdict.deltaDeg).toBe(JOINT_ANGLE_MISMATCH_THRESHOLD_DEG + 1);
    expect(verdict.reason).toContain('Lum, Haff & Barbosa 2020');
  });
});
