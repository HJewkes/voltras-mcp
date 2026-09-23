// The commitment week key (VW-505), run west of UTC where the bug it guards against shows: a
// Sunday-evening declaration is still Sunday to the lifter although its UTC date is Monday.
// Under UTC that mutant passes, which is why this file pins the zone before any Date is built.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, describe, expect, it } from 'vitest';

import { commitmentWeekOf } from '../commitment-week.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('the zone this file runs in', () => {
  it('is six hours west of UTC in September', () => {
    expect(new Date('2026-09-21T00:00:00.000Z').getTimezoneOffset()).toBe(360);
  });
});

describe('the week a declaration is filed against', () => {
  it('files a Sunday against the next day’s Monday', () => {
    expect(commitmentWeekOf('2026-09-20T18:00:00')).toBe('2026-09-21');
  });

  it('files a Sunday evening against tomorrow, not against the UTC Monday it already is', () => {
    expect(commitmentWeekOf('2026-09-21T02:00:00.000Z')).toBe('2026-09-21');
  });

  it('files every other day against the Monday of the week it is in', () => {
    expect(commitmentWeekOf('2026-09-21T09:00:00')).toBe('2026-09-21');
    expect(commitmentWeekOf('2026-09-24T09:00:00')).toBe('2026-09-21');
    expect(commitmentWeekOf('2026-09-26T23:30:00')).toBe('2026-09-21');
  });

  it('takes a Date and an ISO string to the same week', () => {
    expect(commitmentWeekOf(new Date('2026-09-23T15:00:00'))).toBe(
      commitmentWeekOf('2026-09-23T15:00:00'),
    );
  });
});
