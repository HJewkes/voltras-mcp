// VW-328: catalog->titan muscle map. Table-driven over every seed-catalog
// string plus a coverage check derived from the seed file itself, so a new
// seed string with no mapping row fails loudly instead of silently mapping
// to [].

import { describe, it, expect } from 'vitest';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';
import {
  isProxyMapping,
  mapCatalogMuscle,
  PROXY_CATALOG_MUSCLES,
  TITAN_MUSCLE_GROUPS,
} from '../muscle-map.js';
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

  it('names exactly the three rows that are a nearest-region proxy', () => {
    expect([...PROXY_CATALOG_MUSCLES].sort()).toEqual(['abductors', 'adductors', 'traps']);
    for (const proxy of PROXY_CATALOG_MUSCLES) {
      expect(isProxyMapping(proxy)).toBe(true);
      expect(Object.keys(EXPECTED)).toContain(proxy);
      // A proxy lands on a slug that is not the muscle it came from; an
      // identity or composite row never does.
      expect(mapCatalogMuscle(proxy)).not.toContain(proxy);
    }
    expect(isProxyMapping('quads')).toBe(false);
  });

  it('every mapped slug is one of the 15 titan groups', () => {
    for (const slugs of Object.values(EXPECTED)) {
      for (const slug of slugs) {
        expect(TITAN_MUSCLE_GROUPS).toContain(slug);
      }
    }
  });
});
