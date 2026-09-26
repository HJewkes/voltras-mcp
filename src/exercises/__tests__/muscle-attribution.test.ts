// VW-561: the attribution table's row rules (R1, R2, R18) and its two reads.

import { describe, expect, it } from 'vitest';

import {
  attributionFromPrimaries,
  attributionProblem,
  dayFrequencyCredit,
  doseWeights,
  resolveAttribution,
  targetMuscles,
  type AttributionRow,
} from '../muscle-attribution.js';

const row = (muscle: string, weight: 1 | 0.5 | 0, target = false): AttributionRow => ({
  muscle,
  weight,
  target,
});

describe('attribution rows (R1, R2)', () => {
  it('rejects a weight other than 1, 0.5 or 0', () => {
    expect(attributionProblem({ weight: 0.75, target: false })).toMatch(/not 1, 0.5 or 0/);
  });

  it('rejects a target row that does not weigh 1', () => {
    expect(attributionProblem({ weight: 0.5, target: true })).toMatch(/target row/);
  });

  it('accepts a non-target row at full weight', () => {
    expect(attributionProblem({ weight: 1, target: false })).toBeNull();
  });

  it('throws when resolving a broken row', () => {
    expect(() => resolveAttribution([row('chest', 0.5, true)])).toThrow(/chest/);
  });
});

describe('resolving rows onto slugs (R18)', () => {
  it('fans a catalog string out to its slugs at the row weight', () => {
    const rows = resolveAttribution([row('hamstrings', 1, true), row('back', 0.5)]);
    expect(rows).toEqual([
      { muscle: 'hamstrings', weight: 1, target: true },
      { muscle: 'lats', weight: 0.5, target: false },
      { muscle: 'upper_back', weight: 0.5, target: false },
    ]);
  });

  it('keeps a target when a fanned-out secondary lands on it', () => {
    const rows = resolveAttribution([row('quads', 1, true), row('adductors', 0.5)]);
    expect(rows).toEqual([{ muscle: 'quads', weight: 1, target: true }]);
  });

  it('takes the higher weight, never the sum, when two rows share a slug', () => {
    const rows = resolveAttribution([row('back', 0.5), row('traps', 0.5)]);
    expect(rows.find((r) => r.muscle === 'upper_back')).toEqual({
      muscle: 'upper_back',
      weight: 0.5,
      target: false,
    });
  });

  it('passes a delt slug through without fanning out', () => {
    expect(targetMuscles(resolveAttribution([row('front_delts', 1, true)]))).toEqual([
      'front_delts',
    ]);
  });
});

describe('the two reads', () => {
  const bench = resolveAttribution([
    row('chest', 1, true),
    row('triceps', 0.5),
    row('front_delts', 0.5),
  ]);

  it('landmark read counts target rows only (R3)', () => {
    expect(targetMuscles(bench)).toEqual(['chest']);
  });

  it('dose read sums every weighted row (R4)', () => {
    expect(Object.fromEntries(doseWeights(bench))).toEqual({
      chest: 1,
      triceps: 0.5,
      front_delts: 0.5,
    });
  });

  it('leaves a weight-0 row out of the dose read', () => {
    const hipThrust = resolveAttribution([row('glutes', 1, true), row('hamstrings', 0)]);
    expect([...doseWeights(hipThrust).keys()]).toEqual(['glutes']);
  });

  it('derives a pre-VW-561 entry as primary targets and half-weight secondaries', () => {
    expect(attributionFromPrimaries(['chest'], ['triceps'])).toEqual([
      row('chest', 1, true),
      row('triceps', 0.5),
    ]);
  });
});

describe('day frequency credit (R14, R15)', () => {
  const deadlift = resolveAttribution([row('hamstrings', 1, true), row('glutes', 0.5)]);
  const hipThrust = resolveAttribution([row('glutes', 1, true), row('hamstrings', 0)]);

  it('credits a target 1 and a muscle hit only through a weighted row 0.5', () => {
    expect(Object.fromEntries(dayFrequencyCredit([deadlift]))).toEqual({
      hamstrings: 1,
      glutes: 0.5,
    });
  });

  it('credits 1 when any exercise that day targets the muscle', () => {
    expect(dayFrequencyCredit([deadlift, hipThrust]).get('glutes')).toBe(1);
  });

  it('gives no credit through a weight-0 row', () => {
    expect(dayFrequencyCredit([hipThrust]).has('hamstrings')).toBe(false);
  });
});
