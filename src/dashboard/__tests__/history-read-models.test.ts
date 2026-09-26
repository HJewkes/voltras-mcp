/**
 * History read models (VW-558, S5a): weeks, blocks, lifts and muscle-weeks over
 * synthetic set lines shaped like the imported log. Pins the evidence grade on
 * every payload point, that an unmapped row is a set and a training day but no
 * muscle's, the with-and-without-surplus pair above a tenth of a muscle's sets,
 * and the retro-data loader the goal-ramp simulation reads through.
 */
import { describe, expect, it } from 'vitest';

import { HISTORY_SEED_EXERCISES } from '../../exercises/history-seed-catalog';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog';
import {
  addDays,
  buildHistoryBlocksView,
  buildHistoryLiftsView,
  buildHistoryMuscleWeeksView,
  buildHistoryWeeksView,
  bridgedGapWeeks,
  evidenceOf,
  historyInputsFromRetroData,
  progressionBlocks,
  type HistoryBoundary,
  type HistoryMuscleWeek,
  type HistorySetRow,
} from '../read-models';

const CATALOG = [...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES];
const catalog = (id: string) => CATALOG.find((exercise) => exercise.id === id);

const row = (over: Partial<HistorySetRow> = {}): HistorySetRow => ({
  day: '2024-01-01',
  exerciseId: 'barbell-bench-press',
  exerciseName: 'Bench Press',
  load: 100,
  reps: 5,
  sets: 1,
  warmup: false,
  writtenOut: true,
  surplusKeptAsWork: false,
  evidence: 'reported',
  confidence: 0.9,
  dividerAbsent: false,
  ...over,
});

/** Monday and Thursday of `weeks` consecutive weeks from the Monday `start`. */
const twiceWeekly = (start: string, weeks: number) =>
  Array.from({ length: weeks }, (_, w) => [
    addDays(start, 7 * w),
    addDays(start, 7 * w + 3),
  ]).flat();

const muscleIn = (week: HistoryMuscleWeek, muscle: string) => {
  const found = week.muscles.find((m) => m.muscle === muscle);
  if (found === undefined) throw new Error(`no row for ${muscle}`);
  return found;
};

describe('evidenceOf', () => {
  it('grades a mix as reported at the lowest confidence, with any missing divider', () => {
    const graded = evidenceOf([
      row({ confidence: 0.9 }),
      row({ confidence: 0.4, dividerAbsent: true }),
      row({ evidence: 'measured', confidence: null }),
    ]);

    expect(graded).toEqual({ evidence: 'reported', confidence: 0.4, dividerAbsent: true });
  });

  it('grades live sets as measured with no parser confidence', () => {
    expect(evidenceOf([row({ evidence: 'measured', confidence: null })])).toEqual({
      evidence: 'measured',
      confidence: null,
      dividerAbsent: false,
    });
  });
});

describe('unmapped rows', () => {
  const rows = [
    row({ day: '2024-01-01' }),
    row({ day: '2024-01-03', exerciseId: null, exerciseName: 'Leaned Wall Press', sets: 3 }),
  ];

  it('count as sets and as a training day in the weeks view', () => {
    const [week] = buildHistoryWeeksView({ rows, source: 'history' }).weeks;

    expect(week).toMatchObject({ week: '2024-01-01', sessions: 2, sets: 4 });
  });

  it('count toward the week and toward no muscle', () => {
    const [week] = buildHistoryMuscleWeeksView({ rows, catalog }).weeks;

    expect(week).toMatchObject({ sets: 4, unattributedSets: 3 });
    const landmarkSets = week!.muscles.reduce((sum, m) => sum + m.sets, 0);
    expect(landmarkSets).toBe(1);
  });

  it('are left out of the lift series', () => {
    const view = buildHistoryLiftsView({ rows });

    expect(view.lifts.map((lift) => lift.exerciseId)).toEqual(['barbell-bench-press']);
  });
});

describe('every payload point carries its evidence', () => {
  const rows = twiceWeekly('2024-01-01', 4).map((day, i) =>
    row({ day, load: 100 + i, confidence: i === 2 ? 0.5 : 0.9, dividerAbsent: i === 5 }),
  );
  const grade = { evidence: expect.any(String), confidence: expect.any(Number) };

  it('on each trained week', () => {
    const view = buildHistoryWeeksView({ rows, source: 'history' });

    for (const week of view.weeks) expect(week.evidence).toMatchObject(grade);
    expect(
      view.weeks.map((week) => [week.evidence!.confidence, week.evidence!.dividerAbsent]),
    ).toEqual([
      [0.9, false],
      [0.5, false],
      [0.9, true],
      [0.9, false],
    ]);
  });

  it('on each lift point, block and trained muscle row', () => {
    const lift = buildHistoryLiftsView({ rows }).lifts[0]!;
    const block = buildHistoryBlocksView({ rows, boundaries: [] }).blocks[0]!;
    const chest = muscleIn(buildHistoryMuscleWeeksView({ rows, catalog }).weeks[0]!, 'chest');

    for (const point of lift.points) expect(point.evidence).toMatchObject(grade);
    expect(lift.points[2]!.evidence.confidence).toBe(0.5);
    expect(block.evidence).toEqual({ evidence: 'reported', confidence: 0.5, dividerAbsent: true });
    expect(chest.evidence).toMatchObject(grade);
  });
});

describe('buildHistoryWeeksView', () => {
  const sparse = twiceWeekly('2024-01-01', 6).map((day) => row({ day, writtenOut: false }));

  it('breaks thinly logged weeks for a logged history', () => {
    const view = buildHistoryWeeksView({ rows: sparse, source: 'history' });

    expect(view.rule.sparseLogging).toBe(true);
    expect(view.weeks.every((week) => week.reasons.includes('sparse_logging'))).toBe(true);
  });

  it('never breaks a live week for sparse logging (D10)', () => {
    const view = buildHistoryWeeksView({ rows: sparse, source: 'live' });

    expect(view.rule.sparseLogging).toBe(false);
    expect(view.weeks.some((week) => week.reasons.includes('sparse_logging'))).toBe(false);
  });

  it('drops warm-up rows before labelling', () => {
    const view = buildHistoryWeeksView({
      rows: [row(), row({ day: '2024-01-08', warmup: true })],
      source: 'history',
    });

    expect(view.weeks.map((week) => week.week)).toEqual(['2024-01-01']);
  });
});

describe('buildHistoryBlocksView', () => {
  const blockA = twiceWeekly('2024-01-01', 4);
  const resumed = addDays(blockA.at(-1)!, 64);
  const blockB = [resumed, ...twiceWeekly('2024-04-01', 3)];
  const loadsA = [100, 100, 105, 105, 110, 110, 115, 115];
  const rowsWith = (restartLoad: number) => [
    ...blockA.map((day, i) => row({ day, load: loadsA[i]! })),
    ...blockB.map((day) => row({ day, load: restartLoad })),
  ];
  const boundaries: HistoryBoundary[] = [
    { week: '2024-01-15', kinds: ['load_drop'], gapDays: null, choice: 'not_a_boundary' },
    { week: '2024-03-25', kinds: ['gap'], gapDays: 64, choice: 'life_gap' },
  ];

  it('drops a not-a-boundary mark and dates each kept block', () => {
    const view = buildHistoryBlocksView({ rows: rowsWith(115), boundaries });

    expect(view.blocks.map((b) => [b.start, b.nextStart, b.trainedWeeks, b.length])).toEqual([
      ['2024-01-01', '2024-03-25', 4, 'within 3:1 to 5:1'],
      ['2024-03-25', '2024-04-22', 4, 'within 3:1 to 5:1'],
    ]);
    expect(view.blocks[1]!.openedBy).toMatchObject({ choice: 'life_gap', gapDays: 64 });
  });

  it('spans the 64-day gap with its days and mark', () => {
    const view = buildHistoryBlocksView({ rows: rowsWith(115), boundaries });

    expect(view.gaps).toEqual([
      {
        after: '2024-01-25',
        endsOn: resumed,
        days: 64,
        week: '2024-03-25',
        choice: 'life_gap',
        bridged: false,
      },
    ]);
  });

  it.each([
    [115, 'at or above final'],
    [108, 'mid-meso'],
    [100, 'at week 1 or below'],
  ])('reads a restart at %i lb as %s', (restartLoad, kind) => {
    const view = buildHistoryBlocksView({ rows: rowsWith(restartLoad), boundaries });

    expect(view.restarts).toEqual([
      {
        lift: 'barbell-bench-press',
        rungs: [
          {
            previousStart: '2024-01-01',
            start: '2024-03-25',
            previousLoads: [100, 105, 110, 115],
            restartLoad,
            kind,
          },
        ],
      },
    ]);
  });

  it('flags the block a planned deload closes, and bridges that week for segmentation', () => {
    const deload: HistoryBoundary = {
      week: '2024-03-25',
      kinds: ['gap'],
      gapDays: 64,
      choice: 'planned_deload',
    };
    const view = buildHistoryBlocksView({ rows: rowsWith(115), boundaries: [deload] });

    expect(view.blocks.map((b) => b.endsInDeload)).toEqual([true, false]);
    expect(bridgedGapWeeks([deload, ...boundaries])).toEqual(new Set(['2024-03-25', '2024-01-15']));
  });

  it('hands WA the trained span of each block', () => {
    const view = buildHistoryBlocksView({ rows: rowsWith(115), boundaries });

    expect(progressionBlocks(view)).toEqual([
      { start: '2024-01-01', end: '2024-01-25' },
      { start: resumed, end: '2024-04-18' },
    ]);
  });

  it('returns no block for no rows', () => {
    expect(buildHistoryBlocksView({ rows: [], boundaries }).blocks).toEqual([]);
  });
});

describe('buildHistoryLiftsView', () => {
  it('fits a rising chapter with an interval, and reads no e1RM past 12 reps', () => {
    const rows = ['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-22'].map((day, i) =>
      row({ day, load: [100, 104, 110, 111][i]! }),
    );
    const lift = buildHistoryLiftsView({
      rows: [...rows, row({ day: '2024-01-29', reps: 13, load: 120 })],
    }).lifts[0]!;

    expect(lift.points.at(-1)!.bestE1RM).toBeNull();
    const chapter = lift.slopes[0]!;
    expect(chapter.period).toBe('chapter');
    expect(chapter.e1rm!.slopePerWeek).toBeGreaterThan(0);
    expect(chapter.e1rm!.ci95PerWeek).toBeGreaterThan(0);
    expect(lift.best!.day).toBe('2024-01-22');
  });

  it('splits an exercise into the chapters the caller names, never reading across', () => {
    const rows = ['2024-01-01', '2024-01-08', '2024-06-03', '2024-06-10'].map((day, i) =>
      row({ day, load: [200, 205, 100, 102][i]! }),
    );
    const chapters = [
      { id: 'c1', exerciseId: 'barbell-bench-press', first: '2024-01-01', last: '2024-01-31' },
      { id: 'c2', exerciseId: 'barbell-bench-press', first: '2024-06-01', last: null },
    ];
    const view = buildHistoryLiftsView({ rows, chapters });

    expect(view.lifts.map((l) => [l.chapterId, l.points.length])).toEqual([
      ['c1', 2],
      ['c2', 2],
    ]);
    expect(view.lifts[1]!.best!.value).toBeLessThan(view.lifts[0]!.best!.value);
  });

  it('finds a plateau window on a flat run and marks it a flatline', () => {
    const rows = twiceWeekly('2024-01-01', 4).map((day) => row({ day, load: 100 }));
    const lift = buildHistoryLiftsView({ rows }).lifts[0]!;

    expect(lift.plateaus).toEqual([
      { start: '2024-01-01', end: '2024-01-25', sessions: 8, flatline: true },
    ]);
  });

  it('reads each named period beside the whole chapter', () => {
    const rows = twiceWeekly('2024-01-01', 4).map((day, i) => row({ day, load: 100 + i }));
    const lift = buildHistoryLiftsView({
      rows,
      periods: [{ name: 'first half', first: '2024-01-01', last: '2024-01-11' }],
    }).lifts[0]!;

    expect(lift.slopes.map((s) => [s.period, s.e1rm?.n])).toEqual([
      ['chapter', 8],
      ['first half', 4],
    ]);
  });
});

describe('buildHistoryMuscleWeeksView', () => {
  const benchWeek = (sets: number, surplus: number) => [
    row({ sets: sets - surplus }),
    ...(surplus > 0 ? [row({ day: '2024-01-04', sets: surplus, surplusKeptAsWork: true })] : []),
  ];

  it('pairs a muscle with and without surplus sets once they pass a tenth', () => {
    const [week] = buildHistoryMuscleWeeksView({ rows: benchWeek(10, 2), catalog }).weeks;

    expect(muscleIn(week!, 'chest')).toMatchObject({
      sets: 10,
      status: 'maintenance',
      withoutSurplus: { sets: 8, status: 'maintenance' },
    });
  });

  it('shows no pair while surplus sets are a tenth or less', () => {
    const [week] = buildHistoryMuscleWeeksView({ rows: benchWeek(12, 1), catalog }).weeks;

    expect(muscleIn(week!, 'chest')).toMatchObject({ sets: 12, withoutSurplus: null });
  });

  it('withholds the glute verdict and still shows the dose', () => {
    const rows = [row({ exerciseId: 'barbell-hip-thrust', exerciseName: 'Hip Thrust', sets: 5 })];
    const [week] = buildHistoryMuscleWeeksView({ rows, catalog }).weeks;

    expect(muscleIn(week!, 'glutes')).toMatchObject({ sets: 5, status: null, dose: { sets: 5 } });
  });

  it('counts a hinge toward its target in the landmark read and its halves in the dose read', () => {
    const rows = [row({ exerciseId: 'barbell-deadlift', exerciseName: 'Deadlift', sets: 4 })];
    const [week] = buildHistoryMuscleWeeksView({ rows, catalog }).weeks;

    expect(muscleIn(week!, 'hamstrings')).toMatchObject({ sets: 4, dose: { sets: 4 } });
    expect(muscleIn(week!, 'glutes')).toMatchObject({ sets: 0, dose: { sets: 2 } });
    expect(muscleIn(week!, 'chest').evidence).toBeNull();
  });
});

describe('historyInputsFromRetroData', () => {
  const retro = {
    adherence: { trainingDays: ['2024-01-04', '2024-01-01'] },
    lifts: [
      {
        lift: 'Bench Press',
        modalReps: 5,
        sessions: [
          {
            date: '2024-01-01',
            topLoad: 100,
            topLoadAtModalReps: 100,
            e1rm: 116.7,
            sets: 3,
            totalReps: 15,
          },
        ],
      },
    ],
    boundaries: [{ week: '2024-01-08', kinds: ['gap'], gapDays: 12, choice: null, triggers: [] }],
  };

  it('reads sessions as WA lift points and boundaries with their marks', () => {
    const inputs = historyInputsFromRetroData(retro);

    expect(inputs.trainingDays).toEqual(['2024-01-01', '2024-01-04']);
    expect(inputs.lifts[0]!.points[0]).toEqual({
      day: '2024-01-01',
      topLoadAtModal: 100,
      bestE1RM: 116.7,
      topLoad: 100,
      sets: 3,
      totalReps: 15,
    });
    expect(inputs.boundaries[0]).toEqual({
      week: '2024-01-08',
      kinds: ['gap'],
      gapDays: 12,
      choice: null,
    });
  });

  it('rejects a boundary mark it does not know', () => {
    const bad = { ...retro, boundaries: [{ ...retro.boundaries[0], choice: 'vacation' }] };

    expect(() => historyInputsFromRetroData(bad)).toThrow(/choice/);
  });
});
