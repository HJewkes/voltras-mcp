// Rep-eligibility rule v1 (VW-168 / VW-181).
//
// The table below is the rule's contract: the 2026-09-07 positioning-pull
// shape is rejected, and every ordinary shape a real set produces is kept.

import { describe, expect, it } from 'vitest';

import { isRepEligible, isTailPairConsistent, selectEligibleReps } from '../rep-eligibility.js';
import {
  makeShapedRep,
  makeWorkingSet,
  POSITIONING_PULL,
  WORKING_REP,
} from './fixtures/rep-shapes.js';

describe('isRepEligible', () => {
  const cases = [
    {
      name: 'the 2026-09-07 positioning pull against working reps',
      rep: makeShapedRep(1, POSITIONING_PULL),
      others: makeWorkingSet(3),
      expected: { eligible: false, reason: 'rom_outlier' },
    },
    {
      name: 'an ordinary working rep among working reps',
      rep: makeShapedRep(2, WORKING_REP),
      others: makeWorkingSet(3),
      expected: { eligible: true },
    },
    {
      name: 'rep 1 genuinely fastest, with a normal ROM',
      rep: makeShapedRep(1, { romM: WORKING_REP.romM, peakMps: 1.2 }),
      others: makeWorkingSet(3),
      expected: { eligible: true },
    },
    {
      name: 'a half-rep partial — the rule is symmetric',
      rep: makeShapedRep(4, { romM: 0.2, peakMps: WORKING_REP.peakMps }),
      others: makeWorkingSet(3),
      expected: { eligible: false, reason: 'rom_outlier' },
    },
    {
      name: 'a normal-ROM rep ripped far faster than its neighbours',
      rep: makeShapedRep(4, { romM: WORKING_REP.romM, peakMps: 2.0 }),
      others: makeWorkingSet(3),
      expected: { eligible: false, reason: 'velocity_outlier' },
    },
    {
      name: 'nothing measurable to compare against',
      rep: makeShapedRep(1, WORKING_REP),
      others: [],
      expected: { eligible: false, reason: 'first_rep_unconfirmed' },
    },
    {
      name: 'only an in-progress rep to compare against',
      rep: makeShapedRep(1, WORKING_REP),
      others: [makeShapedRep(2, { ...WORKING_REP, movementSamples: 1 })],
      expected: { eligible: false, reason: 'first_rep_unconfirmed' },
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name} → ${c.expected.eligible ? 'eligible' : c.expected.reason}`, () => {
      expect(isRepEligible(c.rep, { priorReps: c.others })).toEqual(c.expected);
    });
  }
});

describe('selectEligibleReps', () => {
  it('drops the positioning pull from a set that opened with one', () => {
    const pull = makeShapedRep(1, POSITIONING_PULL);
    const reps = [pull, ...makeWorkingSet(3).map((rep, i) => ({ ...rep, repNumber: i + 2 }))];

    const kept = selectEligibleReps(reps);

    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(pull);
  });

  it('keeps every rep of an ordinary set', () => {
    const reps = makeWorkingSet(5);

    expect(selectEligibleReps(reps)).toHaveLength(5);
  });

  it('keeps both reps of a two-rep set (no false exclusion)', () => {
    const reps = makeWorkingSet(2);

    expect(selectEligibleReps(reps)).toHaveLength(2);
  });

  it('keeps the lone rep of a one-rep window rather than emptying it', () => {
    const reps = makeWorkingSet(1);

    expect(selectEligibleReps(reps)).toEqual(reps);
  });
});

describe('isTailPairConsistent', () => {
  it('rejects a positioning pull followed by a working rep', () => {
    expect(
      isTailPairConsistent(makeShapedRep(1, POSITIONING_PULL), makeShapedRep(2, WORKING_REP)),
    ).toBe(false);
  });

  it('accepts two consecutive working reps', () => {
    const [first, second] = makeWorkingSet(2);

    expect(isTailPairConsistent(first, second)).toBe(true);
  });

  it('reports a mismatched pair as inconsistent whichever way round it is fed', () => {
    // Two reps alone cannot say which of them is the odd one out. The pair is
    // inconsistent either way; auto-arm resolves it by position, treating the
    // earlier rep as the suspect.
    expect(
      isTailPairConsistent(makeShapedRep(1, WORKING_REP), makeShapedRep(2, POSITIONING_PULL)),
    ).toBe(false);
  });
});
