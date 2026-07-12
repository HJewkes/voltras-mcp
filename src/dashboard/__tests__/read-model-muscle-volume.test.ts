/**
 * Muscle-volume read-model (VMCP-03.03). The pure primary/secondary set
 * attribution extracted from server.ts (windowing + catalog resolution stay in
 * the caller).
 */
import { describe, expect, it } from 'vitest';

import { buildMuscleVolume, SECONDARY_SET_WEIGHT } from '../read-models/muscle-volume';

describe('buildMuscleVolume', () => {
  it('attributes full sets to primary muscles and half sets to secondary', () => {
    const volume = buildMuscleVolume([
      { setCount: 4, primaryMuscles: ['chest'], secondaryMuscles: ['triceps'] },
    ]);
    expect(volume.chest).toBe(4);
    expect(volume.triceps).toBe(4 * SECONDARY_SET_WEIGHT);
  });

  it('accumulates a muscle across sessions (primary + secondary overlap)', () => {
    const volume = buildMuscleVolume([
      { setCount: 3, primaryMuscles: ['chest'], secondaryMuscles: [] },
      { setCount: 2, primaryMuscles: ['shoulders'], secondaryMuscles: ['chest'] },
    ]);
    expect(volume.chest).toBe(3 + 2 * SECONDARY_SET_WEIGHT);
    expect(volume.shoulders).toBe(2);
  });

  it('skips zero-set entries and returns {} for no entries', () => {
    expect(buildMuscleVolume([])).toEqual({});
    expect(
      buildMuscleVolume([
        { setCount: 0, primaryMuscles: ['chest'], secondaryMuscles: ['triceps'] },
      ]),
    ).toEqual({});
  });
});
