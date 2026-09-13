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
  computeImbalance,
  decideTestOrder,
  directionOfMeasurement,
  summarizeDirectionHistory,
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

describe('aggregateSide — best-2-of-3 selection and CV', () => {
  function validTrial(
    idx: number,
    plateauLbs: number,
    peakLbs: number = plateauLbs,
  ): TrialAnalysis {
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
    expect(result.meanPlateauForceLbs).toBeNull();
    expect(result.cvPct).toBeNull();
    expect(result.inferredWorkingWeightLbs).toBeNull();
  });

  it('picks the highest 2 plateau forces from 3 valid trials', () => {
    // Three trials within ~10% of each other so the session-mean CV gate
    // (15%) does not discard any. Best 2 = 200 and 195; mean = 197.5.
    const trials = [validTrial(1, 190), validTrial(2, 200), validTrial(3, 195)];
    const result = aggregateSide(trials);
    expect(result.meanPlateauForceLbs).toBeCloseTo(197.5, 5);
    expect(result.validTrialCount).toBe(3);
  });

  it('computes CV across the 2 best trials as sd / mean × 100', () => {
    // Best 2 = 200 and 180; mean = 190.
    // Sample SD with n=2 = |200-180| × √(1/2) = 14.142...
    // CV = 14.142 / 190 × 100 ≈ 7.44.
    const trials = [validTrial(1, 170), validTrial(2, 180), validTrial(3, 200)];
    const result = aggregateSide(trials);
    expect(result.cvPct).toBeCloseTo(7.44, 1);
  });

  it('inferred working weight is 70% of mean plateau, rounded to 5 lb', () => {
    // Best 2 = 200 and 195; mean = 197.5; 70% = 138.25; rounded to 5 = 140.
    const trials = [validTrial(1, 190), validTrial(2, 200), validTrial(3, 195)];
    const result = aggregateSide(trials);
    expect(result.inferredWorkingWeightLbs).toBe(140);
  });

  it('clamps inferred working weight up to the 5 lb device minimum', () => {
    // Arrange: two very low plateaus (~3 lb). 70% = 2.1, which rounds to 0 —
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
    const trials = [validTrial(1, 200, 200), validTrial(2, 200, 200), validTrial(3, 50, 50)];
    const result = aggregateSide(trials);
    const trial3 = result.trials.find((t) => t.index === 3)!;
    expect(trial3.valid).toBe(false);
    expect(trial3.invalidReason).toContain('diverges');
    expect(result.validTrialCount).toBe(2);
    expect(result.meanPlateauForceLbs).toBeCloseTo(200, 5);
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
      { meanPlateauForceLbs: null, cvPct: null },
      { meanPlateauForceLbs: 150, cvPct: 2 },
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
      { meanPlateauForceLbs: 100, cvPct: 12 },
      { meanPlateauForceLbs: 90, cvPct: 4 },
    );
    expect(result.asymmetryPct).toBeCloseTo(10, 5);
    expect(result.noiseFloorCvPct).toBe(12);
    expect(result.real).toBe(false);
    expect(result.interpretation).toContain('within');
  });

  it('calls a 10% asymmetry real when the limbs vary by 4% themselves', () => {
    const result = computeImbalance(
      { meanPlateauForceLbs: 100, cvPct: 4 },
      { meanPlateauForceLbs: 90, cvPct: 3 },
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
      { meanPlateauForceLbs: 100, cvPct: 1 },
      { meanPlateauForceLbs: 95, cvPct: 9 },
    );
    expect(result.noiseFloorCvPct).toBe(9);
    expect(result.real).toBe(false);
  });

  it('withholds the verdict when a side has no CV to judge against', () => {
    const result = computeImbalance(
      { meanPlateauForceLbs: 100, cvPct: null },
      { meanPlateauForceLbs: 70, cvPct: 3 },
    );
    expect(result.asymmetryPct).toBeCloseTo(30, 5);
    expect(result.noiseFloorCvPct).toBeNull();
    expect(result.real).toBe(false);
  });

  it('names the equation it used', () => {
    const result = computeImbalance(
      { meanPlateauForceLbs: 100, cvPct: 2 },
      { meanPlateauForceLbs: 130, cvPct: 2 },
    );
    expect(result.equation).toBe('standard-percentage-difference');
    expect(result.direction).toBe('right');
    expect(result.intraLimbCvPct).toEqual({ left: 2, right: 2 });
  });

  it('reports no direction at an exact tie', () => {
    const result = computeImbalance(
      { meanPlateauForceLbs: 200, cvPct: 2 },
      { meanPlateauForceLbs: 200, cvPct: 2 },
    );
    expect(result.direction).toBeNull();
    expect(result.real).toBe(false);
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
