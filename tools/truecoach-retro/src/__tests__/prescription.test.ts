import { describe, expect, it } from 'vitest';

import { blockTarget, parsePrescriptionLine } from '../prescription.js';

describe('parsePrescriptionLine', () => {
  it('reads a load-first line as load, sets and reps', () => {
    expect(parsePrescriptionLine('157.5 @ 3 x 5')).toEqual({ loadLbs: 157.5, sets: 3, repsLow: 5 });
  });

  it('reads a sets-first line with an RPE tag and no load', () => {
    expect(parsePrescriptionLine('3 x 20 RPE 9')).toEqual({ sets: 3, repsLow: 20, loadLbs: null });
    expect(parsePrescriptionLine('3x10 RPE9')).toEqual({ sets: 3, repsLow: 10, loadLbs: null });
  });

  it('takes the low edge of a rep range as the floor', () => {
    expect(parsePrescriptionLine('3 x 8-10')?.repsLow).toBe(8);
  });

  it('reads a percentage-of-another-day line as sets and reps with no load', () => {
    expect(parsePrescriptionLine('3 x 20 @ 80% of Day 2')).toEqual({
      sets: 3,
      repsLow: 20,
      loadLbs: null,
    });
  });

  it('gives AMRAP a set count and no rep floor', () => {
    expect(parsePrescriptionLine('4 x AMRAP')).toEqual({ sets: 4, repsLow: null, loadLbs: null });
  });

  it('refuses a circuit heading and a named rep range', () => {
    expect(parsePrescriptionLine('3 Sets:')).toBeNull();
    expect(parsePrescriptionLine('10-12 Good Mornings')).toBeNull();
  });
});

describe('blockTarget', () => {
  it('adds a top set and back-off sets and keeps the lighter load', () => {
    expect(blockTarget(['180 @ 1 x 3', '170 @ 4 x 3'])).toEqual({
      sets: 5,
      repsLow: 3,
      loadLbs: 170,
    });
  });

  it('has no target when any line is not a fixed shape', () => {
    expect(blockTarget(['100 @ 3 x 5', '3 Sets:'])).toBeNull();
    expect(blockTarget([])).toBeNull();
  });
});
