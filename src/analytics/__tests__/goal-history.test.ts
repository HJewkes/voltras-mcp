// Unit tests for src/analytics/goal-history.ts (VW-350).
//
// The top load at matched reps a goal target starts from, and the personal
// records on a reading series. Pure, so every case here is a table row.

import { describe, expect, it } from 'vitest';

import {
  markPersonalRecords,
  modalRepCount,
  topLoadAtReps,
  type RepCountedSet,
} from '../goal-history.js';

function set(
  sessionId: string,
  endedAt: string,
  weightLbs: number,
  repCount: number,
): RepCountedSet {
  return { sessionId, endedAt, weightLbs, repCount };
}

describe('topLoadAtReps', () => {
  it('reads the heaviest matching load from the most recent matching session', () => {
    const read = topLoadAtReps(
      [
        set('s1', '2026-08-01T00:00:00.000Z', 200, 5),
        set('s2', '2026-09-01T00:00:00.000Z', 150, 5),
        set('s2', '2026-09-01T01:00:00.000Z', 165, 5),
      ],
      5,
    );
    expect(read).toEqual({
      value: 165,
      measuredAt: '2026-09-01T01:00:00.000Z',
      matchedSessionCount: 2,
    });
  });

  it('counts a set carried for MORE than the anchor reps as matching', () => {
    const read = topLoadAtReps([set('s1', '2026-09-01T00:00:00.000Z', 135, 8)], 5);
    expect(read?.value).toBe(135);
  });

  it('excludes a set that fell short of the anchor reps', () => {
    expect(topLoadAtReps([set('s1', '2026-09-01T00:00:00.000Z', 225, 3)], 5)).toBeNull();
  });

  it('excludes a weightless set rather than reading it as a zero start value', () => {
    expect(topLoadAtReps([set('s1', '2026-09-01T00:00:00.000Z', 0, 10)], 5)).toBeNull();
  });

  it('counts DISTINCT sessions, not sets', () => {
    const read = topLoadAtReps(
      [
        set('s1', '2026-09-01T00:00:00.000Z', 100, 6),
        set('s1', '2026-09-01T01:00:00.000Z', 105, 6),
        set('s1', '2026-09-01T02:00:00.000Z', 110, 6),
      ],
      5,
    );
    expect(read?.matchedSessionCount).toBe(1);
  });
});

describe('modalRepCount', () => {
  it('returns the rep count worked at most often', () => {
    expect(
      modalRepCount([
        set('s1', '2026-09-01T00:00:00.000Z', 100, 8),
        set('s1', '2026-09-01T01:00:00.000Z', 100, 8),
        set('s2', '2026-09-03T00:00:00.000Z', 105, 5),
      ]),
    ).toBe(8);
  });

  it('breaks a tie toward the lower count, the heavier end of the two', () => {
    expect(
      modalRepCount([
        set('s1', '2026-09-01T00:00:00.000Z', 100, 10),
        set('s2', '2026-09-03T00:00:00.000Z', 105, 5),
      ]),
    ).toBe(5);
  });

  it('has no answer without sets', () => {
    expect(modalRepCount([])).toBeNull();
  });
});

describe('markPersonalRecords', () => {
  const reading = (ts: string, value: number) => ({ ts, value });

  it('marks a reading that passes every earlier one, and leaves a lower one alone', () => {
    const marked = markPersonalRecords([
      reading('2026-08-03T00:00:00.000Z', 180),
      reading('2026-08-10T00:00:00.000Z', 175),
      reading('2026-08-17T00:00:00.000Z', 185),
    ]);

    expect(marked.map((r) => r.isPR)).toEqual([false, false, true]);
  });

  it('does not call a tie a record', () => {
    const marked = markPersonalRecords([
      reading('2026-08-03T00:00:00.000Z', 180),
      reading('2026-08-10T00:00:00.000Z', 180),
    ]);

    expect(marked.map((r) => r.isPR)).toEqual([false, false]);
  });

  it('never marks the first reading, which has nothing behind it to beat', () => {
    expect(markPersonalRecords([reading('2026-08-03T00:00:00.000Z', 180)])).toEqual([
      { ts: '2026-08-03T00:00:00.000Z', value: 180, isPR: false },
    ]);
  });

  it('reads an out-of-order series the same as a sorted one', () => {
    const marked = markPersonalRecords([
      reading('2026-08-17T00:00:00.000Z', 185),
      reading('2026-08-03T00:00:00.000Z', 180),
    ]);

    expect(marked.map((r) => [r.value, r.isPR])).toEqual([
      [185, true],
      [180, false],
    ]);
  });
});
