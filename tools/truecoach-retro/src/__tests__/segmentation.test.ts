import { describe, expect, it } from 'vitest';

import { addDays } from '../dates.js';
import {
  reportedExercisesByWeek,
  segmentWeeks,
  type BoundaryDecision,
  type LabelledWeek,
} from '../segmentation.js';

import { setRow } from './fixtures.js';

const FIRST_MONDAY = '2030-01-07';
const monday = (week: number) => addDays(FIRST_MONDAY, 7 * week);

/** Training days for each listed week index: Monday, Tuesday, Thursday, Friday, cut to `sessions`. */
function days(weeks: readonly number[], sessions: (week: number) => number = () => 4): string[] {
  return weeks.flatMap((week) =>
    [0, 1, 3, 4].slice(0, sessions(week)).map((offset) => addDays(monday(week), offset)),
  );
}

/** Every trained week logged set by set, with five exercises written out. */
function reported(weeks: readonly number[]): Map<string, number> {
  return new Map(weeks.map((week) => [monday(week), 5]));
}

function segment(
  weeks: readonly number[],
  options: {
    sessions?: (week: number) => number;
    reported?: Map<string, number>;
    decisions?: BoundaryDecision[] | null;
  } = {},
) {
  return segmentWeeks(
    days(weeks, options.sessions),
    options.reported ?? reported(weeks),
    options.decisions ?? null,
  );
}

function labels(weeks: readonly LabelledWeek[]): Record<string, string> {
  return Object.fromEntries(
    weeks.map((w) => [w.week, w.label === 'broken' ? w.reasons.join('+') : w.label]),
  );
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('segmentWeeks', () => {
  it('labels a steady run regular, all but its last two weeks, which are the tail', () => {
    const result = segment(range(0, 5));
    expect(labels(result.weeks)).toEqual({
      [monday(0)]: 'regular',
      [monday(1)]: 'regular',
      [monday(2)]: 'regular',
      [monday(3)]: 'regular',
      [monday(4)]: 'tail',
      [monday(5)]: 'tail',
    });
  });

  it('ends a run at an unmarked gap over 10 days, leaving a two-week run short', () => {
    const result = segment([0, 1, ...range(4, 9)]);
    expect(labels(result.weeks)).toMatchObject({
      [monday(0)]: 'short_run',
      [monday(1)]: 'short_run',
      [monday(2)]: 'untrained',
      [monday(4)]: 'regular',
    });
    expect(result.runs.map((r) => r.trainedWeeks)).toEqual([2, 6]);
  });

  it('keeps a run going across a gap marked a planned deload, and breaks it at a life gap', () => {
    const planned = segment([0, 1, ...range(4, 9)], {
      decisions: [{ week: monday(4), choice: 'planned_deload' }],
    });
    const life = segment([0, 1, ...range(4, 9)], {
      decisions: [{ week: monday(4), choice: 'life_gap' }],
    });
    expect(labels(planned.weeks)[monday(0)]).toBe('regular');
    expect(planned.gaps).toEqual([
      { week: monday(4), days: 17, choice: 'planned_deload', breaksRun: false },
    ]);
    expect(labels(life.weeks)[monday(0)]).toBe('short_run');
  });

  it('does not break a run at a gap of exactly 10 days', () => {
    const result = segment([0, ...range(2, 7)]);
    expect(result.gaps).toEqual([]);
    expect(labels(result.weeks)).toMatchObject({
      [monday(0)]: 'regular',
      [monday(1)]: 'untrained',
    });
  });

  it('marks the first week after a gap over 21 days as a gap edge even when the gap was planned', () => {
    const result = segment([0, 1, 2, ...range(6, 11)], {
      decisions: [{ week: monday(6), choice: 'planned_deload' }],
    });
    expect(labels(result.weeks)).toMatchObject({
      [monday(0)]: 'regular',
      [monday(6)]: 'gap_edge',
      [monday(7)]: 'regular',
    });
  });

  it('breaks a week under the modal count minus one and leaves it out of the steady count', () => {
    const result = segment(range(0, 5), { sessions: (week) => (week === 1 ? 2 : 4) });
    expect(labels(result.weeks)).toMatchObject({
      [monday(0)]: 'regular',
      [monday(1)]: 'low_frequency',
      [monday(2)]: 'regular',
    });
  });

  it('breaks every week of a run that holds fewer than three steady weeks', () => {
    const weeks = range(0, 6);
    const result = segment(weeks, { sessions: (week) => (week === 1 || week === 3 ? 1 : 4) });
    expect(labels(result.weeks)).toMatchObject({
      [monday(0)]: 'regular',
      [monday(2)]: 'regular',
    });
    const sparse = segment(range(0, 3), { sessions: (week) => (week % 2 === 1 ? 1 : 4) });
    expect(labels(sparse.weeks)[monday(0)]).toBe('short_run');
  });

  it('breaks a week where fewer than three exercises carry a written-out set', () => {
    const weeks = range(0, 5);
    const logged = reported(weeks).set(monday(2), 2);
    expect(labels(segment(weeks, { reported: logged }).weeks)[monday(2)]).toBe('sparse_logging');
  });
});

describe('reportedExercisesByWeek', () => {
  it('counts distinct exercises with a written-out set and skips bare-load and warm-up rows', () => {
    const rows = [
      setRow({ exercise_name: 'Lift One' }),
      setRow({ exercise_name: 'Lift One', set_index: 2 }),
      setRow({ exercise_name: 'Lift Two', decided_by: 'bare_load_all_prescribed_sets' }),
      setRow({
        exercise_name: 'Lift Three',
        decided_by: 'planned_email_with_results:bare_load_all_prescribed_sets',
      }),
      setRow({ exercise_name: 'Lift Four', is_warmup: true }),
      setRow({ exercise_name: 'Lift Five', workout_due_date: '2030-01-14' }),
    ];
    expect(reportedExercisesByWeek(rows)).toEqual(
      new Map([
        ['2030-01-07', 1],
        ['2030-01-14', 1],
      ]),
    );
  });
});
