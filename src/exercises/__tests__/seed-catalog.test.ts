// Validates the hand-curated cable-exercise seed catalog.
//
// Two layers of assertions:
//   1. Static shape — count, required fields, unique ids. Catches drift if
//      someone hand-edits an entry and forgets a required field.
//   2. Functional — load via the real `setCatalog()` and exercise the
//      catalog's own `searchExercises` to confirm a representative query
//      surfaces a match. This is the path the MCP `exercise.search` tool
//      takes at runtime, so it's the path that actually has to work.
//
// Note: this test does NOT mock `@voltras/workout-analytics` — it uses the
// real catalog module so `setCatalog` mutates real state. Tests that assert
// against `getAllExercises()` after this file runs would see our seed data;
// none currently do (the only other consumer, `exercise-service.test.ts`,
// fully mocks the analytics module so it's hermetic).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  setCatalog,
  searchExercises,
  getExerciseById,
  getAllExercises,
} from '@voltras/workout-analytics';
import { SEED_CABLE_EXERCISES } from '../seed-catalog.js';

describe('SEED_CABLE_EXERCISES', () => {
  describe('static shape', () => {
    it('has at least 25 entries', () => {
      expect(SEED_CABLE_EXERCISES.length).toBeGreaterThanOrEqual(25);
    });

    it('every entry has all required fields populated', () => {
      for (const ex of SEED_CABLE_EXERCISES) {
        expect(ex.id, `entry missing id: ${JSON.stringify(ex)}`).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(ex.name, `${ex.id}: name`).toBeTruthy();
        expect(ex.muscleGroups, `${ex.id}: muscleGroups`).toBeInstanceOf(Array);
        expect(ex.muscleGroups.length, `${ex.id}: muscleGroups non-empty`).toBeGreaterThan(0);
        expect(ex.movementPattern, `${ex.id}: movementPattern`).toBeTruthy();
        expect(['compound', 'isolation'], `${ex.id}: exerciseType`).toContain(ex.exerciseType);
        expect(ex.equipment, `${ex.id}: equipment`).toBeInstanceOf(Array);
        expect(ex.equipment.length, `${ex.id}: equipment non-empty`).toBeGreaterThan(0);
        expect(ex.cableEquivalent, `${ex.id}: cableEquivalent`).toBe(true);
        expect(typeof ex.qualityScore, `${ex.id}: qualityScore`).toBe('number');
      }
    });

    it('every id is unique', () => {
      const ids = SEED_CABLE_EXERCISES.map((ex) => ex.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('every entry has a cableSetup (this catalog is Voltra-shaped)', () => {
      for (const ex of SEED_CABLE_EXERCISES) {
        expect(ex.cableSetup, `${ex.id}: cableSetup present`).toBeDefined();
        expect(['high', 'mid', 'low', 'floor', 'multiple']).toContain(ex.cableSetup!.cablePath);
        expect(ex.cableSetup!.attachments.length).toBeGreaterThan(0);
      }
    });
  });

  describe('functional — drives @voltras/workout-analytics catalog', () => {
    beforeAll(() => {
      setCatalog(SEED_CABLE_EXERCISES);
    });

    it('seed entries are loaded and counted', () => {
      expect(getAllExercises().length).toBe(SEED_CABLE_EXERCISES.length);
    });

    it('searchExercises("chest fly") finds at least one entry', () => {
      const hits = searchExercises('chest fly');
      expect(hits.length).toBeGreaterThan(0);
      // The catalog's searchExercises matches on name + aliases. "Cable
      // Chest Fly" is the canonical entry; allow other "fly" entries too.
      expect(hits.some((ex) => ex.id === 'cable-chest-fly')).toBe(true);
    });

    it('searchExercises is case-insensitive', () => {
      const hits = searchExercises('CABLE ROW');
      expect(hits.some((ex) => ex.id === 'cable-row')).toBe(true);
    });

    it('searchExercises matches aliases', () => {
      // "lat pulldown" is an alias of cable-lat-pulldown.
      const hits = searchExercises('lat pulldown');
      expect(hits.some((ex) => ex.id === 'cable-lat-pulldown')).toBe(true);
    });

    it('getExerciseById returns the seed entry for a known id', () => {
      const ex = getExerciseById('cable-romanian-deadlift');
      expect(ex).toBeDefined();
      expect(ex!.name).toBe('Cable Romanian Deadlift');
    });

    it('getExerciseById returns undefined for unknown ids', () => {
      expect(getExerciseById('does-not-exist')).toBeUndefined();
    });
  });
});
