// Unit tests for the pure tier-seeded starting prescription (VMCP-06.04 / B39).
//
// Tested directly rather than through the tool because the tier signal cannot
// currently PRODUCE `advanced` — its derived ceiling stops at `intermediate`
// (tier-signal.ts §3.5) — and the advanced seeds are the ones with the
// interesting behaviour (`reported_minus_one`).

import { describe, it, expect } from 'vitest';
import { startingPrescription, type StartingPrescriptionInput } from '../starting-prescription.js';

function declared(over: Partial<StartingPrescriptionInput> = {}): StartingPrescriptionInput {
  return { tier: 'beginner', confidence: 'confident', source: 'declared', ...over };
}

describe('per-tier seeds', () => {
  it('seeds a beginner at 2-3 sessions, 2 sets, and no RIR target', () => {
    const p = startingPrescription(declared({ tier: 'beginner' }));

    expect(p.seeds.sessionsPerWeek).toEqual([2, 3]);
    expect(p.seeds.setsPerExercise).toEqual([2, 2]);
    expect(p.seeds.rirTarget).toBeNull();
    expect(p.seeds.rirNote).toContain('Do not track RIR');
  });

  it('seeds an intermediate at 3-4 sessions, the 2-4 attractor, and about 3 RIR', () => {
    const p = startingPrescription(declared({ tier: 'intermediate' }));

    expect(p.seeds.sessionsPerWeek).toEqual([3, 4]);
    expect(p.seeds.setsPerExercise).toEqual([2, 4]);
    expect(p.seeds.rirTarget).toBe(3);
  });

  it('seeds an advanced lifter at 4-6 sessions and 2 RIR', () => {
    const p = startingPrescription(declared({ tier: 'advanced' }));

    expect(p.seeds.sessionsPerWeek).toEqual([4, 6]);
    expect(p.seeds.rirTarget).toBe(2);
  });

  it('gives one reason line per seed', () => {
    const p = startingPrescription(declared({ tier: 'intermediate' }));

    expect(p.reasons).toHaveLength(3);
    expect(p.reasons[0]).toContain('Sessions/week');
    expect(p.reasons[1]).toContain('Sets/exercise');
    expect(p.reasons[2]).toContain('RIR');
  });
});

describe('advanced sets/exercise', () => {
  it('pulls one set off what the lifter reported running per muscle', () => {
    const p = startingPrescription(declared({ tier: 'advanced', reportedSetsPerMuscle: 4 }));

    expect(p.seeds.setsPerExercise).toEqual([3, 3]);
  });

  it('asks for the report rather than guessing when none was given', () => {
    const p = startingPrescription(declared({ tier: 'advanced' }));

    expect(p.seeds.setsPerExercise).toBe('reported_minus_one');
    expect(p.reasons[1]).toContain('ask what they are currently running');
  });

  it('never seeds below one set, however low the report', () => {
    const p = startingPrescription(declared({ tier: 'advanced', reportedSetsPerMuscle: 1 }));

    expect(p.seeds.setsPerExercise).toEqual([1, 1]);
  });
});

describe('daysReliable', () => {
  it('caps the session ceiling at the days they can definitely make', () => {
    const p = startingPrescription(declared({ tier: 'beginner', daysReliable: 2 }));

    expect(p.seeds.sessionsPerWeek).toEqual([2, 2]);
    expect(p.reasons[0]).toContain('DEFINITELY');
  });

  it('pulls the floor down with the ceiling when it has to', () => {
    const p = startingPrescription(declared({ tier: 'advanced', daysReliable: 3 }));

    expect(p.seeds.sessionsPerWeek).toEqual([3, 3]);
  });

  it('leaves the seed alone when it is already inside what they can make', () => {
    const p = startingPrescription(declared({ tier: 'beginner', daysReliable: 6 }));

    expect(p.seeds.sessionsPerWeek).toEqual([2, 3]);
  });
});

describe('effortTolerance', () => {
  it('softens the RIR note and nothing else when tolerance is low', () => {
    const base = startingPrescription(declared({ tier: 'intermediate' }));

    const low = startingPrescription(declared({ tier: 'intermediate', effortTolerance: 'low' }));

    expect(low.seeds.rirNote).toContain('conservative end');
    expect(low.seeds.rirTarget).toBe(base.seeds.rirTarget);
    expect(low.seeds.setsPerExercise).toEqual(base.seeds.setsPerExercise);
    expect(low.seeds.sessionsPerWeek).toEqual(base.seeds.sessionsPerWeek);
  });

  it('says nothing extra at moderate or high tolerance', () => {
    const p = startingPrescription(declared({ tier: 'intermediate', effortTolerance: 'high' }));

    expect(p.seeds.rirNote).not.toContain('conservative end');
  });
});

describe('assumesBeginner', () => {
  it('is true when no tier was ever declared, and says so in the reasons', () => {
    const p = startingPrescription({
      tier: 'beginner',
      confidence: 'provisional',
      source: 'default',
    });

    expect(p.assumesBeginner).toBe(true);
    expect(p.reasons.at(-1)).toContain('assume a beginner');
  });

  it('is false once a tier has been declared', () => {
    const p = startingPrescription(declared({ tier: 'intermediate' }));

    expect(p.assumesBeginner).toBe(false);
    expect(p.reasons.some((r) => r.includes('assume a beginner'))).toBe(false);
  });
});
