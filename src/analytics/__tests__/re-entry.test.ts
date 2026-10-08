// The re-entry rule after a break (VW-905). Pure: every case passes local dates, so no clock
// is read and the zone the suite runs in does not matter.

import { describe, expect, it } from 'vitest';

import { validateSource } from '../../coach-copy/fragments.js';
import { BREAK_BAND_MAX_DAYS, RE_ENTRY_RULES, classifyBreak, selectReEntry } from '../re-entry.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAfter = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

const LAST_DAY = '2026-09-01';

describe('selectReEntry on an open break', () => {
  it('reads a 26-day gap as a short break at 0.8 for a 7-day window sourced to Nuckols 2022', () => {
    const today = daysAfter(LAST_DAY, 26);

    const read = selectReEntry({ trainingDays: ['2026-08-28', LAST_DAY], today });

    expect(read).toMatchObject({
      lastTrainingDay: LAST_DAY,
      daysSinceLastTrainingDay: 26,
      phase: 'in_gap',
      band: 'short',
      gapDays: 26,
      windowEndsOn: daysAfter(today, 6),
    });
    expect(read.rule?.value.loadFactor).toBe(0.8);
    expect(read.rule?.value.weeks).toBe(1);
    expect(read.rule?.sourceRef).toContain('Nuckols 2022');
  });

  it('prescribes one third of the last working load, 20 to 30 reps and one set per muscle for medium', () => {
    const read = selectReEntry({ trainingDays: [LAST_DAY], today: daysAfter(LAST_DAY, 60) });

    expect(read.band).toBe('medium');
    expect(read.rule?.value).toEqual({
      loadFactor: 1 / 3,
      repsLow: 20,
      repsHigh: 30,
      setsPerMuscle: 1,
      weeks: 2,
    });
    expect(read.windowEndsOn).toBe(daysAfter(LAST_DAY, 60 + 13));
  });

  it('scales no load and opens no window after a long break', () => {
    const read = selectReEntry({ trainingDays: [LAST_DAY], today: daysAfter(LAST_DAY, 200) });

    expect(read).toMatchObject({ band: 'long', windowEndsOn: null });
    expect(read.rule?.value.loadFactor).toBeNull();
  });
});

describe('selectReEntry after the first session back', () => {
  it('stays returning the day after the first session back from a 26-day break', () => {
    const firstDayBack = daysAfter(LAST_DAY, 26);
    const today = daysAfter(firstDayBack, 1);

    const read = selectReEntry({ trainingDays: [LAST_DAY, firstDayBack], today });

    expect(read).toMatchObject({
      lastTrainingDay: firstDayBack,
      daysSinceLastTrainingDay: 1,
      phase: 'returning',
      band: 'short',
      gapDays: 26,
      windowEndsOn: daysAfter(firstDayBack, 6),
    });
    expect(read.rule?.value.loadFactor).toBe(0.8);
  });

  it('resumes training once the short window has passed', () => {
    const firstDayBack = daysAfter(LAST_DAY, 26);
    const trainingDays = [LAST_DAY, firstDayBack, daysAfter(firstDayBack, 3)];

    const read = selectReEntry({ trainingDays, today: daysAfter(firstDayBack, 7) });

    expect(read).toMatchObject({ phase: 'training', band: 'none', rule: null, windowEndsOn: null });
  });
});

describe('selectReEntry with no training day logged', () => {
  it('reads no_history and points at the starting prescription', () => {
    const read = selectReEntry({ trainingDays: [], today: LAST_DAY });

    expect(read).toMatchObject({
      phase: 'no_history',
      band: 'none',
      lastTrainingDay: null,
      daysSinceLastTrainingDay: null,
      rule: null,
    });
    expect(read.reasoning).toContain('starting prescription');
  });
});

describe('classifyBreak edges', () => {
  it.each([
    [14, 'none'],
    [15, 'short'],
    [28, 'short'],
    [29, 'medium'],
    [182, 'medium'],
    [183, 'long'],
  ] as const)('puts a %i-day break in %s', (days, band) => {
    const read = selectReEntry({ trainingDays: [LAST_DAY], today: daysAfter(LAST_DAY, days) });

    expect(classifyBreak(days)).toBe(band);
    expect(read.band).toBe(band);
  });
});

describe('rule constants', () => {
  it('gives every band edge and rule a source the fragments validator accepts', () => {
    const constants = [...Object.values(BREAK_BAND_MAX_DAYS), ...Object.values(RE_ENTRY_RULES)];

    const problems = constants.flatMap((constant) =>
      validateSource(constant.sourceKind, constant.sourceRef),
    );

    expect(constants).toHaveLength(6);
    expect(problems).toEqual([]);
  });
});
