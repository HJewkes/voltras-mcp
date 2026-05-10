// Unit tests for src/state/session-list-aggregator.ts.
//
// Pure-function tests — no store, no server-state, no async I/O.
// Covers aggregateSession and aggregateSessionFull across the documented edge
// cases: empty sessions, single/multi-set shapes, deduplication, duration math.
import { describe, it, expect } from 'vitest';
import type { StoredSession, StoredSet, StoredRep } from '../../store/types.js';
import { aggregateSession, aggregateSessionFull } from '../session-list-aggregator.js';

const TS_START = '2025-01-01T10:00:00.000Z';
const TS_END = '2025-01-01T11:00:00.000Z'; // 3 600 000 ms later

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    startedAt: TS_START,
    ...overrides,
  };
}

function makeSet(overrides: Partial<StoredSet> = {}): StoredSet {
  return {
    id: 'set-1',
    sessionId: 'sess-1',
    startedAt: TS_START,
    endedAt: TS_END,
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 100,
    reps: [],
    ...overrides,
  };
}

function makeRep(id: string, setId = 'set-1'): StoredRep {
  const phase = {
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
  return {
    id,
    setId,
    index: 0,
    repNumber: 1,
    concentric: phase,
    eccentric: phase,
  };
}

describe('aggregateSession', () => {
  it('preserves all StoredSession fields on the output', () => {
    const session = makeSession({ exerciseId: 'bench', notes: 'good session', endedAt: TS_END });
    const result = aggregateSession(session, []);
    expect(result.id).toBe('sess-1');
    expect(result.startedAt).toBe(TS_START);
    expect(result.endedAt).toBe(TS_END);
    expect(result.exerciseId).toBe('bench');
    expect(result.notes).toBe('good session');
  });

  describe('empty session (no sets)', () => {
    it('returns setCount = 0', () => {
      expect(aggregateSession(makeSession(), []).setCount).toBe(0);
    });

    it('returns totalReps = 0', () => {
      expect(aggregateSession(makeSession(), []).totalReps).toBe(0);
    });

    it('returns topWeightLbs = null', () => {
      expect(aggregateSession(makeSession(), []).topWeightLbs).toBeNull();
    });

    it('returns trainingModes = []', () => {
      expect(aggregateSession(makeSession(), []).trainingModes).toEqual([]);
    });

    it('returns totalDurationMs = null when endedAt is absent', () => {
      expect(aggregateSession(makeSession(), []).totalDurationMs).toBeNull();
    });
  });

  describe('totalDurationMs', () => {
    it('computes endedAt - startedAt in milliseconds', () => {
      const session = makeSession({ endedAt: TS_END });
      const result = aggregateSession(session, []);
      expect(result.totalDurationMs).toBe(3_600_000);
    });

    it('returns null when endedAt is absent (session still active)', () => {
      const session = makeSession(); // no endedAt
      expect(aggregateSession(session, []).totalDurationMs).toBeNull();
    });
  });

  describe('single set', () => {
    const set = makeSet({
      weightLbs: 135,
      trainingMode: 'WeightTraining',
      reps: [makeRep('r1'), makeRep('r2'), makeRep('r3')],
    });

    it('returns setCount = 1', () => {
      expect(aggregateSession(makeSession(), [set]).setCount).toBe(1);
    });

    it('counts reps in the set', () => {
      expect(aggregateSession(makeSession(), [set]).totalReps).toBe(3);
    });

    it('returns weightLbs of that set as topWeightLbs', () => {
      expect(aggregateSession(makeSession(), [set]).topWeightLbs).toBe(135);
    });

    it('returns the set trainingMode in trainingModes', () => {
      expect(aggregateSession(makeSession(), [set]).trainingModes).toEqual(['WeightTraining']);
    });
  });

  describe('multiple sets', () => {
    const setA = makeSet({
      id: 'set-a',
      weightLbs: 100,
      trainingMode: 'WeightTraining',
      reps: [makeRep('r1', 'set-a'), makeRep('r2', 'set-a')],
    });
    const setB = makeSet({
      id: 'set-b',
      weightLbs: 185,
      trainingMode: 'Isokinetic',
      reps: [makeRep('r3', 'set-b')],
    });
    const setC = makeSet({
      id: 'set-c',
      weightLbs: 150,
      trainingMode: 'WeightTraining', // duplicate
      reps: [],
    });
    const sets = [setA, setB, setC];

    it('returns the correct setCount', () => {
      expect(aggregateSession(makeSession(), sets).setCount).toBe(3);
    });

    it('sums reps across all sets', () => {
      expect(aggregateSession(makeSession(), sets).totalReps).toBe(3);
    });

    it('picks max weightLbs across sets as topWeightLbs', () => {
      expect(aggregateSession(makeSession(), sets).topWeightLbs).toBe(185);
    });

    it('deduplicates training modes, preserving first-appearance order', () => {
      expect(aggregateSession(makeSession(), sets).trainingModes).toEqual([
        'WeightTraining',
        'Isokinetic',
      ]);
    });
  });
});

describe('aggregateSessionFull', () => {
  it('includes all summary fields', () => {
    const set = makeSet({ weightLbs: 200, reps: [makeRep('r1')] });
    const result = aggregateSessionFull(makeSession(), [set]);
    expect(result.setCount).toBe(1);
    expect(result.totalReps).toBe(1);
    expect(result.topWeightLbs).toBe(200);
    expect(result.trainingModes).toEqual(['WeightTraining']);
  });

  it('includes the full sets array', () => {
    const set = makeSet({ id: 'set-full' });
    const result = aggregateSessionFull(makeSession(), [set]);
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0].id).toBe('set-full');
  });

  it('sets array is empty when there are no sets', () => {
    const result = aggregateSessionFull(makeSession(), []);
    expect(result.sets).toEqual([]);
  });
});
