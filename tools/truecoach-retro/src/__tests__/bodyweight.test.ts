import { describe, expect, it } from 'vitest';

import { bodyweightPhases, readingsOf, turningWeeks } from '../bodyweight.js';
import { addDays } from '../dates.js';
import type { CheckinRecord } from '../types.js';

const weekly = (start: string, values: number[]) =>
  values.map((value, i) => ({ date: addDays(start, 7 * i), value }));

function checkin(field: string, date: string, value: number): CheckinRecord {
  return { field, workout_due_date: date, email_date: null, value };
}

describe('readingsOf', () => {
  it('drops a reading far from its field median, and says so', () => {
    const rows = [200, 199, 60, 198].map((v, i) =>
      checkin('Weight', addDays('2030-01-07', 7 * i), v),
    );
    const { readings, dropped } = readingsOf(rows, 'Weight');
    expect(readings.map((r) => r.value)).toEqual([200, 199, 198]);
    expect(dropped).toEqual([{ date: '2030-01-21', value: 60 }]);
  });
});

describe('turningWeeks', () => {
  it('turns when the new sign holds three weeks', () => {
    const means = weekly('2030-01-07', [200, 198, 196, 197, 198, 199]);
    expect(turningWeeks(means, 3)).toEqual([2]);
  });

  it('does not turn on a two-week bounce', () => {
    const means = weekly('2030-01-07', [200, 198, 196, 197, 198, 196, 194]);
    expect(turningWeeks(means, 3)).toEqual([]);
  });
});

describe('bodyweightPhases', () => {
  it('labels a loss and a gain either side of a held turn', () => {
    const phases = bodyweightPhases(weekly('2030-01-07', [200, 196, 192, 188, 190, 192, 194]));
    expect(phases.map((p) => [p.startDate, p.label])).toEqual([
      ['2030-01-07', 'loss'],
      ['2030-01-28', 'gain'],
    ]);
    expect(phases[0]!.dietFatigueBand).toBe('low');
  });

  it('starts a new phase after a check-in gap over 21 days', () => {
    const readings = [
      ...weekly('2030-01-07', [200, 200, 200]),
      ...weekly('2030-03-04', [200, 200]),
    ];
    expect(bodyweightPhases(readings).map((p) => p.label)).toEqual(['maintenance', 'maintenance']);
  });
});
