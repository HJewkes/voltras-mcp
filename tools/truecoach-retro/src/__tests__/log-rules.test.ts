import { describe, expect, it } from 'vitest';

import { buildExerciseLookup } from '../exercise-map.js';
import { groupBlocks, trainingDays } from '../log-rules.js';
import { detectProgrammeSplit } from '../periods.js';
import {
  modalWeeklyCount,
  sessionsPerWeek,
  weeklyFrequencyByMuscle,
  weeklySetsByMuscle,
} from '../weekly.js';

import { mapEntry, setRow } from './fixtures.js';

describe('trainingDays', () => {
  it('counts a date with a work row and skips one holding only warm-ups', () => {
    const rows = [
      setRow({ workout_due_date: '2030-01-07' }),
      setRow({ workout_due_date: '2030-01-08', is_warmup: true }),
      setRow({ workout_due_date: '2030-01-09', is_warmup: null }),
    ];
    expect(trainingDays(rows)).toEqual(['2030-01-07', '2030-01-09']);
  });
});

describe('groupBlocks', () => {
  it('keeps two headers in one email apart', () => {
    const rows = [
      setRow(),
      setRow({ exercise_label: 'B', exercise_name: 'Lift Two' }),
      setRow({ set_index: 2 }),
    ];
    expect(groupBlocks(rows).map((b) => b.rows.length)).toEqual([2, 1]);
  });
});

describe('weekly rollups', () => {
  const lookup = buildExerciseLookup([
    mapEntry(),
    mapEntry({ log_name: 'Overhead', primary_muscle: 'shoulders', secondary_muscles: [] }),
  ]);

  it('sums the sets field per primary muscle and spreads shoulders over the three delts', () => {
    const rows = [
      setRow({ sets: 3 }),
      setRow({ exercise_name: 'Overhead', sets: 2 }),
      setRow({ is_warmup: true }),
    ];
    const week = weeklySetsByMuscle(rows, lookup).get('2030-01-07')!;
    expect(Object.fromEntries(week)).toEqual({
      chest: 3,
      front_delts: 2,
      side_delts: 2,
      rear_delts: 2,
    });
  });

  it('counts a set in full toward each of several primaries and never toward a secondary', () => {
    const hinge = buildExerciseLookup([
      mapEntry({
        log_name: 'Hinge',
        primary_muscle: ['hamstrings', 'glutes'],
        secondary_muscles: ['back'],
      }),
    ]);
    const rows = [setRow({ exercise_name: 'Hinge', sets: 3 })];
    const week = weeklySetsByMuscle(rows, hinge).get('2030-01-07')!;
    expect(Object.fromEntries(week)).toEqual({ hamstrings: 3, glutes: 3 });
  });

  it('counts a hinge day toward the frequency of both its primaries', () => {
    const hinge = buildExerciseLookup([
      mapEntry({ log_name: 'Hinge', primary_muscle: ['hamstrings', 'glutes'] }),
      mapEntry({ log_name: 'Curl', primary_muscle: 'hamstrings', secondary_muscles: [] }),
    ]);
    const rows = [
      setRow({ exercise_name: 'Hinge' }),
      setRow({ exercise_name: 'Curl', workout_due_date: '2030-01-09' }),
    ];
    const week = weeklyFrequencyByMuscle(rows, hinge).get('2030-01-07')!;
    expect(Object.fromEntries(week)).toEqual({ hamstrings: 2, glutes: 1 });
  });

  it('counts distinct days per muscle per week', () => {
    const rows = [setRow(), setRow({ set_index: 2 }), setRow({ workout_due_date: '2030-01-09' })];
    expect(weeklyFrequencyByMuscle(rows, lookup).get('2030-01-07')!.get('chest')).toBe(2);
  });

  it('includes empty weeks between the first and last training day', () => {
    const counts = sessionsPerWeek(['2030-01-07', '2030-01-08', '2030-01-22']);
    expect([...counts]).toEqual([
      ['2030-01-07', 2],
      ['2030-01-14', 0],
      ['2030-01-21', 1],
    ]);
  });

  it('takes the most common non-zero week, the fuller one on a tie', () => {
    expect(modalWeeklyCount([0, 0, 0, 3, 3, 4, 4])).toBe(4);
    expect(modalWeeklyCount([0, 0])).toBeNull();
  });
});

describe('exercise lookup', () => {
  it('reads a map row with no primary muscle as unmapped', () => {
    const lookup = buildExerciseLookup([mapEntry({ log_name: 'Cable', primary_muscle: null })]);
    expect(lookup.isMapped('Cable')).toBe(false);
    expect(lookup.isMapped('Never Seen')).toBe(false);
  });

  it('reads an empty primary list as unmapped', () => {
    const lookup = buildExerciseLookup([mapEntry({ log_name: 'Cable', primary_muscle: [] })]);
    expect(lookup.isMapped('Cable')).toBe(false);
  });

  it('relates two primaries of one entry to each other and to its secondaries', () => {
    const lookup = buildExerciseLookup([
      mapEntry({ primary_muscle: ['hamstrings', 'glutes'], secondary_muscles: ['back'] }),
    ]);
    expect(lookup.related('hamstrings', 'glutes')).toBe(true);
    expect(lookup.related('glutes', 'upper_back')).toBe(true);
    expect(lookup.related('lats', 'upper_back')).toBe(false);
  });

  it('relates a primary to its own secondary, and not to an unrelated muscle', () => {
    const lookup = buildExerciseLookup([mapEntry()]);
    expect(lookup.related('chest', 'triceps')).toBe(true);
    expect(lookup.related('chest', 'quads')).toBe(false);
  });
});

describe('detectProgrammeSplit', () => {
  const day = (date: string, line: string) =>
    setRow({ workout_due_date: date, prescription_lines: [line] });

  it('splits on the first day of the first month written mostly load-first', () => {
    const rows = [
      day('2030-01-07', '3 x 10 RPE 8'),
      day('2030-02-04', '3 x 10 RPE 8'),
      day('2030-02-11', '100 @ 3 x 5'),
      day('2030-02-18', '100 @ 3 x 5'),
    ];
    expect(detectProgrammeSplit(rows)).toBe('2030-02-11');
  });

  it('finds no split when load-first never dominates', () => {
    expect(detectProgrammeSplit([day('2030-01-07', '3 x 10 RPE 8')])).toBeNull();
  });
});
