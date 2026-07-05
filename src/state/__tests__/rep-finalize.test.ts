// Regression coverage for the finalize-time rep corrections
// (VMCP-02.66 segmentation, 02.65 eccentric idle-tail truncate,
// 02.69a signed peak recompute). Each test fabricates a rep stream that
// reproduces the bench-observed corruption and asserts `finalizeReps`
// corrects it. Reps are built through the real `rebuildPhaseFromSamples` so the
// phases carry genuine samples/positions for the corrections to operate on.

import { describe, it, expect } from 'vitest';
import type { Phase, Rep, WorkoutSample } from '@voltras/workout-analytics';
import { rebuildPhaseFromSamples } from '@voltras/workout-analytics';

import { finalizeReps } from '../rep-finalize.js';

const CONCENTRIC = 1;
const ECCENTRIC = 3;

function sample(seq: number, phase: number, position: number, velocity: number): WorkoutSample {
  return {
    sequence: seq,
    timestamp: seq * 10,
    phase: phase as unknown as WorkoutSample['phase'],
    position,
    velocity,
    force: 20,
  };
}

function phaseFrom(samples: WorkoutSample[]): Phase {
  return rebuildPhaseFromSamples(samples);
}

function rep(repNumber: number, concentric: Phase, eccentric: Phase): Rep {
  return { repNumber, concentric, eccentric };
}

/** A clean rep: concentric climbs (positive net ROM), eccentric descends. */
function cleanRep(repNumber: number, base: number): Rep {
  const conc = phaseFrom([
    sample(base, CONCENTRIC, 0.1, 400),
    sample(base + 1, CONCENTRIC, 0.5, 600),
  ]);
  const ecc = phaseFrom([
    sample(base + 2, ECCENTRIC, 0.5, 300),
    sample(base + 3, ECCENTRIC, 0.1, 200),
  ]);
  return rep(repNumber, conc, ecc);
}

describe('finalizeReps — VMCP-02.66 segmentation', () => {
  it('drops the leading un-rack rep whose concentric nets negative displacement', () => {
    // Un-rack: the load is lowered into the start position, so the "concentric"
    // ends below where it began (609 → 592). This phantom rep inflates the rep
    // count and poisons vbt_summary.first_rep_v.
    const unrackConc = phaseFrom([sample(0, CONCENTRIC, 609, -5), sample(1, CONCENTRIC, 592, -3)]);
    const unrack = rep(1, unrackConc, phaseFrom([]));
    const real1 = cleanRep(2, 100);
    const real2 = cleanRep(3, 200);

    const out = finalizeReps([unrack, real1, real2]);

    expect(out.map((r) => r.repNumber)).toEqual([2, 3]);
  });

  it('preserves a zero-displacement rep (empty / single-sample) — not the artifact', () => {
    const empty = rep(1, phaseFrom([]), phaseFrom([]));
    const out = finalizeReps([empty]);
    expect(out).toHaveLength(1);
  });

  it('keeps every rep with a positive-net-ROM concentric', () => {
    const out = finalizeReps([cleanRep(1, 0), cleanRep(2, 100)]);
    expect(out).toHaveLength(2);
  });
});

describe('finalizeReps — VMCP-02.65 eccentric idle-tail truncate', () => {
  it("trims the final rep's eccentric back to the last real movement sample", () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 400), sample(1, CONCENTRIC, 0.5, 600)]);
    // 3 real descent samples (velocity ≫ 50u) then a long parked idle tail.
    const eccSamples: WorkoutSample[] = [
      sample(2, ECCENTRIC, 0.5, 300),
      sample(3, ECCENTRIC, 0.3, 200),
      sample(4, ECCENTRIC, 0.1, 120),
    ];
    for (let i = 0; i < 200; i++) {
      eccSamples.push(sample(5 + i, ECCENTRIC, 0.1, 0));
    }
    const finalRep = rep(1, conc, phaseFrom(eccSamples));

    const out = finalizeReps([finalRep]);

    expect(out[0].eccentric.samples.length).toBe(3);
    expect(out[0].eccentric.samples.at(-1)?.velocity).toBe(120);
  });

  it('leaves a clean eccentric (no idle tail) untouched', () => {
    const before = cleanRep(1, 0);
    const out = finalizeReps([before]);
    expect(out[0].eccentric.samples.length).toBe(before.eccentric.samples.length);
  });
});

describe('finalizeReps — VMCP-02.69a signed peak recompute', () => {
  it('recomputes a stale concentric peak from its samples', () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 300), sample(1, CONCENTRIC, 0.5, 747)]);
    // Simulate the bench bug: the running-aggregate peak went stale (11) and
    // contradicts the 747 sample the phase actually holds.
    const stale: Phase = { ...conc, peakVelocity: 11 };
    const finalRep = rep(1, stale, phaseFrom([sample(2, ECCENTRIC, 0.1, 100)]));

    const out = finalizeReps([finalRep]);

    expect(out[0].concentric.peakVelocity).toBe(747);
  });

  it('keeps the sign when the largest-magnitude eccentric sample is negative', () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 400), sample(1, CONCENTRIC, 0.5, 600)]);
    // SDK reports eccentric velocity negative; the analytics aggregate abs()es
    // it. Recompute must surface the signed value, not the magnitude.
    const ecc = phaseFrom([sample(2, ECCENTRIC, 0.5, -300), sample(3, ECCENTRIC, 0.1, -800)]);
    expect(ecc.peakVelocity).toBeGreaterThan(0); // aggregate is magnitude-only

    const out = finalizeReps([rep(1, conc, ecc)]);

    expect(out[0].eccentric.peakVelocity).toBe(-800);
  });
});
