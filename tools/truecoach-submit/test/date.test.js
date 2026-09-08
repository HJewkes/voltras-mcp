// The card label the workout lookup searches for.

import { describe, it, expect } from 'vitest';

import { longCardDate } from '../src/date.js';

describe('longCardDate', () => {
  it('renders the weekday, month and ordinal day', () => {
    expect(longCardDate('2026-09-08')).toBe('Tuesday, September 8th');
    expect(longCardDate('2026-04-22')).toBe('Wednesday, April 22nd');
  });

  it('uses th for the teens and st/nd/rd elsewhere', () => {
    expect(longCardDate('2026-09-11')).toBe('Friday, September 11th');
    expect(longCardDate('2026-09-21')).toBe('Monday, September 21st');
    expect(longCardDate('2026-09-22')).toBe('Tuesday, September 22nd');
    expect(longCardDate('2026-09-23')).toBe('Wednesday, September 23rd');
  });

  it('rejects anything that is not a calendar date', () => {
    expect(() => longCardDate('tomorrow')).toThrow(/YYYY-MM-DD/);
  });
});
