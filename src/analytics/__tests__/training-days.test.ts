// The training-day rule behind `sessions_28d` (VW-460). Dates are built with the
// local-time Date constructor, so every case holds in whatever timezone runs it.

import { describe, expect, it } from 'vitest';

import { localDate, sessionWindowFrom, trainingDaysOf, trainingGaps } from '../training-days.js';

const iso = (...parts: [number, number, number, number?, number?]): string =>
  new Date(parts[0], parts[1], parts[2], parts[3] ?? 12, parts[4] ?? 0).toISOString();

describe('trainingDaysOf', () => {
  it('counts twelve sessions ended on one local day as one training day', () => {
    const endTimes = Array.from({ length: 12 }, (_, i) => iso(2026, 8, 7, 8 + i, 5));

    expect(trainingDaysOf(endTimes)).toEqual(['2026-09-07']);
  });

  it('puts 23:59 and 00:01 local on two different days', () => {
    const lateNight = iso(2026, 8, 7, 23, 59);
    const justAfterMidnight = iso(2026, 8, 8, 0, 1);

    expect(trainingDaysOf([justAfterMidnight, lateNight])).toEqual(['2026-09-07', '2026-09-08']);
  });

  it('files a session under the local date it ended, not the UTC one', () => {
    const ended = new Date(2026, 8, 7, 23, 30);

    expect(localDate(ended.toISOString())).toBe('2026-09-07');
  });
});

describe('sessionWindowFrom', () => {
  it('opens the window exactly 28 x 24 hours before now', () => {
    const now = '2026-09-19T10:00:00.000Z';

    expect(sessionWindowFrom(now)).toBe('2026-08-22T10:00:00.000Z');
  });
});

describe('trainingGaps', () => {
  it('measures each gap in whole days and names the day that ended it', () => {
    expect(trainingGaps(['2026-03-01', '2026-03-03', '2026-06-15'])).toEqual([
      { days: 2, endsOn: '2026-03-03' },
      { days: 104, endsOn: '2026-06-15' },
    ]);
  });

  it('counts whole days across a daylight-saving change', () => {
    expect(trainingGaps(['2026-03-07', '2026-03-09'])).toEqual([{ days: 2, endsOn: '2026-03-09' }]);
  });

  it('has no gap with fewer than two days', () => {
    expect(trainingGaps(['2026-03-01'])).toEqual([]);
    expect(trainingGaps([])).toEqual([]);
  });
});
