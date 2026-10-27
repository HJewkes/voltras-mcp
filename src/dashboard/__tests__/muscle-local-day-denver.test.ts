// The body map counts training days and labels its week in LOCAL time (VW-918). West of UTC an
// evening set is already the next day in UTC, so this file pins the zone before any Date exists.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

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

/** Wednesday 2026-10-07 at 17:00 and 19:00 local: Wednesday and Thursday in UTC. */
const WEDNESDAY_EVENING: LocalDayScenario = {
  now: '2026-10-07T18:00:00.000Z',
  sameLocalDay: ['2026-10-07T23:00:00.000Z', '2026-10-08T01:00:00.000Z'],
};

describe('muscle days west of UTC', () => {
  it('counts two sets on one local evening as one muscle-week session', () => {
    expect(chestSessions(WEDNESDAY_EVENING)).toBe(1);
  });

  it('counts two sets on one local evening as one observed plan day', () => {
    expect(chestObservedDays(WEDNESDAY_EVENING)).toBe(1);
  });

  it('labels the body map with the local Monday', () => {
    expect(bodyWeekLabel(WEDNESDAY_EVENING)).toBe('Week of 2026-10-05');
  });
});
