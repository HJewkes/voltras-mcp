// Local-time invariants of dated blocks (VW-473), run west of UTC where the two bugs they
// guard against show: I5 (a start date is a Monday however the process timezone reads it)
// and I10 (a session belongs to the week of its LOCAL end date). Under UTC both mutants
// would pass, which is why this file pins the zone before any Date is constructed.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, describe, expect, it } from 'vitest';

import type { StoredBlockSchedule } from '../../store/types.js';
import { blockCalendar, isMonday, weekOfInstant } from '../block-calendar.js';
import { openTestStore } from '../../store/__tests__/open-test-store.js';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const AT = '2026-09-19T12:00:00.000Z';

describe('the zone this file runs in', () => {
  it('is six hours west of UTC in September', () => {
    expect(new Date('2026-09-21T00:00:00.000Z').getTimezoneOffset()).toBe(360);
  });
});

describe('a start date is a Monday in local time (I5)', () => {
  it('reads 2026-09-21 as a Monday although its UTC midnight is Sunday evening here', () => {
    expect(isMonday('2026-09-21')).toBe(true);
    expect(isMonday('2026-09-20')).toBe(false);
  });

  it('lets the store accept the Monday and refuse the Sunday', async () => {
    const store = openTestStore();
    await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
    await store.putTrainingBlock({
      id: 'blk',
      programId: 'prog',
      orderIndex: 0,
      name: 'Orientation',
      weeksCount: 2,
    });
    const input = {
      blockId: 'blk',
      weeksCount: 2,
      skips: [],
      kind: 'planned' as const,
      changedBy: 'user' as const,
      declaredAt: AT,
    };

    const monday = await store.appendBlockSchedule({ ...input, startsOn: '2026-09-21' });
    const sunday = await store.appendBlockSchedule({ ...input, startsOn: '2026-09-20' }).then(
      () => 'accepted',
      (err: { code?: string }) => err.code,
    );

    expect(monday.startsOn).toBe('2026-09-21');
    expect(sunday).toBe('BLOCK_SCHEDULE_INVALID');
    await store.close();
  });
});

describe('a session belongs to the week of its local end date (I10)', () => {
  const live: StoredBlockSchedule = {
    id: 'row',
    blockId: 'blk',
    seq: 1,
    startsOn: '2026-09-21',
    weeksCount: 2,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: AT,
  };
  const calendar = blockCalendar(live, [], '2026-09-21');

  it('files a Sunday 21:00 session in that Sunday’s week, not the next Monday’s', () => {
    const sundayEvening = '2026-09-28T03:00:00.000Z';

    expect(weekOfInstant(calendar, sundayEvening)?.calendarWeek).toBe(1);
  });

  it('files a Monday 06:00 session in the new week', () => {
    expect(weekOfInstant(calendar, '2026-09-28T12:00:00.000Z')?.calendarWeek).toBe(2);
  });

  it('files a session outside the block in no week', () => {
    expect(weekOfInstant(calendar, '2026-09-21T03:00:00.000Z')).toBeNull();
  });
});
