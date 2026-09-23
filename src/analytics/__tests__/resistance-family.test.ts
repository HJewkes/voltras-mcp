// Which resistance family a set met (VW-538).

import { describe, expect, it } from 'vitest';

import { resistanceFamilyOf, type ResistanceBearing } from '../resistance-family.js';

describe('resistanceFamilyOf', () => {
  it.each<[string, ResistanceBearing, string]>([
    ['plain weight training', { trainingMode: 'Weight Training' }, 'constant'],
    [
      'settings all at zero',
      {
        trainingMode: 'Weight Training',
        chainsLbs: 0,
        eccentricPct: 0,
        damperLevel: 0,
        inverseChainsLbs: 0,
      },
      'constant',
    ],
    ['chains on the weight', { trainingMode: 'Weight Training', chainsLbs: 20 }, 'chains'],
    [
      'inverse chains on the weight',
      { trainingMode: 'Weight Training', inverseChainsLbs: 10 },
      'chains',
    ],
    [
      'eccentric overload',
      { trainingMode: 'Weight Training', eccentricPct: 15 },
      'eccentric_overload',
    ],
    [
      'an assisted eccentric',
      { trainingMode: 'Weight Training', eccentricPct: -10 },
      'eccentric_overload',
    ],
    ['a damper level on the weight', { trainingMode: 'Weight Training', damperLevel: 3 }, 'damper'],
    ['the damper mode', { trainingMode: 'Damper' }, 'damper'],
    ['the isokinetic mode', { trainingMode: 'Isokinetic' }, 'isokinetic'],
    ['the band mode', { trainingMode: 'Resistance Band' }, 'chains'],
    ['the custom-curve mode', { trainingMode: 'Custom Curves' }, 'chains'],
    ['the rowing mode', { trainingMode: 'Rowing' }, 'damper'],
    ['the isometric mode', { trainingMode: 'Isometric' }, 'isokinetic'],
  ])('reads %s as its family', (_name, set, family) => {
    expect(resistanceFamilyOf(set)).toBe(family);
  });

  // INFERENCE by the designer (VW-448 wiring plan, slice 2), not an owner ruling.
  it('reads two settings on at once as the less readable of the two', () => {
    const both = { trainingMode: 'Weight Training', chainsLbs: 20, eccentricPct: 15 };

    expect(resistanceFamilyOf(both)).toBe('eccentric_overload');
    expect(resistanceFamilyOf({ ...both, damperLevel: 2 })).toBe('damper');
    expect(resistanceFamilyOf({ trainingMode: 'Damper', chainsLbs: 20 })).toBe('damper');
  });

  it('never reads an absent or unrecognised mode as constant load', () => {
    expect(resistanceFamilyOf({})).toBe('isokinetic');
    expect(resistanceFamilyOf({ trainingMode: 'Idle' })).toBe('isokinetic');
  });
});
