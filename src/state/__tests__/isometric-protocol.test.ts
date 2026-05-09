// Pure-function tests for the isometric assessment analysis layer.
//
// These cases drive `analyzeTrial`, `aggregateSide`, `computeImbalance`,
// and `decideTestOrder` with hand-crafted force-sample inputs. No SDK,
// no timers, no network — every assertion is a deterministic data
// transformation. Protocol expectations come straight from
// coordination/research/isometric-protocol-2026-05-09.md.

import { describe, expect, it } from 'vitest';

import {
  aggregateSide,
  analyzeTrial,
  computeImbalance,
  decideTestOrder,
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

describe('computeImbalance — asymmetry thresholds', () => {
  it('returns null when either side lacks a mean', () => {
    const result = computeImbalance({ meanPlateauForceLbs: null }, { meanPlateauForceLbs: 150 });
    expect(result.asymmetryPct).toBeNull();
    expect(result.strongerSide).toBeNull();
    expect(result.flagged).toBe(false);
    expect(result.meaningful).toBe(false);
  });

  it('flags asymmetry at the 10% threshold', () => {
    // 100 vs. 90: (100-90)/100 × 100 = 10%.
    const result = computeImbalance({ meanPlateauForceLbs: 100 }, { meanPlateauForceLbs: 90 });
    expect(result.asymmetryPct).toBeCloseTo(10, 5);
    expect(result.flagged).toBe(true);
    expect(result.meaningful).toBe(false);
    expect(result.strongerSide).toBe('left');
  });

  it('marks asymmetry meaningful at the 15% threshold', () => {
    // 100 vs. 85: (100-85)/100 × 100 = 15%.
    const result = computeImbalance({ meanPlateauForceLbs: 100 }, { meanPlateauForceLbs: 85 });
    expect(result.asymmetryPct).toBeCloseTo(15, 5);
    expect(result.flagged).toBe(true);
    expect(result.meaningful).toBe(true);
  });

  it('reports tie when sides are within 1% of each other', () => {
    const result = computeImbalance({ meanPlateauForceLbs: 200 }, { meanPlateauForceLbs: 199 });
    expect(result.strongerSide).toBe('tie');
    expect(result.flagged).toBe(false);
  });

  it('right side stronger surfaces in strongerSide', () => {
    const result = computeImbalance({ meanPlateauForceLbs: 100 }, { meanPlateauForceLbs: 130 });
    expect(result.strongerSide).toBe('right');
    expect(result.flagged).toBe(true);
    expect(result.meaningful).toBe(true);
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
