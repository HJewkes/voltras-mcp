// The block calendar (VW-473). fast-check is not a dependency of this repo, so the
// property checks run as table sweeps: every length from 1 to 8 weeks, every skip position,
// both modes, and every pair of skips up to 6 weeks, each asserting the same properties.

import { describe, expect, it } from 'vitest';

import type { BlockScheduleSkip, StoredBlockSchedule } from '../../store/types.js';
import {
  addDays,
  blockCalendar,
  planWeeksOf,
  type BlockCalendar,
  type PlanWeek,
} from '../block-calendar.js';

const START = '2026-09-21';

function row(weeksCount: number, skips: BlockScheduleSkip[] = []): StoredBlockSchedule {
  return {
    id: 'row',
    blockId: 'blk',
    seq: 1,
    startsOn: START,
    weeksCount,
    skips,
    kind: skips.length === 0 ? 'planned' : 'week_skipped',
    changedBy: 'user',
    declaredAt: '2026-09-19T12:00:00.000Z',
  };
}

const mondayOf = (calendarWeek: number): string => addDays(START, 7 * (calendarWeek - 1));

/** The properties every calendar holds, whatever its skips. */
function expectSound(calendar: BlockCalendar, weeksCount: number, skips: BlockScheduleSkip[]) {
  const extendDates = skips.filter((s) => s.mode === 'extend').map((s) => s.weekOf);
  const planWeeks = calendar.weeks.map((week) => week.planWeek).filter((n) => n !== null);
  expect(calendar.weeks).toHaveLength(weeksCount + extendDates.length);
  expect(planWeeks).toEqual(Array.from({ length: weeksCount }, (_, i) => i + 1));
  calendar.weeks.forEach((week, index) => {
    expect(week.calendarWeek).toBe(index + 1);
    expect(week.startsOn).toBe(mondayOf(index + 1));
    expect(week.endsOn).toBe(addDays(week.startsOn, 6));
    expect(week.planWeek === null).toBe(extendDates.includes(week.startsOn));
  });
  expect(calendar.startsOn).toBe(START);
  expect(calendar.endsOn).toBe(calendar.weeks.at(-1)?.endsOn);
}

const LENGTHS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('a block with no skips', () => {
  it.each(LENGTHS)('runs %i plan weeks over as many calendar weeks', (weeksCount) => {
    const calendar = blockCalendar(row(weeksCount), [], START);

    expectSound(calendar, weeksCount, []);
    expect(calendar.endsOn).toBe(addDays(START, 7 * weeksCount - 1));
  });
});

describe('one skip, every position and both modes', () => {
  const cases = LENGTHS.flatMap((weeksCount) =>
    Array.from({ length: weeksCount }, (_, i) => [weeksCount, i + 1] as const),
  );

  it.each(cases)('a %i-week block held at week %i ends on its planned date', (weeksCount, at) => {
    const skips: BlockScheduleSkip[] = [{ weekOf: mondayOf(at), mode: 'hold' }];

    const calendar = blockCalendar(row(weeksCount, skips), [], START);

    expectSound(calendar, weeksCount, skips);
    expect(calendar.endsOn).toBe(addDays(START, 7 * weeksCount - 1));
    expect(calendar.weeks[at - 1]).toMatchObject({ planWeek: at, skipped: 'hold' });
  });

  it.each(cases)('a %i-week block extended at week %i ends a week later', (weeksCount, at) => {
    const skips: BlockScheduleSkip[] = [{ weekOf: mondayOf(at), mode: 'extend' }];

    const calendar = blockCalendar(row(weeksCount, skips), [], START);

    expectSound(calendar, weeksCount, skips);
    expect(calendar.endsOn).toBe(addDays(START, 7 * (weeksCount + 1) - 1));
    expect(calendar.weeks[at - 1]).toMatchObject({ planWeek: null, skipped: 'extend' });
    expect(calendar.weeks[at]?.planWeek).toBe(at);
  });
});

describe('two skips, every pair and every mode', () => {
  const modes = ['hold', 'extend'] as const;
  type Mode = (typeof modes)[number];
  /** The second skip may land in the week an extend at the first opened past the planned end. */
  const lastWeek = (weeksCount: number, firstMode: Mode) =>
    firstMode === 'extend' ? weeksCount + 1 : weeksCount;
  const cases: (readonly [number, number, Mode, number, Mode])[] = [];
  for (const weeksCount of [2, 3, 4, 5, 6]) {
    for (let first = 1; first <= weeksCount; first++) {
      for (const firstMode of modes) {
        for (let second = first + 1; second <= lastWeek(weeksCount, firstMode); second++) {
          for (const secondMode of modes) {
            cases.push([weeksCount, first, firstMode, second, secondMode]);
          }
        }
      }
    }
  }

  it.each(cases)(
    'a %i-week block, week %i %s then week %i %s',
    (weeksCount, first, firstMode, second, secondMode) => {
      const skips: BlockScheduleSkip[] = [
        { weekOf: mondayOf(second), mode: secondMode },
        { weekOf: mondayOf(first), mode: firstMode },
      ];

      const calendar = blockCalendar(row(weeksCount, skips), [], START);

      expectSound(calendar, weeksCount, skips);
      expect(calendar.weeks[first - 1]?.skipped).toBe(firstMode);
      expect(calendar.weeks[second - 1]?.skipped).toBe(secondMode);
    },
  );
});

describe('block states', () => {
  const calendar = (today: string) => blockCalendar(row(2), [], today);
  const END = addDays(START, 13);

  it.each([
    [addDays(START, -1), 'upcoming'],
    [START, 'current'],
    [END, 'current'],
    [addDays(END, 1), 'ended'],
  ])('reads %s as %s', (today, state) => {
    expect(calendar(today).state).toBe(state);
  });

  it('reads a block with no schedule row as undated', () => {
    expect(blockCalendar(undefined, [], START)).toEqual({
      startsOn: null,
      endsOn: null,
      state: 'undated',
      weeks: [],
    });
  });

  it('reads a cleared row as undated', () => {
    const cleared = { ...row(2), kind: 'cleared' as const, startsOn: undefined };

    expect(blockCalendar(cleared, [], START).state).toBe('undated');
  });
});

describe('plan week content', () => {
  it('keeps a declared length with missing week rows: weeks with no row plan nothing (R2)', () => {
    const planWeeks = planWeeksOf([
      { id: 'wk-1', blockId: 'blk', orderIndex: 0, name: 'Week 1', isDeload: false },
    ]);

    const calendar = blockCalendar(row(4), planWeeks, START);

    expect(calendar.weeks.map((week) => week.name ?? null)).toEqual(['Week 1', null, null, null]);
    expect(calendar.endsOn).toBe(addDays(START, 27));
  });

  it('carries a deload onto the calendar week that runs it, past an extend', () => {
    const planWeeks: PlanWeek[] = [
      { planWeek: 1, isDeload: false },
      { planWeek: 2, isDeload: false },
      { planWeek: 3, isDeload: true, name: 'Deload' },
    ];
    const skips: BlockScheduleSkip[] = [{ weekOf: mondayOf(2), mode: 'extend' }];

    const calendar = blockCalendar(row(3, skips), planWeeks, START);

    expect(calendar.weeks.map((week) => week.isDeload)).toEqual([false, false, false, true]);
    expect(calendar.weeks[3]).toMatchObject({ planWeek: 3, name: 'Deload' });
  });
});
