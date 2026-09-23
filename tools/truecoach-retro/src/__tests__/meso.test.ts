import { describe, expect, it } from 'vitest';

import { classifyMesoLength, mesoBoundaries, mesosBetween } from '../meso.js';

const weeks = (entries: [string, number][]) => new Map(entries);
const days = ['2030-01-07', '2030-01-14', '2030-01-21', '2030-01-28'];

describe('mesoBoundaries', () => {
  it('ends a meso where two main lifts drop 10% or more in the same week', () => {
    const tops = new Map([
      [
        'Lift One',
        weeks([
          ['2030-01-14', 200],
          ['2030-01-21', 180],
        ]),
      ],
      [
        'Lift Two',
        weeks([
          ['2030-01-14', 100],
          ['2030-01-21', 85],
        ]),
      ],
    ]);
    expect(mesoBoundaries(days, tops)).toEqual([
      {
        week: '2030-01-21',
        triggers: ['load drop: Lift One -10%, Lift Two -15%'],
        gapDays: null,
        drops: [
          { lift: 'Lift One', pct: 10 },
          { lift: 'Lift Two', pct: 15 },
        ],
      },
    ]);
  });

  it('does not end a meso on one lift dropping', () => {
    const tops = new Map([
      [
        'Lift One',
        weeks([
          ['2030-01-14', 200],
          ['2030-01-21', 150],
        ]),
      ],
      [
        'Lift Two',
        weeks([
          ['2030-01-14', 100],
          ['2030-01-21', 100],
        ]),
      ],
    ]);
    expect(mesoBoundaries(days, tops)).toEqual([]);
  });

  it('compares a lift with its own previous trained week, across weeks it skipped', () => {
    const tops = new Map([
      [
        'Lift One',
        weeks([
          ['2030-01-07', 200],
          ['2030-01-21', 190],
        ]),
      ],
      [
        'Lift Two',
        weeks([
          ['2030-01-14', 100],
          ['2030-01-21', 80],
        ]),
      ],
    ]);
    expect(mesoBoundaries(days, tops)).toEqual([]);
  });

  it('ends a meso at a gap of ten days and merges a drop in the same week', () => {
    const gapped = ['2030-01-07', '2030-01-17', '2030-01-18'];
    const tops = new Map([
      [
        'Lift One',
        weeks([
          ['2030-01-07', 200],
          ['2030-01-14', 170],
        ]),
      ],
      [
        'Lift Two',
        weeks([
          ['2030-01-07', 100],
          ['2030-01-14', 80],
        ]),
      ],
    ]);
    expect(mesoBoundaries(gapped, tops)).toEqual([
      {
        week: '2030-01-14',
        triggers: ['load drop: Lift One -15%, Lift Two -20%', 'gap 10 days'],
        gapDays: 10,
        drops: [
          { lift: 'Lift One', pct: 15 },
          { lift: 'Lift Two', pct: 20 },
        ],
      },
    ]);
  });

  it('does not end a meso at a nine-day gap', () => {
    expect(mesoBoundaries(['2030-01-07', '2030-01-16'], new Map())).toEqual([]);
  });
});

describe('mesosBetween', () => {
  it('counts trained weeks apart from the calendar weeks a gap spans', () => {
    const trained = ['2030-01-07', '2030-01-14', '2030-02-18', '2030-02-25'];
    const mesos = mesosBetween(trained, [
      { week: '2030-02-18', triggers: ['gap 35 days'], gapDays: 35, drops: [] },
    ]);
    expect(mesos).toEqual([
      { startWeek: '2030-01-07', endWeek: '2030-02-18', weeks: 6, trainedWeeks: 2 },
      { startWeek: '2030-02-18', endWeek: '2030-03-04', weeks: 2, trainedWeeks: 2 },
    ]);
  });
});

describe('classifyMesoLength', () => {
  it('reads four to six weeks as inside 3:1 to 5:1', () => {
    expect([3, 4, 6, 7].map(classifyMesoLength)).toEqual([
      'short',
      'within 3:1 to 5:1',
      'within 3:1 to 5:1',
      'long',
    ]);
  });
});
