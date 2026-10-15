// The weekly check-in's Sunday anchor is the lifter's LOCAL Sunday (VW-508), run six hours
// west of UTC where Saturday evening is already Sunday in UTC.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, describe, expect, it } from 'vitest';

import { mostRecentSundayIso } from '../profile-tools.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('mostRecentSundayIso west of UTC', () => {
  it('keeps Saturday 21:00 local in the week that started the Sunday before', () => {
    expect(mostRecentSundayIso(new Date('2026-09-20T03:00:00.000Z'))).toBe('2026-09-13');
  });

  it('moves to the new week at Sunday 00:30 local', () => {
    expect(mostRecentSundayIso(new Date('2026-09-20T06:30:00.000Z'))).toBe('2026-09-20');
  });

  it('holds the Sunday through a midweek instant', () => {
    expect(mostRecentSundayIso(new Date('2026-09-23T18:00:00.000Z'))).toBe('2026-09-20');
  });
});
