// The body map's "this week" is the LOCAL calendar week (VW-915), the same week goals and block
// calendars use. Run west of UTC, where a Sunday-evening set is already Monday in UTC; under UTC
// the old UTC-week rule would pass, which is why this file pins the zone before any Date exists.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, describe, expect, it } from 'vitest';

import { endOfCalendarWeekIso, startOfCalendarWeekIso } from '../read-models/muscle-set-scope.js';
import { buildMuscleWeekView } from '../read-models/muscle-week.js';
import type { StoredSet } from '../../store/types.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Sunday 2026-10-04, 21:30 local: Monday 03:30 in UTC. */
const SUNDAY_EVENING = '2026-10-05T03:30:00.000Z';
/** Local midnight starting Monday 2026-09-28. */
const ITS_WEEK_START = '2026-09-28T06:00:00.000Z';

const catalog = (id: string) =>
  id === 'chest-press' ? { name: 'Chest Press', muscleGroups: ['chest'] } : undefined;

function workingSet(startedAt: string): StoredSet {
  return {
    id: `set-${startedAt}`,
    sessionId: 'sess-1',
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId: 'chest-press',
    firmwareRepCount: 8,
  };
}

function chestSets(sets: StoredSet[], now: string): number | undefined {
  const view = buildMuscleWeekView({ sets, catalog, now: new Date(now) });
  return view.muscles.find((m) => m.muscle === 'chest')?.sets;
}

describe('the calendar week west of UTC', () => {
  it('starts a Sunday 21:30 local instant at the local Monday before it', () => {
    expect(startOfCalendarWeekIso(new Date(SUNDAY_EVENING))).toBe(ITS_WEEK_START);
  });

  it('counts a Sunday-evening set in the week it was lifted, not the next one', () => {
    const sets = [workingSet(SUNDAY_EVENING)];

    expect(chestSets(sets, SUNDAY_EVENING)).toBe(1);
    expect(chestSets(sets, '2026-10-05T18:00:00.000Z')).toBe(0);
  });

  it('ends the week at local midnight when the clocks go back inside it', () => {
    const weekStart = startOfCalendarWeekIso(new Date('2026-10-28T18:00:00.000Z'));
    const lateSunday = '2026-11-02T06:30:00.000Z'; // Sunday 2026-11-01, 23:30 local

    expect(endOfCalendarWeekIso(weekStart)).toBe('2026-11-02T07:00:00.000Z');
    expect(chestSets([workingSet(lateSunday)], '2026-10-28T18:00:00.000Z')).toBe(1);
  });
});
