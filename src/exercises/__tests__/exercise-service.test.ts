// Unit tests for ExerciseService.
//
// `ExerciseService` is a stateless wrapper over the `@voltras/workout-analytics`
// exercise catalog. These tests mock the upstream module so the suite stays
// hermetic (no peer-dep loads) and assert via spies that the wrapper delegates
// 1:1 to `searchExercises` and `getExerciseById`.
//
// The `Exercise` shape asserted here mirrors spec R22's public catalog fields.
// Any drift between the local `Exercise` interface and the upstream catalog
// will be caught by the type-side `satisfies` guard in `exercise-service.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchExercisesSpy = vi.fn();
const getExerciseByIdSpy = vi.fn();

vi.mock('@voltras/workout-analytics', () => ({
  searchExercises: searchExercisesSpy,
  getExerciseById: getExerciseByIdSpy,
}));

// Import after vi.mock so the mock is applied.
const { ExerciseService } = await import('../exercise-service.js');

interface CatalogEntry {
  id: string;
  name: string;
  aliases?: string[];
  muscleGroups: string[];
  secondaryMuscleGroups?: string[];
  movementPattern: string;
  exerciseType: 'compound' | 'isolation';
  equipment: { name: string; category: string }[];
  cableEquivalent: boolean;
  cableSetup?: { cablePath: string; attachments: string[] };
  description?: string;
  instructions?: string[];
  formCues?: string[];
  commonMistakes?: string[];
  tips?: string[];
  qualityScore: number;
}

const benchPress: CatalogEntry = {
  id: 'bench-press',
  name: 'Bench Press',
  muscleGroups: ['chest'],
  movementPattern: 'push',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'barbell' }],
  cableEquivalent: false,
  qualityScore: 95,
};

const inclineBench: CatalogEntry = {
  id: 'incline-bench-press',
  name: 'Incline Bench Press',
  muscleGroups: ['chest'],
  movementPattern: 'push',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'barbell' }],
  cableEquivalent: false,
  qualityScore: 90,
};

describe('ExerciseService', () => {
  beforeEach(() => {
    searchExercisesSpy.mockReset();
    getExerciseByIdSpy.mockReset();
  });

  describe('search', () => {
    it('delegates to searchExercises and returns its result', () => {
      const expected = [benchPress, inclineBench];
      searchExercisesSpy.mockReturnValue(expected);
      const service = new ExerciseService();

      const result = service.search('bench');

      expect(searchExercisesSpy).toHaveBeenCalledTimes(1);
      expect(searchExercisesSpy).toHaveBeenCalledWith('bench');
      expect(result).toBe(expected);
    });

    it('passes the query verbatim to the catalog (no trimming or casing)', () => {
      searchExercisesSpy.mockReturnValue([]);
      const service = new ExerciseService();

      service.search('  Bench Press  ');

      expect(searchExercisesSpy).toHaveBeenCalledWith('  Bench Press  ');
    });

    it('returns an empty array when the catalog has no matches', () => {
      searchExercisesSpy.mockReturnValue([]);
      const service = new ExerciseService();

      expect(service.search('xyzzy')).toEqual([]);
    });
  });

  describe('getById', () => {
    it('delegates to getExerciseById and returns its result', () => {
      getExerciseByIdSpy.mockReturnValue(benchPress);
      const service = new ExerciseService();

      const result = service.getById('bench-press');

      expect(getExerciseByIdSpy).toHaveBeenCalledTimes(1);
      expect(getExerciseByIdSpy).toHaveBeenCalledWith('bench-press');
      expect(result).toBe(benchPress);
    });

    it('returns undefined for unknown ids without throwing', () => {
      getExerciseByIdSpy.mockReturnValue(undefined);
      const service = new ExerciseService();

      expect(() => service.getById('does-not-exist')).not.toThrow();
      expect(service.getById('does-not-exist')).toBeUndefined();
    });
  });

  describe('output shape', () => {
    // R22: returned exercises expose only the catalog's public fields. The
    // service is a pure pass-through, so this also verifies no fields are
    // added or stripped en route.
    it('returns the catalog entry verbatim (no extra fields injected)', () => {
      getExerciseByIdSpy.mockReturnValue(benchPress);
      const service = new ExerciseService();

      const result = service.getById('bench-press');

      expect(result).toEqual(benchPress);
      // Reference equality confirms the wrapper does not clone or remap.
      expect(result).toBe(benchPress);
    });

    it('returns the search array verbatim (no per-entry remapping)', () => {
      const expected = [benchPress, inclineBench];
      searchExercisesSpy.mockReturnValue(expected);
      const service = new ExerciseService();

      const result = service.search('bench');

      expect(result).toBe(expected);
      expect(result[0]).toBe(benchPress);
      expect(result[1]).toBe(inclineBench);
    });
  });
});
