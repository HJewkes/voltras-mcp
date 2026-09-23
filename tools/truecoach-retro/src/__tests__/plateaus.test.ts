import { describe, expect, it } from 'vitest';

import { addDays } from '../dates.js';
import { followUpOf, plateauWindows } from '../plateaus.js';
import type { SessionPoint } from '../series.js';

function point(date: string, e1rm: number, overrides: Partial<SessionPoint> = {}): SessionPoint {
  return {
    date,
    bestE1RM: e1rm,
    topLoad: e1rm * 0.85,
    topLoadAtModal: e1rm * 0.85,
    exercises: ['Lift One'],
    ...overrides,
  };
}

const series = (start: string, values: number[]) =>
  values.map((v, i) => point(addDays(start, 7 * i), v));

describe('plateauWindows', () => {
  it('finds a flat run and marks it a flatline', () => {
    const points = series('2030-01-07', [200, 200, 201, 200, 200, 201, 200]);
    const windows = plateauWindows(
      points,
      points.map((p) => p.date),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startDate: '2030-01-07',
      sessions: 7,
      flatline: true,
      followUp: 'log ends',
    });
  });

  it('finds none on a climb of 10% a week', () => {
    const points = series('2030-01-07', [200, 220, 240, 260, 280, 300]);
    expect(
      plateauWindows(
        points,
        points.map((p) => p.date),
      ),
    ).toEqual([]);
  });

  it('never calls a climb of 5% a week a flatline, though the window detector fires on it', () => {
    const points = series('2030-01-07', [200, 210, 220, 230, 240, 250]);
    const windows = plateauWindows(
      points,
      points.map((p) => p.date),
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((w) => !w.flatline)).toBe(true);
  });

  it('needs three sessions for a window', () => {
    const points = series('2030-01-07', [200, 200]).map((p, i) => ({
      ...p,
      date: addDays('2030-01-07', 21 * i),
    }));
    expect(
      plateauWindows(
        points,
        points.map((p) => p.date),
      ),
    ).toEqual([]);
  });
});

describe('followUpOf', () => {
  const window = series('2030-01-07', [200, 200, 200]);
  const end = window.at(-1)!.date;

  it('reads a ten-day wait for the family as a gap', () => {
    expect(followUpOf(window, point(addDays(end, 10), 200), [addDays(end, 10)])).toBe('gap');
  });

  it('reads the family going on without the lift for three weeks as a swap', () => {
    const family = [addDays(end, 3), addDays(end, 10), addDays(end, 24)];
    expect(followUpOf(window, undefined, family)).toBe('swap');
  });

  it('reads the log running out before three weeks as log ends, not a swap', () => {
    expect(followUpOf(window, undefined, [addDays(end, 3)])).toBe('log ends');
  });

  it('reads a return at 90% of the load or less as a load reset', () => {
    const next = point(addDays(end, 3), 200, { topLoad: 150 });
    expect(followUpOf(window, next, [next.date])).toBe('load reset');
  });

  it('reads a new e1RM high as broke through, and the same as continued flat', () => {
    expect(followUpOf(window, point(addDays(end, 3), 210), [addDays(end, 3)])).toBe(
      'broke through',
    );
    expect(followUpOf(window, point(addDays(end, 3), 200), [addDays(end, 3)])).toBe(
      'continued flat',
    );
  });
});
