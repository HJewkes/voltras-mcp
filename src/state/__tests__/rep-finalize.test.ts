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

    const out = finalizeReps([unrack, real1, real2], { dropUnrackArtifact: true });

    expect(out.map((r) => r.repNumber)).toEqual([2, 3]);
  });

  it('preserves a zero-displacement rep (empty / single-sample) — not the artifact', () => {
    const empty = rep(1, phaseFrom([]), phaseFrom([]));
    const out = finalizeReps([empty], { dropUnrackArtifact: true });
    expect(out).toHaveLength(1);
  });

  it('keeps every rep with a positive-net-ROM concentric', () => {
    const out = finalizeReps([cleanRep(1, 0), cleanRep(2, 100)], {
      dropUnrackArtifact: true,
    });
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

    const out = finalizeReps([finalRep], { truncateFinalEccentric: true });

    expect(out[0].eccentric.samples.length).toBe(3);
    expect(out[0].eccentric.samples.at(-1)?.velocity).toBe(120);
  });

  it('leaves a clean eccentric (no idle tail) untouched', () => {
    const before = cleanRep(1, 0);
    const out = finalizeReps([before], { truncateFinalEccentric: true });
    expect(out[0].eccentric.samples.length).toBe(before.eccentric.samples.length);
  });
});

describe('finalizeReps — VMCP-02.69a peak recompute', () => {
  it('recomputes a stale concentric peak from its samples', () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 300), sample(1, CONCENTRIC, 0.5, 747)]);
    // Simulate the bench bug: the running-aggregate peak went stale (11) and
    // contradicts the 747 sample the phase actually holds.
    const stale: Phase = { ...conc, peakVelocity: 11 };
    const finalRep = rep(1, stale, phaseFrom([sample(2, ECCENTRIC, 0.1, 100)]));

    const out = finalizeReps([finalRep]);

    expect(out[0].concentric.peakVelocity).toBe(747);
  });

  it('reports the magnitude when the largest eccentric sample is negative', () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 400), sample(1, CONCENTRIC, 0.5, 600)]);
    // SDK reports eccentric velocity negative; the analytics aggregate abs()es
    // it. VMCP-05.14: the recompute matches that magnitude convention rather
    // than reintroducing the sign — a signed peak here disagreed with the live
    // `rep_finalized` event and zeroed `getPhaseVelocityDropPct`, whose first
    // line returns 0 for any non-positive peak.
    const ecc = phaseFrom([sample(2, ECCENTRIC, 0.5, -300), sample(3, ECCENTRIC, 0.1, -800)]);
    expect(ecc.peakVelocity).toBeGreaterThan(0); // aggregate is magnitude-only

    const out = finalizeReps([rep(1, conc, ecc)]);

    expect(out[0].eccentric.peakVelocity).toBe(800);
  });
});

/** The un-rack artifact: a "concentric" that ends below where it began. */
function unrackRep(repNumber: number): Rep {
  const conc = phaseFrom([sample(0, CONCENTRIC, 609, -5), sample(1, CONCENTRIC, 592, -3)]);
  return rep(repNumber, conc, phaseFrom([]));
}

/** A rep whose eccentric holds `movement` real samples then a long parked tail. */
function repWithIdleTail(repNumber: number, base: number, movement: number): Rep {
  const eccSamples: WorkoutSample[] = [];
  for (let i = 0; i < movement; i++) {
    eccSamples.push(sample(base + i, ECCENTRIC, 0.5 - i * 0.1, 300 - i * 100));
  }
  for (let i = 0; i < 200; i++) {
    eccSamples.push(sample(base + movement + i, ECCENTRIC, 0.1, 0));
  }
  return rep(repNumber, cleanRep(repNumber, base + 500).concentric, phaseFrom(eccSamples));
}

describe('finalizeReps — the 02.66 / 02.65 combination matrix', () => {
  // Each half is now gated separately, so all four combinations are reachable.
  // 02.69a runs in every one of them. The dependency order (02.66 filter
  // before 02.65 truncate) must hold in each, which is what the "both on" case
  // asserts by naming which rep got trimmed.
  const cases = [
    { drop: false, truncate: false, repNumbers: [1, 2], tailTrimmed: false },
    { drop: true, truncate: false, repNumbers: [2], tailTrimmed: false },
    { drop: false, truncate: true, repNumbers: [1, 2], tailTrimmed: true },
    { drop: true, truncate: true, repNumbers: [2], tailTrimmed: true },
  ];

  for (const { drop, truncate, repNumbers, tailTrimmed } of cases) {
    it(`drop=${drop} truncate=${truncate} keeps reps [${repNumbers.join(',')}], tail trimmed=${tailTrimmed}`, () => {
      const stale = repWithIdleTail(2, 100, 3);
      const withStalePeak: Rep = {
        ...stale,
        concentric: { ...stale.concentric, peakVelocity: 11 },
      };

      const out = finalizeReps([unrackRep(1), withStalePeak], {
        dropUnrackArtifact: drop,
        truncateFinalEccentric: truncate,
      });

      expect(out.map((r) => r.repNumber)).toEqual(repNumbers);
      const last = out[out.length - 1];
      expect(last.eccentric.samples.length).toBe(tailTrimmed ? 3 : 203);
      expect(last.concentric.peakVelocity).toBe(600); // 02.69a, ungated
    });
  }

  it('runs the 02.66 filter BEFORE the 02.65 truncate', () => {
    // Order discriminator: the phantom is the LAST rep and carries its own idle
    // tail. Filter-then-truncate drops it and trims rep 1; the reverse order
    // trims the doomed phantom and leaves rep 1's tail on the persisted set.
    const real = repWithIdleTail(1, 100, 3);
    const phantom = rep(2, unrackRep(2).concentric, repWithIdleTail(2, 400, 3).eccentric);

    const out = finalizeReps([real, phantom], {
      dropUnrackArtifact: true,
      truncateFinalEccentric: true,
    });

    expect(out.map((r) => r.repNumber)).toEqual([1]);
    expect(out[0].eccentric.samples.length).toBe(3);
  });
});

describe('finalizeReps — truncation with a phantom un-rack rep present', () => {
  // Newly reachable by default: 02.65 on with 02.66 off. The truncation only
  // ever touches the LAST rep, and the un-rack artifact is a LEADING rep, so
  // leaving the phantom in place does not move the truncation's target.
  it('trims the same rep whether or not the leading phantom was dropped', () => {
    const real = repWithIdleTail(2, 100, 3);

    const withPhantom = finalizeReps([unrackRep(1), real], { truncateFinalEccentric: true });
    const withoutPhantom = finalizeReps([unrackRep(1), real], {
      dropUnrackArtifact: true,
      truncateFinalEccentric: true,
    });

    expect(withPhantom[1].eccentric.samples).toEqual(withoutPhantom[0].eccentric.samples);
    expect(withPhantom[1].eccentric.samples.length).toBe(3);
  });

  it('leaves a phantom-only set at one rep and touches no other rep', () => {
    // Degenerate case: the phantom IS the last rep. Its empty eccentric has no
    // movement sample to anchor on, so the truncation is a documented no-op.
    const out = finalizeReps([unrackRep(1)], { truncateFinalEccentric: true });

    expect(out.map((r) => r.repNumber)).toEqual([1]);
    expect(out[0].eccentric.samples).toEqual([]);
  });
});

describe('finalizeReps — 02.69a is gated by neither flag', () => {
  it('recomputes peaks with both segmentation corrections off', () => {
    const conc = phaseFrom([sample(0, CONCENTRIC, 0.1, 300), sample(1, CONCENTRIC, 0.5, 747)]);
    const stale: Phase = { ...conc, peakVelocity: 11 };
    const finalRep = rep(1, stale, phaseFrom([sample(2, ECCENTRIC, 0.1, 100)]));

    const out = finalizeReps([finalRep], {
      dropUnrackArtifact: false,
      truncateFinalEccentric: false,
    });

    expect(out[0].concentric.peakVelocity).toBe(747);
  });
});
