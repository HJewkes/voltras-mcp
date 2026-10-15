// `deriveExerciseTargets` and `buildDerivedPrescriptionView` (VW-642): last
// time's working sets become a labelled prescription, and nothing else does.

import { describe, expect, it } from 'vitest';

import {
  buildDerivedPrescriptionView,
  deriveExerciseTargets,
  type DerivableSet,
} from '../read-models/derived-prescription.js';

function set(reps: number, overrides: Partial<DerivableSet> = {}): DerivableSet {
  return { reps: Array.from({ length: reps }, (_, i) => i), weightLbs: 100, ...overrides };
}

describe('deriveExerciseTargets', () => {
  it('ignores warm-up, probe, technique and 0-rep sets', () => {
    const targets = deriveExerciseTargets([
      set(12, { setPurpose: 'warmup', weightLbs: 40 }),
      set(1, { setPurpose: 'probe', weightLbs: 200 }),
      set(5, { setPurpose: 'technique', weightLbs: 20 }),
      set(0, { weightLbs: 300 }),
      set(8),
      set(8, { setPurpose: 'working' }),
    ]);

    expect(targets).toEqual({ sets: 2, repsLow: 8, weightLbs: 100 });
  });

  it('gives a rep range when working sets differed', () => {
    expect(deriveExerciseTargets([set(10), set(9), set(8)])).toMatchObject({
      repsLow: 8,
      repsHigh: 10,
    });
  });

  it('gives one rep count when every working set matched', () => {
    const targets = deriveExerciseTargets([set(10), set(10)]);

    expect(targets?.repsLow).toBe(10);
    expect(targets).not.toHaveProperty('repsHigh');
  });

  it('takes the heaviest working load', () => {
    const targets = deriveExerciseTargets([
      set(8, { weightLbs: 95 }),
      set(8, { weightLbs: 105 }),
      set(8, { weightLbs: 100 }),
    ]);

    expect(targets?.weightLbs).toBe(105);
  });

  it('omits the load when no working set recorded one', () => {
    const targets = deriveExerciseTargets([set(8, { weightLbs: undefined })]);

    expect(targets).not.toHaveProperty('weightLbs');
  });

  it('counts sets per side, so three per side reads as three', () => {
    const sides = (['left', 'right'] as const).flatMap((side) =>
      [1, 2, 3].map(() => set(8, { side })),
    );

    expect(deriveExerciseTargets(sides)?.sets).toBe(3);
  });

  it('counts side-unknown sets as their own group', () => {
    const targets = deriveExerciseTargets([set(8, { side: 'left' }), set(8), set(8)]);

    expect(targets?.sets).toBe(2);
  });

  it('returns null when nothing was a working set', () => {
    expect(deriveExerciseTargets([])).toBeNull();
    expect(deriveExerciseTargets([set(10, { setPurpose: 'warmup' }), set(0)])).toBeNull();
  });
});

describe('buildDerivedPrescriptionView', () => {
  it('labels the view derived with its date and a one-row active rail, and no coaching intent', () => {
    const view = buildDerivedPrescriptionView(
      {
        activeExerciseId: 'bench',
        targets: { sets: 3, repsLow: 8, repsHigh: 10, weightLbs: 135 },
        derivedFromStartedAt: '2026-05-08T10:00:00.000Z',
        today: '2026-05-11',
      },
      { getById: () => ({ name: 'Bench Press' }) },
    );

    expect(view).toEqual({
      source: 'derived',
      derivedFrom: { startedAt: '2026-05-08T10:00:00.000Z', daysAgo: 3, stale: false },
      sets: 3,
      repsLow: 8,
      repsHigh: 10,
      weightLbs: 135,
      exercises: [
        {
          exerciseId: 'bench',
          name: 'Bench Press',
          order: 0,
          sets: 3,
          repsLow: 8,
          repsHigh: 10,
          weightLbs: 135,
          active: true,
        },
      ],
    });
  });
});

describe('buildDerivedPrescriptionView age (VW-908)', () => {
  const build = (today: string) =>
    buildDerivedPrescriptionView(
      {
        activeExerciseId: 'bench',
        targets: { sets: 3, repsLow: 8 },
        derivedFromStartedAt: '2026-05-08T10:00:00.000Z',
        today,
      },
      undefined,
    );

  it('marks a view 26 days old stale with its day count', () => {
    expect(build('2026-06-03').derivedFrom).toMatchObject({ daysAgo: 26, stale: true });
  });

  it('keeps the 14th day fresh and the 15th stale', () => {
    expect(build('2026-05-22').derivedFrom).toMatchObject({ daysAgo: 14, stale: false });
    expect(build('2026-05-23').derivedFrom).toMatchObject({ daysAgo: 15, stale: true });
  });
});
