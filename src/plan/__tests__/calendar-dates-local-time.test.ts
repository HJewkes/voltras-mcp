// The shared calendar-date helpers (VW-811), run west of UTC. A week is a LOCAL Monday-to-Sunday
// week, and a Sunday-evening instant here is already Monday in UTC: a helper that read the
// instant's UTC date would put that session in the following week. Under UTC that mistake
// passes, which is why this file pins the zone before any Date is constructed.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, describe, expect, it } from 'vitest';

import {
  assertMonday,
  isIsoDate,
  isMonday,
  mondayOf,
  type MondayProblem,
} from '../block-calendar.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const SUNDAY_NIGHT = '2026-09-21T03:30:00.000Z';
const MONDAY_MIDNIGHT = '2026-09-21T06:00:00.000Z';

describe('the zone this file runs in', () => {
  it('is six hours west of UTC in September', () => {
    expect(new Date(MONDAY_MIDNIGHT).getTimezoneOffset()).toBe(360);
  });
});

describe('mondayOf', () => {
  it('keeps a Sunday-night instant in the week that Sunday closes', () => {
    expect(mondayOf(SUNDAY_NIGHT)).toBe('2026-09-14');
  });

  it('starts a new week at local Monday midnight', () => {
    expect(mondayOf(MONDAY_MIDNIGHT)).toBe('2026-09-21');
  });

  it('reads a date as the local date it already is', () => {
    expect(mondayOf('2026-09-20')).toBe('2026-09-14');
    expect(mondayOf('2026-09-21')).toBe('2026-09-21');
    expect(mondayOf('2026-09-27')).toBe('2026-09-21');
  });
});

describe('isMonday', () => {
  it('reads a date by its calendar weekday, not its UTC-midnight local weekday', () => {
    expect(isMonday('2026-09-21')).toBe(true);
    expect(isMonday('2026-09-22')).toBe(false);
  });
});

describe('isIsoDate', () => {
  it('accepts a real calendar date', () => {
    expect(isIsoDate('2026-09-21')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });

  it('refuses a date that does not exist or is not zero-padded', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-21')).toBe(false);
    expect(isIsoDate(SUNDAY_NIGHT)).toBe(false);
  });

  it('refuses a value that is not a string without throwing', () => {
    for (const value of [
      undefined,
      null,
      20260921,
      new Date(MONDAY_MIDNIGHT),
      ['2026-09-21'],
      {},
    ]) {
      expect(isIsoDate(value)).toBe(false);
    }
  });
});

describe('assertMonday', () => {
  const problemOf = (date: string): MondayProblem | null => {
    try {
      assertMonday(date, (problem) => Object.assign(new Error(problem.kind), { problem }));
      return null;
    } catch (error) {
      return (error as Error & { problem: MondayProblem }).problem;
    }
  };

  it('passes a Monday', () => {
    expect(problemOf('2026-09-21')).toBeNull();
  });

  it('rejects a value that is not a calendar date', () => {
    expect(problemOf('2026-02-30')).toEqual({ kind: 'not-a-date', date: '2026-02-30' });
  });

  it('rejects another weekday with the Mondays either side', () => {
    expect(problemOf('2026-09-23')).toEqual({
      kind: 'not-a-monday',
      date: '2026-09-23',
      before: '2026-09-21',
      after: '2026-09-28',
    });
  });
});
