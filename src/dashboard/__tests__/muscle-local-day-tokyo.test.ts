// The body map counts training days and labels its week in LOCAL time (VW-918). East of UTC a
// morning set is still the previous day in UTC, and local Monday midnight is a Sunday instant,
// so this file pins the zone before any Date exists.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Asia/Tokyo';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../spa/use-viewport.js', () => ({ useIsNarrowViewport: vi.fn(() => false) }));

import {
  bodyWeekLabel,
  chestObservedDays,
  chestSessions,
  type LocalDayScenario,
} from './muscle-local-day-scenario.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Wednesday 2026-10-07 at 08:00 and 10:00 local: Tuesday and Wednesday in UTC. */
const WEDNESDAY_MORNING: LocalDayScenario = {
  now: '2026-10-07T03:00:00.000Z',
  sameLocalDay: ['2026-10-06T23:00:00.000Z', '2026-10-07T01:00:00.000Z'],
};

describe('muscle days east of UTC', () => {
  it('counts two sets on one local morning as one muscle-week session', () => {
    expect(chestSessions(WEDNESDAY_MORNING)).toBe(1);
  });

  it('counts two sets on one local morning as one observed plan day', () => {
    expect(chestObservedDays(WEDNESDAY_MORNING)).toBe(1);
  });

  it('labels the body map with the local Monday, not the Sunday its instant falls on in UTC', () => {
    expect(bodyWeekLabel(WEDNESDAY_MORNING)).toBe('Week of 2026-10-05');
  });
});
