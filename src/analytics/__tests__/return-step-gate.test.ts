// The return sessions' own ratings gate each climb-back step (VW-993): two feel ratings below 0
// in a row hold the load and drop a set, soreness at the top two check-in levels holds the load,
// and a passing session climbs at most one ramp step.

import { describe, expect, it } from 'vitest';

import {
  RETURN_FEEL_HOLD,
  RETURN_RATING_LOOKBACK_DAYS,
  RETURN_SORENESS_HOLD_LEVELS,
  cappedRampLoad,
  returnStepGate,
  type ReturnRamp,
  type ReturnSessionRating,
} from '../re-entry.js';

const TODAY = '2026-04-10';

function rated(on: string, rating: Omit<ReturnSessionRating, 'on'>): ReturnSessionRating {
  return { on, ...rating };
}

describe('returnStepGate on feel ratings', () => {
  it('holds the load and drops a set after two sessions in a row rated below 0', () => {
    const ratings = [rated('2026-04-06', { feel: -1 }), rated('2026-04-08', { feel: -3 })];

    expect(returnStepGate(ratings, TODAY)).toEqual({
      kind: 'hold',
      reason: 'the last two sessions felt unpleasant',
      dropSet: true,
    });
  });

  it.each([
    ['one session below 0', [rated('2026-04-08', { feel: -2 })]],
    [
      'a neutral rating last',
      [rated('2026-04-06', { feel: -2 }), rated('2026-04-08', { feel: 0 })],
    ],
    [
      'a good rating between',
      [rated('2026-04-04', { feel: -2 }), rated('2026-04-06', { feel: 2 })],
    ],
  ])('steps up after %s', (_case, ratings) => {
    expect(returnStepGate(ratings, TODAY)).toEqual({ kind: 'step' });
  });

  it('reads the last two feel ratings past a session that gave only a soreness answer', () => {
    const ratings = [
      rated('2026-04-05', { feel: -1 }),
      rated('2026-04-07', { feel: -2 }),
      rated('2026-04-09', { soreness: 'low' }),
    ];

    expect(returnStepGate(ratings, TODAY)).toMatchObject({ kind: 'hold', dropSet: true });
  });

  it('lets a rating older than the lookback stop holding a step', () => {
    const ratings = [rated('2026-04-02', { feel: -4 }), rated('2026-04-08', { feel: -1 })];

    expect(returnStepGate(ratings, TODAY)).toEqual({ kind: 'step' });
  });
});

describe('returnStepGate on soreness', () => {
  it.each(['medium', 'high'] as const)(
    'holds the load without dropping a set when soreness was %s',
    (soreness) => {
      const gate = returnStepGate([rated('2026-04-08', { soreness })], TODAY);

      expect(gate).toEqual({
        kind: 'hold',
        reason: `soreness was ${soreness} after the last session`,
        dropSet: false,
      });
    },
  );

  it('steps up when soreness was low', () => {
    expect(returnStepGate([rated('2026-04-08', { soreness: 'low' })], TODAY)).toEqual({
      kind: 'step',
    });
  });

  it('reads only the latest soreness answer', () => {
    const ratings = [
      rated('2026-04-06', { soreness: 'high' }),
      rated('2026-04-08', { soreness: 'low' }),
    ];

    expect(returnStepGate(ratings, TODAY)).toEqual({ kind: 'step' });
  });

  it('steps up with no ratings at all', () => {
    expect(returnStepGate([], TODAY)).toEqual({ kind: 'step' });
  });
});

describe('the gate thresholds', () => {
  it('carries a source on every threshold, the feel rule marked as an inference', () => {
    expect(RETURN_FEEL_HOLD.value).toEqual({ below: 0, sessions: 2 });
    expect(RETURN_FEEL_HOLD.sourceRef).toMatch(/^An inference/);
    expect(RETURN_SORENESS_HOLD_LEVELS.value).toEqual(['medium', 'high']);
    expect(RETURN_RATING_LOOKBACK_DAYS.value).toBe(7);
  });
});

const RAMP: ReturnRamp = {
  band: 'medium',
  startsOn: '2026-03-16',
  endsOn: '2026-04-26',
  weeks: 6,
  week: 4,
  steps: [65, 80, 100, 115, 130, 150],
  loadLbs: 115,
  preBreakLoadLbs: 150,
};

describe('cappedRampLoad', () => {
  it('climbs one step after a held week rather than jumping to the week load', () => {
    expect(cappedRampLoad(RAMP, 80)).toBe(100);
  });

  it('gives the week load when the lift sits one step under it', () => {
    expect(cappedRampLoad(RAMP, 100)).toBe(115);
  });

  it('gives the week load when the lift was at or above it', () => {
    expect(cappedRampLoad(RAMP, 115)).toBe(115);
    expect(cappedRampLoad(RAMP, 120)).toBe(115);
  });

  it('climbs to the first step above a load lifted off the step grid', () => {
    expect(cappedRampLoad(RAMP, 85)).toBe(100);
  });
});
