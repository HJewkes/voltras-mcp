// Table test for the diet-phase equivalence classes (VW-366).
//
// Every ordered pair of the vocabulary is enumerated rather than sampled, so a
// class silently merging or splitting fails a row here instead of surfacing as
// a shrunken matched-session count somewhere downstream.

import { describe, expect, it } from 'vitest';

import { DIET_PHASES, dietPhasesComparable } from '../diet-phase.js';

const KNOWN = [...DIET_PHASES, 'recomposition'] as const;

describe('dietPhasesComparable', () => {
  it.each([
    ['maintenance', 'maintenance', true],
    ['maintenance', 'recomposition', true],
    ['recomposition', 'maintenance', true],
    ['recomposition', 'recomposition', true],
    ['fat-loss', 'fat-loss', true],
    ['fat-loss', 'maintenance', false],
    ['maintenance', 'fat-loss', false],
    ['fat-loss', 'recomposition', false],
    ['recomposition', 'fat-loss', false],
    ['gain', 'gain', true],
    ['gain', 'maintenance', false],
    ['maintenance', 'gain', false],
    ['gain', 'recomposition', false],
    ['recomposition', 'gain', false],
    ['fat-loss', 'gain', false],
    ['gain', 'fat-loss', false],
  ])('pairs %s with %s: %s', (a, b, expected) => {
    expect(dietPhasesComparable(a, b)).toBe(expected);
  });

  it('covers every ordered pair of the known vocabulary', () => {
    expect(KNOWN).toEqual(['fat-loss', 'gain', 'maintenance', 'recomposition']);
  });

  // A phase the table has not been taught must not inherit anyone's class —
  // the failure mode a bare string comparison would never have had.
  it.each(KNOWN)('refuses to pair an unknown phase with %s', (known) => {
    expect(dietPhasesComparable('bulk', known)).toBe(false);
    expect(dietPhasesComparable(known, 'bulk')).toBe(false);
  });

  it('still pairs an unrecognised phase with itself', () => {
    expect(dietPhasesComparable('bulk', 'bulk')).toBe(true);
  });

  it('is symmetric across the whole vocabulary', () => {
    for (const a of KNOWN) {
      for (const b of KNOWN) {
        expect(dietPhasesComparable(a, b)).toBe(dietPhasesComparable(b, a));
      }
    }
  });
});
