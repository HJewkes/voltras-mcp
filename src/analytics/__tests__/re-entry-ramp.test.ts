// The climb-back ramp after a return window (VW-988): equal weekly steps from the window load
// back to the pre-break load, over half the weeks off, kept between 2 and 12 weeks.

import { describe, expect, it } from 'vitest';

import {
  RETURN_RAMP_WEEKS_CLAMP,
  RETURN_RAMP_WEEKS_PER_BREAK_WEEK,
  rampSteps,
  returnRampWeeks,
  selectReturnRamp,
} from '../re-entry.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Training every 3 days before a break of `gapDays`, then every 3 days up to `today`. */
function daysAround(firstDayBack: string, gapDays: number, today: string): string[] {
  const lastBefore = addDays(firstDayBack, -gapDays);
  const before = [addDays(lastBefore, -6), addDays(lastBefore, -3), lastBefore];
  const after: string[] = [];
  for (let day = firstDayBack; day <= today; day = addDays(day, 3)) after.push(day);
  return [...before, ...after];
}

const BACK = '2026-03-02';

function rampOn(gapDays: number, today: string, preBreakLoadLbs = 150) {
  return selectReturnRamp({
    trainingDays: daysAround(BACK, gapDays, today),
    today,
    preBreakLoadLbs,
  });
}

describe('selectReturnRamp', () => {
  it('gives a 12-week break a 6-week ramp whose last week is the pre-break load', () => {
    // Medium window: two weeks from the first day back, so the ramp opens on day 15.
    const ramp = rampOn(84, addDays(BACK, 14));

    expect(ramp).toMatchObject({ band: 'medium', weeks: 6, week: 1, loadLbs: 65 });
    expect(ramp?.startsOn).toBe(addDays(BACK, 14));
    expect(ramp?.endsOn).toBe(addDays(BACK, 14 + 6 * 7 - 1));
    expect(ramp?.steps).toEqual([65, 80, 100, 115, 130, 150]);
  });

  it('reaches the pre-break load in the ramp last week', () => {
    const ramp = rampOn(84, addDays(BACK, 14 + 5 * 7));

    expect(ramp).toMatchObject({ week: 6, loadLbs: 150, preBreakLoadLbs: 150 });
  });

  it('clamps a 3-week break up to a 2-week ramp from the short window load', () => {
    // Short window: one week, at 0.8 x 150 = 120.
    const ramp = rampOn(21, addDays(BACK, 7));

    expect(ramp).toMatchObject({ band: 'short', weeks: 2, week: 1 });
    expect(ramp?.steps).toEqual([135, 150]);
  });

  it('clamps a half-year break down to a 12-week ramp', () => {
    expect(rampOn(182, addDays(BACK, 14))?.weeks).toBe(12);
  });

  it('never goes above the pre-break load, even off a load step', () => {
    const ramp = rampOn(84, addDays(BACK, 14), 137);

    expect(ramp?.steps.at(-1)).toBe(137);
    expect(Math.max(...(ramp?.steps ?? []))).toBe(137);
  });

  it('climbs in steps that never fall back', () => {
    const steps = rampSteps(45, 140, 12);

    expect(steps.every((load, index) => index === 0 || load >= steps[index - 1])).toBe(true);
    expect(steps.at(-1)).toBe(140);
  });

  it.each([
    ['inside the return window', 84, 13],
    ['once the ramp has ended', 84, 14 + 6 * 7],
    ['after a long break, which has no window load', 200, 14],
    ['after a break inside the 14-day edge', 10, 14],
  ])('is null %s', (_name, gapDays, dayBack) => {
    expect(rampOn(gapDays, addDays(BACK, dayBack))).toBeNull();
  });

  it('is null during a new open break', () => {
    const trainingDays = daysAround(BACK, 84, addDays(BACK, 14));
    const today = addDays(trainingDays.at(-1)!, 20);

    expect(selectReturnRamp({ trainingDays, today, preBreakLoadLbs: 150 })).toBeNull();
  });
});

describe('the ramp constants', () => {
  it('are sourced, with the pace from practice and the clamp an engineering default', () => {
    expect(RETURN_RAMP_WEEKS_PER_BREAK_WEEK.value).toBe(0.5);
    expect(RETURN_RAMP_WEEKS_PER_BREAK_WEEK.sourceRef).toContain('strongerbyscience');
    expect(RETURN_RAMP_WEEKS_CLAMP).toMatchObject({
      value: { min: 2, max: 12 },
      sourceKind: 'engineering-default',
    });
  });

  it('round half the weeks off', () => {
    expect(returnRampWeeks(84)).toBe(6);
    expect(returnRampWeeks(56)).toBe(4);
  });
});
