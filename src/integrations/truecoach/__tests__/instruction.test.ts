// Table-driven tests for the instruction parser.
//
// The table is the specification: every idiom the parser claims to read has a
// row, and the last rows are the ones that must read as NOTHING. A parser that
// guesses is worse than one that gives up, because a wrong target silently
// becomes the prescription the model coaches to.

import { describe, expect, it } from 'vitest';
import { parseInstruction, type ParsedTargets } from '../instruction.js';

interface Case {
  readonly text: string;
  readonly expect: Partial<ParsedTargets>;
}

const CASES: Case[] = [
  {
    text: '3 x 8',
    expect: { targetSets: 3, targetRepsLow: 8, targetRepsHigh: undefined, amrap: false },
  },
  {
    text: '3 x 8-10',
    expect: { targetSets: 3, targetRepsLow: 8, targetRepsHigh: 10 },
  },
  {
    text: '4 sets of 12',
    expect: { targetSets: 4, targetRepsLow: 12, targetRepsHigh: undefined },
  },
  {
    text: '4 sets of 12-15',
    expect: { targetSets: 4, targetRepsLow: 12, targetRepsHigh: 15 },
  },
  {
    text: '3 x 8-10 @ 135lb',
    expect: { targetSets: 3, targetRepsLow: 8, targetRepsHigh: 10, targetWeightLbs: 135 },
  },
  {
    text: '3 x 5 @ 225 lbs',
    expect: { targetSets: 3, targetRepsLow: 5, targetWeightLbs: 225 },
  },
  {
    text: '135 x 8 x 3 sets',
    expect: { targetSets: 3, targetRepsLow: 8, targetWeightLbs: 135 },
  },
  {
    // The literal idiom from the research note's third-party export.
    text: '50lbs x AMRAP x 4 sets',
    expect: {
      targetSets: 4,
      targetRepsLow: undefined,
      targetRepsHigh: undefined,
      targetWeightLbs: 50,
      amrap: true,
    },
  },
  {
    text: 'AMRAP',
    expect: { amrap: true, targetSets: undefined, targetRepsHigh: undefined },
  },
  {
    text: '3 x 8-10 @ 135lb, rest 90s',
    expect: { targetSets: 3, targetRepsLow: 8, targetRepsHigh: 10, restSec: 90 },
  },
  {
    text: '4 sets of 12, rest 2 min',
    expect: { targetSets: 4, targetRepsLow: 12, restSec: 120 },
  },
  {
    text: '3 x 10, 120s between sets',
    expect: { targetSets: 3, targetRepsLow: 10, restSec: 120 },
  },
  {
    // Every field absent. This is the fixture's unparseable instruction.
    text: "Work up to a heavy single, coach's discretion.",
    expect: {
      targetSets: undefined,
      targetRepsLow: undefined,
      targetRepsHigh: undefined,
      targetWeightLbs: undefined,
      restSec: undefined,
      amrap: false,
    },
  },
  {
    text: 'Technique work — film your last set and send it over.',
    expect: { targetSets: undefined, targetRepsLow: undefined, targetWeightLbs: undefined },
  },
  {
    text: '',
    expect: { targetSets: undefined, targetRepsLow: undefined, amrap: false },
  },
];

describe('parseInstruction', () => {
  it.each(CASES)('reads $text', ({ text, expect: expected }) => {
    expect(parseInstruction(text)).toMatchObject(expected);
  });

  it('reads nothing from undefined', () => {
    expect(parseInstruction(undefined)).toEqual({
      targetSets: undefined,
      targetRepsLow: undefined,
      targetRepsHigh: undefined,
      targetWeightLbs: undefined,
      restSec: undefined,
      amrap: false,
    });
  });

  it('does not read a rep count as a rest duration', () => {
    expect(parseInstruction('3 x 8').restSec).toBeUndefined();
  });
});
