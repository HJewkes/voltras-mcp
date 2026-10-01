import { setCatalog } from '@voltras/workout-analytics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_SEED_EXERCISES } from '../history-seed-catalog.js';
import { riskClassOf } from '../risk-class.js';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';
import { loadSeedCatalog } from './load-seed-catalog.js';

describe('riskClassOf over the loaded catalogs', () => {
  beforeEach(loadSeedCatalog);

  it('classifies every cable seed catalog id', () => {
    for (const { id } of SEED_CABLE_EXERCISES) {
      expect(riskClassOf(id), id).not.toBeNull();
    }
  });

  it('classifies every history seed catalog id', () => {
    for (const { id } of HISTORY_SEED_EXERCISES) {
      expect(riskClassOf(id), id).not.toBeNull();
    }
  });

  it('reads an isolation lift as isolation, whatever its pattern', () => {
    expect(riskClassOf('cable-bicep-curl')).toBe('isolation');
    expect(riskClassOf('cable-face-pull')).toBe('isolation');
    expect(riskClassOf('cable-overhead-tricep-extension')).toBe('isolation');
  });

  it('reads a squat or hinge as a loaded compound', () => {
    expect(riskClassOf('cable-squat')).toBe('loaded_compound');
    expect(riskClassOf('cable-romanian-deadlift')).toBe('loaded_compound');
    expect(riskClassOf('barbell-back-squat')).toBe('loaded_compound');
    expect(riskClassOf('barbell-deadlift')).toBe('loaded_compound');
  });

  it('promotes a curated overhead press to a loaded compound', () => {
    expect(riskClassOf('cable-shoulder-press')).toBe('loaded_compound');
    expect(riskClassOf('barbell-overhead-press')).toBe('loaded_compound');
    expect(riskClassOf('dumbbell-shoulder-press')).toBe('loaded_compound');
  });

  it('promotes a curated free-bar lift to a loaded compound', () => {
    expect(riskClassOf('barbell-bench-press')).toBe('loaded_compound');
    expect(riskClassOf('barbell-row')).toBe('loaded_compound');
  });

  it('reads a row, chest press or pulldown as a supported compound', () => {
    expect(riskClassOf('cable-row')).toBe('supported_compound');
    expect(riskClassOf('cable-chest-press')).toBe('supported_compound');
    expect(riskClassOf('cable-lat-pulldown')).toBe('supported_compound');
    expect(riskClassOf('machine-lat-pulldown')).toBe('supported_compound');
  });

  it('reads an id the catalog does not carry as null', () => {
    expect(riskClassOf('not-in-the-catalog')).toBeNull();
  });

  it('reads an absent id as null, not the ramp-class default', () => {
    expect(riskClassOf(undefined)).toBeNull();
    expect(riskClassOf(null)).toBeNull();
  });
});

describe('riskClassOf over synthetic catalog rows', () => {
  afterEach(loadSeedCatalog);

  const row = (id: string, exerciseType: string, movementPattern: string) => ({
    id,
    name: id,
    muscleGroups: ['quads'],
    movementPattern,
    exerciseType,
    equipment: [{ name: 'Voltra', category: 'cable' }],
    cableEquivalent: true,
  });

  it('reads a single-leg squat as a loaded compound', () => {
    setCatalog([row('synthetic-split-squat', 'compound', 'squat')] as never);
    expect(riskClassOf('synthetic-split-squat')).toBe('loaded_compound');
  });

  it('reads a compound with a pattern it does not know as null', () => {
    setCatalog([row('synthetic-carry', 'compound', 'carry')] as never);
    expect(riskClassOf('synthetic-carry')).toBeNull();
  });

  it('reads an id as null when no catalog is loaded', () => {
    setCatalog([]);
    expect(riskClassOf('cable-squat')).toBeNull();
  });
});
