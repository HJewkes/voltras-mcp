// A bilateral pair is one working effort with two sides (VW-951): the lighter
// side of an asymmetric pair is not a warm-up.

import { describe, expect, it } from 'vitest';

import { selectWorkingSets, type WorkingSetCandidate } from '../working-sets.js';

interface Row extends WorkingSetCandidate {
  id: string;
}

function side(id: string, weightLbs: number, bilateralGroupId?: string): Row {
  return { id, setPurpose: 'working', weightLbs, bilateralGroupId };
}

const ids = (rows: readonly Row[]): string[] => rows.map((row) => row.id);

describe('selectWorkingSets on bilateral pairs', () => {
  it('keeps both sides of every pair when the left side is 10% lighter', () => {
    const sets = [
      side('1L', 78, 'pair-1'),
      side('1R', 86, 'pair-1'),
      side('2L', 78, 'pair-2'),
      side('2R', 86, 'pair-2'),
    ];

    expect(ids(selectWorkingSets(sets))).toEqual(['1L', '1R', '2L', '2R']);
  });

  it('still drops a lighter ramp-up pair, both sides together', () => {
    const sets = [
      side('0L', 40, 'pair-0'),
      side('0R', 45, 'pair-0'),
      side('1L', 78, 'pair-1'),
      side('1R', 86, 'pair-1'),
    ];

    expect(ids(selectWorkingSets(sets))).toEqual(['1L', '1R']);
  });

  it('still drops a lighter set that belongs to no pair', () => {
    const sets = [side('ramp', 78), side('1L', 78, 'pair-1'), side('1R', 86, 'pair-1')];

    expect(ids(selectWorkingSets(sets))).toEqual(['1L', '1R']);
  });
});
