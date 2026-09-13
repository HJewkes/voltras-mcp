// VW-328: catalog->titan muscle map. Table-driven over every seed-catalog
// string plus a coverage check derived from the seed file itself, so a new
// seed string with no mapping row fails loudly instead of silently mapping
// to [].

import { describe, it, expect } from 'vitest';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';
import { mapCatalogMuscle, TITAN_MUSCLE_GROUPS } from '../muscle-map.js';
import type { TitanMuscleGroup } from '../muscle-map.js';

const EXPECTED: Record<string, TitanMuscleGroup[]> = {
  chest: ['chest'],
  shoulders: ['front_delts', 'side_delts', 'rear_delts'],
  triceps: ['triceps'],
  back: ['lats', 'upper_back'],
  biceps: ['biceps'],
  forearms: ['forearms'],
  quads: ['quads'],
  hamstrings: ['hamstrings'],
  glutes: ['glutes'],
  adductors: ['quads'],
  abductors: ['glutes'],
  obliques: ['obliques'],
  core: ['abs', 'obliques'],
  abs: ['abs'],
  traps: ['upper_back'],
};

function seedCatalogMuscleStrings(): Set<string> {
  const strings = new Set<string>();
  for (const ex of SEED_CABLE_EXERCISES) {
    for (const g of ex.muscleGroups) strings.add(g);
    for (const g of ex.secondaryMuscleGroups ?? []) strings.add(g);
  }
  return strings;
}

describe('mapCatalogMuscle', () => {
  it.each(Object.entries(EXPECTED))('maps "%s" to %j', (catalogString, expected) => {
    expect(mapCatalogMuscle(catalogString)).toEqual(expected);
  });

  it('maps an unrecognised string to []', () => {
    expect(mapCatalogMuscle('not-a-real-muscle-group')).toEqual([]);
  });

  it('every string the seed catalog actually uses has a row above', () => {
    const seedStrings = seedCatalogMuscleStrings();
    expect(seedStrings.size, [...seedStrings].sort().join(', ')).toBe(Object.keys(EXPECTED).length);
    for (const s of seedStrings) {
      expect(Object.keys(EXPECTED), `no EXPECTED row for seed string "${s}"`).toContain(s);
    }
  });

  it('every mapped slug is one of the 15 titan groups', () => {
    for (const slugs of Object.values(EXPECTED)) {
      for (const slug of slugs) {
        expect(TITAN_MUSCLE_GROUPS).toContain(slug);
      }
    }
  });
});
