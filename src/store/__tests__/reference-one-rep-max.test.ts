// The lifter's reference 1RM for one exercise (VW-817): the highest Epley
// estimate across their loaded sets, and `undefined` rather than zero when no
// set carries both a load and a rep.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';
import { referenceOneRepMax } from '../rir-velocity-candidates.js';
import type { StoredRep, StoredSet } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  const rep: Rep = { repNumber: index + 1, concentric: EMPTY_PHASE, eccentric: EMPTY_PHASE };
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

let nextSet = 0;

function makeSet(weightLbs: number | undefined, repCount: number): StoredSet {
  const id = `set-${String(nextSet++)}`;
  return {
    id,
    sessionId: 'sess-1',
    exerciseId: 'bench-press',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:01:00.000Z',
    partial: false,
    ...(weightLbs === undefined ? {} : { weightLbs }),
    reps: Array.from({ length: repCount }, (_, i) => makeRep(id, i)),
  };
}

const epley = (load: number, reps: number) => load * (1 + reps / 30);

describe('referenceOneRepMax', () => {
  const cases: { name: string; sets: StoredSet[]; expected: number | undefined }[] = [
    { name: 'no sets', sets: [], expected: undefined },
    { name: 'a set with no load', sets: [makeSet(undefined, 5)], expected: undefined },
    { name: 'a set at zero load', sets: [makeSet(0, 5)], expected: undefined },
    { name: 'a loaded set with no reps', sets: [makeSet(100, 0)], expected: undefined },
    { name: 'one loaded set', sets: [makeSet(100, 5)], expected: epley(100, 5) },
    { name: 'a single rep', sets: [makeSet(150, 1)], expected: epley(150, 1) },
    {
      name: 'several sets, taking the highest estimate',
      sets: [makeSet(100, 10), makeSet(150, 3), makeSet(140, 5)],
      expected: epley(150, 3),
    },
    {
      name: 'loaded sets mixed with unusable ones',
      sets: [makeSet(undefined, 8), makeSet(0, 12), makeSet(200, 0), makeSet(90, 6)],
      expected: epley(90, 6),
    },
  ];

  it.each(cases)('returns the reference for $name', ({ sets, expected }) => {
    const reference = referenceOneRepMax(sets);

    if (expected === undefined) expect(reference).toBeUndefined();
    else expect(reference).toBeCloseTo(expected, 6);
  });
});
