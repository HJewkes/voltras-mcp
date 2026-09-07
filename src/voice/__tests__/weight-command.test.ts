// Unit tests for the pure spoken-weight-command parser (VMCP-02.87).
// Table-driven over the supported cue vocabulary plus a negatives corpus —
// a false positive here writes a weight to the cable with no model in the loop.

import { describe, expect, it } from 'vitest';

import { parseWeightCommand, type WeightCommand } from '../weight-command.js';

const ABSOLUTE: [string, number][] = [
  ['set it to 70', 70],
  ['set to 70', 70],
  ['70 pounds', 70],
  ['70 lbs', 70],
  ['go to 65', 65],
  ['put it at 55', 55],
  ['weight 45', 45],
  ['make it 60', 60],
  ['seventy', 70],
  ['one hundred', 100],
  ['a hundred', 100],
  ['a hundred and ten', 110],
  ['one-thirty', 130],
  ['one thirty five', 135],
  ['seventy five', 75],
  ['twenty five', 25],
  ['go up to 100', 100],
  ['set it to one hundred and twenty', 120],
  // Verbatim messiness from the bench: whisper filler plus stray commas.
  ['to like, , set it to 70', 70],
  ['SET IT TO 70.', 70],
  ['can you set it to 70', 70],
];

const RELATIVE: [string, number][] = [
  ['up 10', 10],
  ['add five', 5],
  ['bump it 5', 5],
  ['go up ten', 10],
  ['down 10', -10],
  ['drop 5', -5],
  ['take off ten', -10],
  ['lower it 15', -15],
  ['lighter', -5],
  ['heavier', 5],
  ['make it lighter', -5],
  ['add twenty five', 25],
];

const UNDO = [
  'cancel',
  'cancel that',
  'never mind',
  'nevermind',
  'undo',
  'undo that',
  'scratch that',
];

// Every one of these must stay out of the fast path: conversation, questions,
// past-tense reporting, rep counting, and negated commands.
const NEGATIVES = [
  'how much weight should i use',
  'that was seventy pounds last time',
  "don't set it to 70",
  'do not set it to 70',
  'i think we did 60 last week',
  'what should the weight be',
  'is seventy too heavy for this',
  'nice weather today',
  'my shoulder feels tight',
  'one more rep',
  'give me two more',
  'ten reps to go',
  "let's do ten reps",
  'five',
  'seven',
  'twelve',
  'up',
  'off',
  'keep it there',
  "i'll take off my jacket",
  'the last set felt heavy',
  'we should probably go up next week',
  '',
  '   ',
];

describe('parseWeightCommand — absolute cues', () => {
  it.each(ABSOLUTE)('parses %j as an absolute target', (text, lbs) => {
    expect(parseWeightCommand(text)).toEqual({ kind: 'absolute', lbs });
  });
});

describe('parseWeightCommand — relative cues', () => {
  it.each(RELATIVE)('parses %j as a delta', (text, deltaLbs) => {
    expect(parseWeightCommand(text)).toEqual({ kind: 'relative', deltaLbs });
  });
});

describe('parseWeightCommand — cancel/undo cues', () => {
  it.each(UNDO)('parses %j as undo', (text) => {
    expect(parseWeightCommand(text)).toEqual({ kind: 'undo' });
  });
});

describe('parseWeightCommand — negatives', () => {
  it.each(NEGATIVES)('does not treat %j as a command', (text) => {
    expect(parseWeightCommand(text)).toBeNull();
  });
});

describe('parseWeightCommand — slot targeting', () => {
  it('picks up an explicit side word', () => {
    expect(parseWeightCommand('left to 40')).toEqual({ kind: 'absolute', lbs: 40, slot: 'left' });
    expect(parseWeightCommand('right up 10')).toEqual({
      kind: 'relative',
      deltaLbs: 10,
      slot: 'right',
    });
    expect(parseWeightCommand('cancel left')).toEqual({ kind: 'undo', slot: 'left' });
  });

  it('omits slot when no side word was spoken', () => {
    const parsed = parseWeightCommand('set it to 70') as WeightCommand;
    expect('slot' in parsed).toBe(false);
  });
});

describe('parseWeightCommand — guard rails', () => {
  it('rejects a sentence longer than the word cap', () => {
    expect(parseWeightCommand('i was thinking we could set it to 70 today')).toBeNull();
  });

  it('rejects a question even when it contains a target', () => {
    expect(parseWeightCommand('set it to 70?')).toBeNull();
  });

  it('returns out-of-range numbers for the caller to reject', () => {
    expect(parseWeightCommand('set it to 500')).toEqual({ kind: 'absolute', lbs: 500 });
    expect(parseWeightCommand('go to 2')).toEqual({ kind: 'absolute', lbs: 2 });
  });

  it('accepts a bare number only above the rep-counting band', () => {
    expect(parseWeightCommand('twenty')).toEqual({ kind: 'absolute', lbs: 20 });
    expect(parseWeightCommand('nineteen')).toBeNull();
  });
});
