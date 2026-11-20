/**
 * History-blocks pure helpers (VW-817): which boundary marks bridge a gap, how
 * training days and boundaries cut into block spans, and how a lift's restart
 * load reads against the previous block's week-by-week loads.
 */
import { describe, expect, it } from 'vitest';

import {
  blockSpans,
  bridgedGapWeeks,
  restartKind,
  type BoundaryChoice,
  type HistoryBlockSpan,
  type HistoryBoundary,
  type RestartKind,
} from '../read-models';

const boundary = (week: string, choice: BoundaryChoice | null): HistoryBoundary => ({
  week,
  kinds: ['gap'],
  gapDays: 14,
  choice,
});

describe('bridgedGapWeeks', () => {
  const cases: { name: string; boundaries: HistoryBoundary[]; expected: string[] }[] = [
    { name: 'no boundaries', boundaries: [], expected: [] },
    { name: 'an unmarked boundary', boundaries: [boundary('2024-02-05', null)], expected: [] },
    {
      name: 'a planned deload',
      boundaries: [boundary('2024-02-05', 'planned_deload')],
      expected: ['2024-02-05'],
    },
    {
      name: 'a not-a-boundary mark',
      boundaries: [boundary('2024-02-05', 'not_a_boundary')],
      expected: ['2024-02-05'],
    },
    { name: 'a life gap', boundaries: [boundary('2024-02-05', 'life_gap')], expected: [] },
    {
      name: 'an unplanned drop',
      boundaries: [boundary('2024-02-05', 'unplanned_drop')],
      expected: [],
    },
    {
      name: 'a mix, keeping only the bridging weeks',
      boundaries: [
        boundary('2024-02-05', 'life_gap'),
        boundary('2024-03-04', 'planned_deload'),
        boundary('2024-04-01', null),
        boundary('2024-05-06', 'not_a_boundary'),
      ],
      expected: ['2024-03-04', '2024-05-06'],
    },
  ];

  it.each(cases)('bridges $name', ({ boundaries, expected }) => {
    expect(bridgedGapWeeks(boundaries)).toEqual(new Set(expected));
  });
});

describe('blockSpans', () => {
  const cases: {
    name: string;
    days: string[];
    boundaries: HistoryBoundary[];
    expected: HistoryBlockSpan[];
  }[] = [
    { name: 'no training days give no blocks', days: [], boundaries: [], expected: [] },
    {
      name: 'one mid-week day is one block from its Monday to the next',
      days: ['2024-01-03'],
      boundaries: [],
      expected: [{ start: '2024-01-01', nextStart: '2024-01-08' }],
    },
    {
      name: 'days with no boundary are one block ending the week after the last day',
      days: ['2024-01-01', '2024-01-11', '2024-01-26'],
      boundaries: [],
      expected: [{ start: '2024-01-01', nextStart: '2024-01-29' }],
    },
    {
      name: 'an unmarked boundary splits the run',
      days: ['2024-01-01', '2024-01-22'],
      boundaries: [boundary('2024-01-22', null)],
      expected: [
        { start: '2024-01-01', nextStart: '2024-01-22' },
        { start: '2024-01-22', nextStart: '2024-01-29' },
      ],
    },
    {
      name: 'a planned deload still splits the run',
      days: ['2024-01-01', '2024-01-22'],
      boundaries: [boundary('2024-01-22', 'planned_deload')],
      expected: [
        { start: '2024-01-01', nextStart: '2024-01-22' },
        { start: '2024-01-22', nextStart: '2024-01-29' },
      ],
    },
    {
      name: 'a not-a-boundary mark removes the split',
      days: ['2024-01-01', '2024-01-22'],
      boundaries: [boundary('2024-01-22', 'not_a_boundary')],
      expected: [{ start: '2024-01-01', nextStart: '2024-01-29' }],
    },
    {
      name: 'a boundary in or before the first week is dropped',
      days: ['2024-01-10', '2024-01-24'],
      boundaries: [boundary('2024-01-01', 'life_gap'), boundary('2024-01-08', null)],
      expected: [{ start: '2024-01-08', nextStart: '2024-01-29' }],
    },
    {
      name: 'out-of-order boundaries are sorted into consecutive blocks',
      days: ['2024-01-01', '2024-02-05', '2024-03-04'],
      boundaries: [boundary('2024-03-04', 'unplanned_drop'), boundary('2024-02-05', 'life_gap')],
      expected: [
        { start: '2024-01-01', nextStart: '2024-02-05' },
        { start: '2024-02-05', nextStart: '2024-03-04' },
        { start: '2024-03-04', nextStart: '2024-03-11' },
      ],
    },
  ];

  it.each(cases)('$name', ({ days, boundaries, expected }) => {
    expect(blockSpans(days, boundaries)).toEqual(expected);
  });
});

describe('restartKind', () => {
  const cases: {
    name: string;
    previousLoads: number[];
    restartLoad: number;
    expected: RestartKind;
  }[] = [
    {
      name: 'above the final load',
      previousLoads: [100, 120, 140],
      restartLoad: 150,
      expected: 'at or above final',
    },
    {
      name: 'within 5 lb under the final load',
      previousLoads: [100, 120, 140],
      restartLoad: 135,
      expected: 'at or above final',
    },
    {
      name: 'just past 5 lb under the final load',
      previousLoads: [100, 120, 140],
      restartLoad: 134,
      expected: 'mid-meso',
    },
    {
      name: 'between week 1 and the final load',
      previousLoads: [100, 120, 140],
      restartLoad: 120,
      expected: 'mid-meso',
    },
    {
      name: 'just past 5 lb over week 1',
      previousLoads: [100, 120, 140],
      restartLoad: 106,
      expected: 'mid-meso',
    },
    {
      name: 'within 5 lb over week 1',
      previousLoads: [100, 120, 140],
      restartLoad: 105,
      expected: 'at week 1 or below',
    },
    {
      name: 'below week 1',
      previousLoads: [100, 120, 140],
      restartLoad: 80,
      expected: 'at week 1 or below',
    },
    {
      name: 'in reach of both ends, where the final load wins',
      previousLoads: [100, 108],
      restartLoad: 104,
      expected: 'at or above final',
    },
    {
      name: 'after a block that ended lighter than it began',
      previousLoads: [140, 120, 100],
      restartLoad: 110,
      expected: 'at or above final',
    },
  ];

  it.each(cases)(
    'reads a restart $name as $expected',
    ({ previousLoads, restartLoad, expected }) => {
      expect(restartKind(previousLoads, restartLoad)).toBe(expected);
    },
  );
});
