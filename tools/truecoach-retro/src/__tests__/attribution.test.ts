// VW-561: the owner's attribution rulings as the retro reads them. Synthetic entries and rows only.

import { describe, expect, it } from 'vitest';

import type { AttributionRow } from '../../../../src/exercises/muscle-attribution.js';
import { frequencyReads } from '../checks/adherence.js';
import { muscleVerdicts } from '../checks/missed.js';
import { buildContext } from '../context.js';
import { buildExerciseLookup } from '../exercise-map.js';
import type { ExerciseMapEntry } from '../types.js';
import {
  volumeStatus,
  weeklyDoseByMuscle,
  weeklyDoseFrequencyByMuscle,
  weeklyFrequencyByMuscle,
  weeklySetsByMuscle,
} from '../weekly.js';

import { setRow } from './fixtures.js';

const t = (muscle: string): AttributionRow => ({ muscle, weight: 1, target: true });
const w = (muscle: string, weight: 1 | 0.5 | 0 = 0.5): AttributionRow => ({
  muscle,
  weight,
  target: false,
});

function entry(log_name: string, muscles: AttributionRow[], extra: Partial<ExerciseMapEntry> = {}) {
  return { log_name, muscles, family: null, main_lift: false, ...extra };
}

const MAP: ExerciseMapEntry[] = [
  entry('Deadlift', [t('hamstrings'), w('glutes'), w('back'), w('quads')]),
  entry('Stiff Leg', [t('hamstrings'), w('glutes'), w('back', 0)]),
  entry('Hip Thrust', [t('glutes'), w('hamstrings', 0)]),
  entry('Squat', [t('quads'), w('glutes'), w('adductors'), w('hamstrings', 0)]),
  entry('Overhead Press', [
    t('front_delts'),
    w('triceps'),
    w('side_delts'),
    w('rear_delts', 0),
    w('traps', 0),
  ]),
  entry('Bench', [t('chest'), w('triceps'), w('front_delts')]),
  entry('Close Grip', [t('chest'), w('triceps', 1), w('front_delts')]),
  entry('Hinge Warmup', [t('hamstrings'), w('glutes')], { warmup: true }),
];
const lookup = buildExerciseLookup(MAP);

const MONDAY = '2030-01-07';
const THURSDAY = '2030-01-10';
const rowsOf = (name: string, sets: number, date = MONDAY) =>
  setRow({ exercise_name: name, sets, workout_due_date: date });
const weekOf = (map: Map<string, Map<string, number>>) => Object.fromEntries(map.get(MONDAY)!);

describe('conventional deadlift (Q2, R6)', () => {
  const rows = [rowsOf('Deadlift', 4)];

  it('counts toward hamstrings only in the landmark read', () => {
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ hamstrings: 4 });
  });

  it('gives glutes, lats, upper back and quads half a set each in the dose read', () => {
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).toEqual({
      hamstrings: 4,
      glutes: 2,
      lats: 2,
      upper_back: 2,
      quads: 2,
    });
  });
});

describe('hinges and hip thrust (Q3, R7, R8)', () => {
  it('gives a stiff-legged deadlift no glute target and no back dose', () => {
    const rows = [rowsOf('Stiff Leg', 3)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ hamstrings: 3 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).toEqual({ hamstrings: 3, glutes: 1.5 });
  });

  it('gives a hip thrust glutes only, in both reads', () => {
    const rows = [rowsOf('Hip Thrust', 3)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ glutes: 3 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).toEqual({ glutes: 3 });
  });

  it('counts a warm-up entry in neither read nor in the missed-session runs (R8b)', () => {
    const rows = [rowsOf('Hinge Warmup', 2), rowsOf('Bench', 1)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ chest: 1 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).not.toHaveProperty('hamstrings');
    const ctx = buildContext([rowsOf('Hinge Warmup', 2)], [], MAP, null);
    expect(muscleVerdicts(ctx)).toEqual([]);
  });

  it('draws no landmark band for glutes, at any set count (R8c)', () => {
    expect(volumeStatus('glutes', 0)).toBeNull();
    expect(volumeStatus('glutes', 20)).toBeNull();
    expect(volumeStatus('hamstrings', 0)).toBe('under');
  });
});

describe('squats (R9)', () => {
  it('gives hamstrings nothing and keeps quads a single full target', () => {
    const rows = [rowsOf('Squat', 4)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ quads: 4 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).toEqual({ quads: 4, glutes: 2 });
  });
});

describe('delts split by head (Q4, R13)', () => {
  it('counts an overhead press toward front delts only in the landmark read', () => {
    const rows = [rowsOf('Overhead Press', 3)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ front_delts: 3 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup))).toEqual({
      front_delts: 3,
      triceps: 1.5,
      side_delts: 1.5,
    });
  });

  it('gives bench front delts half a set in the dose read and none in the landmark read', () => {
    const rows = [rowsOf('Bench', 2)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ chest: 2 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup)).front_delts).toBe(1);
  });

  it('lets a non-target row weigh 1 in the dose read without entering the landmark read', () => {
    const rows = [rowsOf('Close Grip', 2)];
    expect(weekOf(weeklySetsByMuscle(rows, lookup))).toEqual({ chest: 2 });
    expect(weekOf(weeklyDoseByMuscle(rows, lookup)).triceps).toBe(2);
  });
});

describe('frequency (Q5, R14, R15)', () => {
  const rows = [rowsOf('Deadlift', 3), rowsOf('Squat', 3, THURSDAY)];

  it('counts a day only for muscles one of its exercises targets', () => {
    expect(weekOf(weeklyFrequencyByMuscle(rows, lookup))).toEqual({ hamstrings: 1, quads: 1 });
  });

  it('counts a secondary-only day as half a session in the dose frequency', () => {
    expect(weekOf(weeklyDoseFrequencyByMuscle(rows, lookup))).toEqual({
      hamstrings: 1,
      glutes: 1,
      lats: 0.5,
      upper_back: 0.5,
      quads: 1.5,
    });
  });

  it('does not count a day whose only row reports zero sets', () => {
    const empty = [rowsOf('Deadlift', 0), rowsOf('Bench', 1)];
    expect(weekOf(weeklyFrequencyByMuscle(empty, lookup))).toEqual({ chest: 1 });
  });

  it('lists a muscle hit only through weighted rows with no landmark weeks', () => {
    const ctx = buildContext(rows, [], MAP, null);
    const glutes = frequencyReads(ctx).find((r) => r.muscle === 'glutes')!;
    expect(glutes.weeksTrained).toBe(0);
    expect(glutes.doseMeanWhenHit).toBe(1);
  });
});

describe('related muscles for the systemic-week rule (R19)', () => {
  it('relates a target to its weighted rows and not to its weight-0 rows', () => {
    expect(lookup.related('front_delts', 'side_delts')).toBe(true);
    expect(lookup.related('front_delts', 'rear_delts')).toBe(false);
  });

  it('no longer relates hamstrings to glutes through a hip thrust', () => {
    const only = buildExerciseLookup([entry('Hip Thrust', [t('glutes'), w('hamstrings', 0)])]);
    expect(only.related('glutes', 'hamstrings')).toBe(false);
  });
});

describe('map validation (R1, R2)', () => {
  it('names the entry whose row breaks a rule', () => {
    const broken = entry('Odd Lift', [{ muscle: 'chest', weight: 0.5, target: true }]);
    expect(() => buildExerciseLookup([broken])).toThrow(/Odd Lift/);
  });
});
