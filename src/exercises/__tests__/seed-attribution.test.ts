// VW-561: the seed catalog's attribution table and the invariants that tie it to the catalog.

import { describe, expect, it } from 'vitest';

import { doseWeights, resolveAttribution, targetMuscles } from '../muscle-attribution.js';
import { MUSCLE_MAP_VERSION, mapCatalogMuscle } from '../muscle-map.js';
import { HISTORY_SEED_EXERCISES } from '../history-seed-catalog.js';
import {
  HISTORY_ATTRIBUTION,
  SEED_ATTRIBUTION,
  attributionOfExercise,
} from '../seed-attribution.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

const byId = new Map(SEED_CABLE_EXERCISES.map((exercise) => [exercise.id, exercise]));
const targetsOf = (id: string) => targetMuscles(attributionOfExercise(byId.get(id)!));
const doseOf = (id: string) =>
  Object.fromEntries(doseWeights(attributionOfExercise(byId.get(id)!)));

describe('SEED_ATTRIBUTION', () => {
  it('holds exactly the seed catalog ids', () => {
    expect(Object.keys(SEED_ATTRIBUTION).sort()).toEqual([...byId.keys()].sort());
  });

  it('holds only rows that pass R1 and R2', () => {
    for (const rows of Object.values(SEED_ATTRIBUTION)) {
      expect(() => resolveAttribution(rows)).not.toThrow();
    }
  });

  it('narrows each entry target from its catalog primary and never leaves it', () => {
    for (const exercise of SEED_CABLE_EXERCISES) {
      const allowed = mapCatalogMuscle(exercise.muscleGroups[0]!);
      const targets = targetsOf(exercise.id);
      expect(targets.length, exercise.id).toBeGreaterThan(0);
      expect(allowed, exercise.id).toEqual(expect.arrayContaining(targets));
    }
  });

  it('is stamped by a map version bumped for VW-561', () => {
    expect(MUSCLE_MAP_VERSION).toBe('2026-09-26.2');
  });
});

describe('the owner rulings on the live catalog', () => {
  it('splits the delts: shoulder press targets front delts only (Q4)', () => {
    expect(targetsOf('cable-shoulder-press')).toEqual(['front_delts']);
    expect(doseOf('cable-shoulder-press')).toEqual({
      front_delts: 1,
      triceps: 0.5,
      side_delts: 0.5,
    });
  });

  it('gives each raise and fly its own head', () => {
    expect(targetsOf('cable-lateral-raise')).toEqual(['side_delts']);
    expect(targetsOf('cable-front-raise')).toEqual(['front_delts']);
    expect(targetsOf('cable-rear-delt-fly')).toEqual(['rear_delts']);
  });

  it('gives a chest press front delts half a set in the dose read only (Q4)', () => {
    expect(targetsOf('cable-chest-press')).toEqual(['chest']);
    expect(doseOf('cable-chest-press').front_delts).toBe(0.5);
  });

  it('targets hamstrings on the Romanian deadlift with glutes at half (Q3)', () => {
    expect(targetsOf('cable-romanian-deadlift')).toEqual(['hamstrings']);
    expect(doseOf('cable-romanian-deadlift')).toEqual({ hamstrings: 1, glutes: 0.5 });
  });

  it('gives the squat no hamstring credit in either read (R9)', () => {
    expect(targetsOf('cable-squat')).toEqual(['quads']);
    expect(doseOf('cable-squat')).toEqual({ quads: 1, glutes: 0.5 });
  });

  it('falls back to the catalog strings for an id the table does not hold', () => {
    const custom = { id: 'not-in-seed', muscleGroups: ['back'], secondaryMuscleGroups: ['biceps'] };
    expect(targetMuscles(attributionOfExercise(custom))).toEqual(['lats', 'upper_back']);
    expect(Object.fromEntries(doseWeights(attributionOfExercise(custom))).biceps).toBe(0.5);
  });
});

describe('HISTORY_ATTRIBUTION', () => {
  const historyById = new Map(HISTORY_SEED_EXERCISES.map((exercise) => [exercise.id, exercise]));
  const historyTargets = (id: string) => targetMuscles(attributionOfExercise(historyById.get(id)!));
  const historyDose = (id: string) =>
    Object.fromEntries(doseWeights(attributionOfExercise(historyById.get(id)!)));

  it('holds exactly the history catalog ids and none of the cable ids', () => {
    expect(Object.keys(HISTORY_ATTRIBUTION).sort()).toEqual([...historyById.keys()].sort());
    for (const id of Object.keys(HISTORY_ATTRIBUTION)) expect(SEED_ATTRIBUTION[id]).toBeUndefined();
  });

  it('holds only rows that pass R1 and R2', () => {
    for (const rows of Object.values(HISTORY_ATTRIBUTION)) {
      expect(() => resolveAttribution(rows)).not.toThrow();
    }
  });

  it('narrows each entry target from its catalog primary and never leaves it', () => {
    for (const exercise of HISTORY_SEED_EXERCISES) {
      const allowed = mapCatalogMuscle(exercise.muscleGroups[0]!);
      const targets = historyTargets(exercise.id);
      expect(targets.length, exercise.id).toBeGreaterThan(0);
      expect(allowed, exercise.id).toEqual(expect.arrayContaining(targets));
    }
  });

  it('targets hamstrings only on a deadlift, the rest at half dose', () => {
    expect(historyTargets('barbell-deadlift')).toEqual(['hamstrings']);
    expect(historyDose('barbell-deadlift')).toEqual({
      hamstrings: 1,
      glutes: 0.5,
      lats: 0.5,
      upper_back: 0.5,
      quads: 0.5,
    });
  });

  it('gives a Romanian deadlift no back dose', () => {
    expect(historyDose('barbell-romanian-deadlift')).toEqual({ hamstrings: 1, glutes: 0.5 });
  });

  it('targets glutes on a sumo deadlift and hamstrings on a trap-bar one', () => {
    expect(historyTargets('barbell-sumo-deadlift')).toEqual(['glutes']);
    expect(historyTargets('barbell-trap-bar-deadlift')).toEqual(['hamstrings']);
  });

  it('gives a back squat no hamstring credit', () => {
    expect(historyTargets('barbell-back-squat')).toEqual(['quads']);
    expect(historyDose('barbell-back-squat')).toEqual({ quads: 1, glutes: 0.5 });
  });
});
