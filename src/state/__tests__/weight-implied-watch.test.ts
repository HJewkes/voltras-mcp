import { describe, it, expect } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import {
  FORCE_PER_LB,
  medianConcentricPeakForce,
  evaluateWeightImplied,
} from '../weight-implied-watch.js';

/** Minimal Rep carrying only the concentric peak force the validator reads. */
function repWithForce(peakForce: number): Rep {
  const phase = {
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
    _peakVelocityTime: 0,
    _lastMovementVelocity: 0,
    peakVelocity: 0,
    peakForce,
    peakLoad: 0,
  };
  return { repNumber: 1, concentric: phase, eccentric: phase };
}

function reps(forces: number[]): Rep[] {
  return forces.map(repWithForce);
}

// Ground truth captured from the recorded upper-body bilateral session
// (~/.voltras/vmcp.sqlite). Each entry is the full per-rep concentric
// peakForce array for a set, its logged header weight, and the expected flag.
// The two "30 lb" sets were physically lifted at 50 (VMCP-02.57), so their
// force-implied weight lands near 50 and must FLAG against the 30 header.
const GROUND_TRUTH = [
  {
    label: '30 L (cc1812aa) — really 50',
    forces: [104, 305, 484, 504, 512, 506, 505, 509, 505, 503, 501, 499],
    headerLbs: 30,
    expectedMedian: 503.5,
    expectFlag: true,
  },
  {
    label: '30 R (fd15c14f) — really 50',
    forces: [127, 303, 515, 504, 506, 507, 504, 502, 506, 503, 503],
    headerLbs: 30,
    expectedMedian: 504,
    expectFlag: true,
  },
  {
    label: '50 L (d3acc215)',
    forces: [121, 298, 486, 510, 506, 510, 508, 509, 502, 506],
    headerLbs: 50,
    expectedMedian: 506,
    expectFlag: false,
  },
  {
    label: '50 R (c6ff82b8)',
    forces: [121, 504, 505, 503, 501, 501, 502, 508, 503],
    headerLbs: 50,
    expectedMedian: 503,
    expectFlag: false,
  },
  {
    label: '80 (4d1dd767)',
    forces: [795, 815, 816, 812, 815, 818, 817, 817, 817, 818, 817],
    headerLbs: 80,
    expectedMedian: 817,
    expectFlag: false,
  },
  {
    label: '115 (999a1139)',
    forces: [1081, 1167, 1166, 1176, 1170, 1165, 1167, 1172, 1168, 1170, 1171, 1172, 1168],
    headerLbs: 115,
    expectedMedian: 1168,
    expectFlag: false,
  },
] as const;

describe('medianConcentricPeakForce', () => {
  it('returns null for an empty rep array', () => {
    expect(medianConcentricPeakForce([])).toBeNull();
  });

  it('rejects the low ramp reps via the median (not the mean)', () => {
    // Two low warm-up reps + a 500 plateau: the median lands on the plateau.
    expect(medianConcentricPeakForce(reps([100, 200, 500, 500, 500]))).toBe(500);
  });

  it('averages the two middle values on an even-length set', () => {
    expect(medianConcentricPeakForce(reps([500, 503, 504, 512]))).toBe(503.5);
  });
});

describe('evaluateWeightImplied — recorded-session ground truth', () => {
  it.each(GROUND_TRUTH)(
    'flags $label as flag=$expectFlag',
    ({ forces, headerLbs, expectedMedian, expectFlag }) => {
      const result = evaluateWeightImplied(headerLbs, reps([...forces]));
      expect(result).not.toBeNull();
      expect(result!.medianConcentricPeakForce).toBe(expectedMedian);
      // Implied weight ≈ median / 10.17 — always lands near 50/80/115.
      expect(result!.impliedWeightLbs).toBeCloseTo(expectedMedian / FORCE_PER_LB, 5);
      expect(result!.flagged).toBe(expectFlag);
    },
  );

  it('confirms exactly the two 30→50 sets are flagged', () => {
    const flagged = GROUND_TRUTH.filter(
      (g) => evaluateWeightImplied(g.headerLbs, reps([...g.forces]))!.flagged,
    ).map((g) => g.label);
    expect(flagged).toEqual(['30 L (cc1812aa) — really 50', '30 R (fd15c14f) — really 50']);
  });
});

describe('evaluateWeightImplied — guards', () => {
  it('returns null when the set has no force telemetry (zero-force median)', () => {
    expect(evaluateWeightImplied(50, reps([0, 0, 0]))).toBeNull();
  });

  it('returns null for a non-positive header weight', () => {
    expect(evaluateWeightImplied(0, reps([500, 500]))).toBeNull();
  });

  it('does not flag a correctly-labeled set within the 10% tolerance', () => {
    // 508 / 10.17 ≈ 49.95 lb vs a 50 lb header → ~0.1% disagreement.
    const result = evaluateWeightImplied(50, reps([508, 508, 508]));
    expect(result!.flagged).toBe(false);
    expect(result!.ratio).toBeLessThan(0.1);
  });
});
