// Unit tests for the VW-301 expected-rep-range module.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import {
  MIN_HISTORY_SETS,
  historicalRepsToThreshold,
  repsToThresholdRange,
} from '../reps-to-threshold-range.js';
import type { StoredSet } from '../../store/types.js';

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

/** `_movementSampleCount: 1` keeps every rep above `selectEligibleReps`' floor. */
function makeRep(repNumber: number, peakVelocity: number): Rep {
  return {
    repNumber,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity,
      _totalVelocity: peakVelocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

function repsOf(velocities: number[]): Rep[] {
  return velocities.map((v, i) => makeRep(i + 1, v));
}

/** A stored set whose reps decay linearly from `first` to `last` over `repCount` reps. */
function makeSet(
  id: string,
  weightLbs: number,
  first: number,
  last: number,
  repCount: number,
): StoredSet {
  const velocities = Array.from({ length: repCount }, (_, i) =>
    repCount === 1 ? first : first + (last - first) * (i / (repCount - 1)),
  );
  return {
    id,
    sessionId: 'sess-1',
    startedAt: '2026-07-30T10:00:00.000Z',
    endedAt: '2026-07-30T10:02:00.000Z',
    partial: false,
    weightLbs,
    reps: repsOf(velocities) as StoredSet['reps'],
  } as StoredSet;
}

describe('repsToThresholdRange', () => {
  // Named numbers: median 10, floor 5 (-5), ceiling 15 (+5) — the same
  // ~5-rep-either-side magnitude as Jukic et al. 2023's -5.4/+5.5 rep 95%
  // limits of agreement for reps-to-a-fixed-VL-threshold.
  it('pins the range derivation on a Jukic-scale spread', () => {
    const result = repsToThresholdRange([10, 5, 15, 8, 12]);
    expect(result).toEqual({
      expectedLow: 5,
      expectedHigh: 15,
      median: 10,
      n: 5,
      basis: expect.stringContaining('5 historical sets'),
    });
  });

  it('is null below the minimum history floor', () => {
    expect(MIN_HISTORY_SETS).toBe(3);
    expect(repsToThresholdRange([8, 12])).toBeNull();
  });

  it('reports a range at exactly the minimum floor', () => {
    const result = repsToThresholdRange([8, 10, 12]);
    expect(result).not.toBeNull();
    expect(result?.n).toBe(3);
  });

  it('takes the median of an even-length history', () => {
    const result = repsToThresholdRange([8, 10, 12, 14]);
    expect(result?.median).toBe(11);
  });

  // Mutation to report: hard-coding `expectedLow`/`expectedHigh` to the first
  // and last array elements (rather than sorting first) fails this test.
  it('sorts before taking the low/high bounds', () => {
    const result = repsToThresholdRange([15, 5, 10]);
    expect(result?.expectedLow).toBe(5);
    expect(result?.expectedHigh).toBe(15);
  });
});

describe('historicalRepsToThreshold', () => {
  it('includes only sets at the exact load', () => {
    const atLoad = makeSet('s1', 100, 1.0, 0.7, 5); // reaches 30% loss
    const otherLoad = makeSet('s2', 90, 1.0, 0.7, 5);
    const history = historicalRepsToThreshold([atLoad, otherLoad], 100, 30);
    expect(history).toEqual([historicalRepsToThreshold([atLoad], 100, 30)[0]]);
    expect(history).toHaveLength(1);
  });

  it('drops sets that never reach the threshold', () => {
    const shallow = makeSet('s1', 100, 1.0, 0.98, 4);
    expect(historicalRepsToThreshold([shallow], 100, 30)).toEqual([]);
  });

  it('drops sets with no recorded weight', () => {
    const noWeight = { ...makeSet('s1', 100, 1.0, 0.7, 5), weightLbs: undefined };
    expect(historicalRepsToThreshold([noWeight], 100, 30)).toEqual([]);
  });

  it('collects one reps-to-threshold count per qualifying set', () => {
    const a = makeSet('s1', 100, 1.0, 0.6, 6);
    const b = makeSet('s2', 100, 1.0, 0.65, 5);
    const history = historicalRepsToThreshold([a, b], 100, 30);
    expect(history).toHaveLength(2);
    for (const count of history) expect(typeof count).toBe('number');
  });
});
