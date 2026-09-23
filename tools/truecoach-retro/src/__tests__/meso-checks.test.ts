import { describe, expect, it } from 'vitest';

import {
  carries,
  mesoRamps,
  restartKind,
  restarts,
  slopePerStep,
  type MesoSpan,
} from '../meso-checks.js';
import type { SessionPoint } from '../series.js';

const MESOS: MesoSpan[] = [
  { startWeek: '2030-01-07', endWeek: '2030-02-04' },
  { startWeek: '2030-02-04', endWeek: '2030-03-04' },
];

function point(date: string, bestE1RM: number): SessionPoint {
  return {
    date,
    bestE1RM,
    topLoad: bestE1RM,
    topLoadAtModal: bestE1RM,
    sets: 3,
    totalReps: 15,
    exercises: ['Lift One'],
  };
}

describe('restartKind', () => {
  it("reads RP's three restart patterns against the previous meso's weekly loads", () => {
    const previous = [200, 210, 220, 230];
    expect(restartKind(previous, 226)).toBe('at or above final');
    expect(restartKind(previous, 215)).toBe('mid-meso');
    expect(restartKind(previous, 204)).toBe('at week 1 or below');
    expect(restartKind(previous, 180)).toBe('at week 1 or below');
  });
});

describe('restarts', () => {
  it("compares a meso's first load with the previous meso's loads, and skips a one-week previous meso", () => {
    const loads = new Map([
      ['2030-01-07', 200],
      ['2030-01-14', 220],
      ['2030-02-11', 210],
      ['2030-02-18', 230],
    ]);
    const mesos = [{ startWeek: '2029-12-31', endWeek: '2030-01-07' }, ...MESOS];
    expect(restarts(loads, mesos)).toEqual([
      {
        previousStart: '2030-01-07',
        start: '2030-02-04',
        previousLoads: [200, 220],
        restartLoad: 210,
        kind: 'mid-meso',
      },
    ]);
  });
});

describe('mesoRamps', () => {
  it('fits a slope per trained week and counts a week without the muscle as zero sets', () => {
    const weeks = new Map([
      ['2030-01-07', new Map([['chest', 8]])],
      [
        '2030-01-14',
        new Map([
          ['chest', 10],
          ['lats', 6],
        ]),
      ],
      [
        '2030-01-21',
        new Map([
          ['chest', 12],
          ['lats', 6],
        ]),
      ],
    ]);
    const ramps = mesoRamps(weeks, MESOS);
    expect(ramps.map((r) => [r.muscle, r.sets, r.kind])).toEqual([
      ['chest', [8, 10, 12], 'ramped'],
      ['lats', [0, 6, 6], 'ramped'],
    ]);
    expect(slopePerStep([10, 10, 10])).toBe(0);
  });

  it('skips a meso with fewer than three trained weeks', () => {
    const weeks = new Map([['2030-02-04', new Map([['chest', 8]])]]);
    expect(mesoRamps(weeks, MESOS)).toEqual([]);
  });
});

describe('carries', () => {
  const points = [point('2030-01-08', 200), point('2030-01-29', 201), point('2030-02-05', 203)];

  it('marks a lift stale when it went in flat and the next peak did not beat the last by more than 5 lb', () => {
    const [carry] = carries(points, [{ start: '2030-01-08', end: '2030-01-29' }], MESOS);
    expect(carry).toMatchObject({
      peakBefore: 201,
      peakAfter: 203,
      plateauOpen: true,
      stale: true,
    });
  });

  it('does not mark a lift stale when no flatline window covered its last session', () => {
    const [carry] = carries(points, [{ start: '2029-12-01', end: '2030-01-20' }], MESOS);
    expect(carry).toMatchObject({ plateauOpen: false, flat: true, stale: false });
  });

  it('does not mark an open plateau stale when the next meso beat it', () => {
    const rising = [...points.slice(0, 2), point('2030-02-05', 230)];
    const [carry] = carries(rising, [{ start: '2030-01-08', end: '2030-01-29' }], MESOS);
    expect(carry).toMatchObject({ plateauOpen: true, stale: false });
  });
});
