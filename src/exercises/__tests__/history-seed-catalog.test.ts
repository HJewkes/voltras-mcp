// The history catalog (VW-558, H1): free-weight and machine lifts that the imported
// training history names, kept apart from the cable seed so no series pools their loads.

import { getExerciseById, setCatalog } from '@voltras/workout-analytics';
import { beforeAll, describe, expect, it } from 'vitest';

import { HISTORY_SEED_EXERCISES } from '../history-seed-catalog.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

const CABLE_IDS = new Set(SEED_CABLE_EXERCISES.map((exercise) => exercise.id));

// A synthetic slice of the retro map: the log name and the catalog id it resolves to.
const MAIN_LIFT_MAP = [
  { logName: 'Press', catalogId: 'barbell-overhead-press' },
  { logName: 'Bench Press', catalogId: 'barbell-bench-press' },
  { logName: 'Barbell Row', catalogId: 'barbell-row' },
  { logName: 'Squat', catalogId: 'barbell-back-squat' },
  { logName: 'Lat Pulldown', catalogId: 'machine-lat-pulldown' },
  { logName: 'Deadlift', catalogId: 'barbell-deadlift' },
  { logName: 'Pendulum Squat', catalogId: 'machine-pendulum-squat' },
];

describe('HISTORY_SEED_EXERCISES', () => {
  beforeAll(() => {
    setCatalog([...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES]);
  });

  it('resolves every mapped main-lift id through getById', () => {
    for (const { catalogId } of MAIN_LIFT_MAP) {
      expect(getExerciseById(catalogId), catalogId).toBeDefined();
    }
  });

  it('points no main lift at a cable seed id', () => {
    for (const { logName, catalogId } of MAIN_LIFT_MAP) {
      expect(CABLE_IDS.has(catalogId), `${logName} -> ${catalogId}`).toBe(false);
    }
  });

  it('carries each main-lift log name as an alias of a history entry', () => {
    for (const { logName, catalogId } of MAIN_LIFT_MAP) {
      const owner = HISTORY_SEED_EXERCISES.find((exercise) =>
        [exercise.name, ...(exercise.aliases ?? [])].includes(logName),
      );
      expect(owner?.id, logName).toBe(catalogId);
    }
  });

  it('shares no id with the cable seed and repeats none of its own', () => {
    const ids = HISTORY_SEED_EXERCISES.map((exercise) => exercise.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(CABLE_IDS.has(id), id).toBe(false);
  });

  it('marks every entry as not cable-equivalent, with no cable setup', () => {
    for (const exercise of HISTORY_SEED_EXERCISES) {
      expect(exercise.cableEquivalent, exercise.id).toBe(false);
      expect(exercise.cableSetup, exercise.id).toBeUndefined();
    }
  });
});
