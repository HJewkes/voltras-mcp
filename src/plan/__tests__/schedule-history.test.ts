// The `history` fact (VW-476): counts and one sentence from a block's schedule rows.

import { describe, expect, it } from 'vitest';

import type { StoredBlockSchedule } from '../../store/types.js';
import { scheduleHistory, shortDate } from '../schedule-history.js';

function row(seq: number, over: Partial<StoredBlockSchedule>): StoredBlockSchedule {
  return {
    id: `r${seq}`,
    blockId: 'b',
    seq,
    startsOn: '2026-09-14',
    weeksCount: 4,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: `2026-09-0${seq}T12:00:00.000Z`,
    ...over,
  };
}

describe('scheduleHistory', () => {
  it('says a block moved twice, from where to where, and why', () => {
    const history = scheduleHistory([
      row(1, {}),
      row(2, { kind: 'moved', startsOn: '2026-09-21' }),
      row(3, { kind: 'moved', startsOn: '2026-09-28', reason: 'travel' }),
    ]);

    expect(history).toMatchObject({ moves: 2, resizes: 0, holds: 0, extends: 0 });
    expect(history.firstPlanned).toEqual({
      startsOn: '2026-09-14',
      endsOn: '2026-10-11',
      declaredAt: '2026-09-01T12:00:00.000Z',
    });
    expect(history.fact).toBe(
      'This block has moved twice: first planned for Mon 14 Sep, now Mon 28 Sep (travel).',
    );
  });

  it('says a block kept its start, and counts resizes and missed weeks', () => {
    const history = scheduleHistory([
      row(1, {}),
      row(2, { kind: 'resized', weeksCount: 5 }),
      row(3, {
        kind: 'week_skipped',
        weeksCount: 5,
        skips: [
          { weekOf: '2026-09-14', mode: 'hold' },
          { weekOf: '2026-09-21', mode: 'extend' },
        ],
      }),
    ]);

    expect(history.fact).toBe(
      'This block has kept its planned start, Mon 14 Sep. Its length changed once. ' +
        'Missed weeks: 1 held, 1 extended.',
    );
  });

  it('says an undated or un-dated block has no dates', () => {
    expect(scheduleHistory([]).fact).toBe('This block has never had dates.');
    expect(
      scheduleHistory([row(1, {}), row(2, { kind: 'cleared', startsOn: undefined })]).fact,
    ).toBe('This block had dates and was un-dated.');
  });

  it('writes dates as a short weekday, day and month', () => {
    expect(shortDate('2026-10-04')).toBe('Sun 4 Oct');
  });
});
