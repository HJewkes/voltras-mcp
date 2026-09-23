// The calendar-week grid a goal block is read on (VW-421): week 1 is the ISO
// week containing the start, whatever weekday the start fell on.

import { describe, expect, it } from 'vitest';

import { blockEndsAt, blockWeekAt } from '../goal-block-weeks.js';
import { weeksInPhaseAt } from '../diet-phase-tolerance.js';

const THURSDAY_START = '2026-08-06T18:05:00.000Z';

describe('blockWeekAt', () => {
  it('puts the Monday of the start week on week 1, before the start instant itself', () => {
    expect(blockWeekAt(THURSDAY_START, '2026-08-03T00:00:00.000Z')).toBe(1);
  });

  it('keeps the last second of the start week on week 1', () => {
    expect(blockWeekAt(THURSDAY_START, '2026-08-09T23:59:59.999Z')).toBe(1);
  });

  it('turns to week 2 at the next Monday midnight UTC, not seven days after the start', () => {
    expect(blockWeekAt(THURSDAY_START, '2026-08-10T00:00:00.000Z')).toBe(2);
    expect(blockWeekAt(THURSDAY_START, '2026-08-13T18:04:00.000Z')).toBe(2);
  });

  it('counts a week before the start week as week 0', () => {
    expect(blockWeekAt(THURSDAY_START, '2026-08-02T23:59:59.000Z')).toBe(0);
  });

  it('keeps counting past a block of any length, across a year boundary', () => {
    expect(blockWeekAt('2026-12-31T12:00:00.000Z', '2027-01-04T00:00:00.000Z')).toBe(2);
  });

  it('is NaN when either instant does not parse', () => {
    expect(blockWeekAt('not a date', THURSDAY_START)).toBeNaN();
    expect(blockWeekAt(THURSDAY_START, 'not a date')).toBeNaN();
  });

  it('leaves the diet-phase seven-day count as it was', () => {
    expect(weeksInPhaseAt(THURSDAY_START, '2026-08-10T00:00:00.000Z')).toBe(1);
  });
});

describe('blockEndsAt', () => {
  it('ends a six-week block from a Thursday start on the Monday after its sixth calendar week', () => {
    expect(blockEndsAt(THURSDAY_START, 6)).toBe('2026-09-14T00:00:00.000Z');
  });

  it('is the first instant the grid calls week weekCount + 1', () => {
    const endsAt = blockEndsAt(THURSDAY_START, 6);

    expect(blockWeekAt(THURSDAY_START, endsAt)).toBe(7);
    expect(blockWeekAt(THURSDAY_START, new Date(Date.parse(endsAt) - 1).toISOString())).toBe(6);
  });
});
