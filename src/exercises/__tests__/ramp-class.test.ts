import * as analytics from '@voltras/workout-analytics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogNotLoadedError, rampClassForExerciseId, rampClassOf } from '../ramp-class.js';
import { HISTORY_SEED_EXERCISES } from '../history-seed-catalog.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

describe('rampClassOf', () => {
  it('reads any isolation-typed exercise as isolation, whatever its pattern', () => {
    expect(rampClassOf({ exerciseType: 'isolation', movementPattern: 'pull' })).toBe('isolation');
  });

  it('reads a squat or hinge compound as lower body', () => {
    expect(rampClassOf({ exerciseType: 'compound', movementPattern: 'squat' })).toBe(
      'lower_compound',
    );
    expect(rampClassOf({ exerciseType: 'compound', movementPattern: 'hinge' })).toBe(
      'lower_compound',
    );
  });

  it('reads every other compound as upper body', () => {
    for (const movementPattern of ['push', 'pull', 'rotation']) {
      expect(rampClassOf({ exerciseType: 'compound', movementPattern })).toBe('upper_compound');
    }
  });

  it('reads a missing row as the unknown-class default', () => {
    expect(rampClassOf(undefined)).toBe('upper_compound');
  });
});

const setCatalog = (rows: unknown[]): void =>
  (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(rows);
const loadSeedCatalog = (): void =>
  setCatalog([...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES]);

describe('rampClassForExerciseId on an unloaded catalog', () => {
  beforeEach(() => setCatalog([]));
  afterEach(loadSeedCatalog);

  it('throws CATALOG_NOT_LOADED instead of returning the default', () => {
    expect(() => rampClassForExerciseId('barbell-back-squat')).toThrow(CatalogNotLoadedError);
    expect(() => rampClassForExerciseId('barbell-back-squat')).toThrow(/CATALOG_NOT_LOADED/);
  });

  it('returns the default for a null id without touching the catalog', () => {
    expect(rampClassForExerciseId(null)).toBe('upper_compound');
    expect(rampClassForExerciseId(undefined)).toBe('upper_compound');
  });
});

describe('rampClassForExerciseId', () => {
  beforeEach(loadSeedCatalog);

  it('places the seed catalog lifts', () => {
    expect(rampClassForExerciseId('cable-overhead-tricep-extension')).toBe('isolation');
    expect(rampClassForExerciseId('cable-face-pull')).toBe('isolation');
    expect(rampClassForExerciseId('cable-chest-press')).toBe('upper_compound');
    expect(rampClassForExerciseId('cable-romanian-deadlift')).toBe('lower_compound');
  });

  it('places the history catalog lifts', () => {
    expect(rampClassForExerciseId('barbell-back-squat')).toBe('lower_compound');
    expect(rampClassForExerciseId('barbell-deadlift')).toBe('lower_compound');
    expect(rampClassForExerciseId('machine-leg-press')).toBe('lower_compound');
    expect(rampClassForExerciseId('barbell-bench-press')).toBe('upper_compound');
    expect(rampClassForExerciseId('barbell-overhead-press')).toBe('upper_compound');
    expect(rampClassForExerciseId('barbell-row')).toBe('upper_compound');
    expect(rampClassForExerciseId('barbell-curl')).toBe('isolation');
    expect(rampClassForExerciseId('machine-standing-calf-raise')).toBe('isolation');
  });

  it('reads an absent or uncatalogued id as the unknown-class default', () => {
    expect(rampClassForExerciseId(null)).toBe('upper_compound');
    expect(rampClassForExerciseId('not-in-the-catalog')).toBe('upper_compound');
  });
});
