// Unit tests for src/state/progression-aggregator.ts.
//
// All tests operate on the pure `aggregateProgression` function with no I/O.
// Fixtures are constructed inline — no imports from external packages required.
//
// Rep completion model under test:
//   totalReps    = reps across ALL sets in the session (partial + complete)
//   completedReps = reps from sets where partial === false only
import { describe, it, expect } from 'vitest';
import { aggregateProgression } from '../progression-aggregator.js';
import type { StoredSession, StoredSet } from '../../store/types.js';
import type { Rep } from '@voltras/workout-analytics';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeRep(repNumber: number): Rep {
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
  return { repNumber, concentric: phase, eccentric: phase };
}

function makeSession(
  id: string,
  startedAt: string,
  exerciseId = 'cable-chest-press',
): StoredSession {
  return { id, startedAt, exerciseId };
}

function makeSet(
  id: string,
  sessionId: string,
  weightLbs: number,
  repCount: number,
  partial = false,
  partialReason?: string,
): StoredSet {
  const reps = Array.from({ length: repCount }, (_, i) =>
    Object.assign(makeRep(i + 1), { id: `${id}-r${i + 1}`, setId: id, index: i }),
  );
  const base: StoredSet = {
    id,
    sessionId,
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:05:00.000Z',
    partial,
    trainingMode: 'WeightTraining',
    weightLbs,
    reps,
  };
  if (partialReason !== undefined) {
    return { ...base, partialReason };
  }
  return base;
}

const NOW = '2025-02-01T00:00:00.000Z';
const WINDOW_START = '2024-12-01T00:00:00.000Z';
const EX_ID = 'cable-chest-press';

// ── Empty: exerciseId with no matching sessions ───────────────────────────────

describe('aggregateProgression — empty', () => {
  it('returns zero counts and null trend when sessions array is empty', () => {
    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [], new Map());
    expect(result.exerciseId).toBe(EX_ID);
    expect(result.windowStartedAt).toBe(WINDOW_START);
    expect(result.windowEndedAt).toBe(NOW);
    expect(result.sessionCount).toBe(0);
    expect(result.sessions).toHaveLength(0);
    expect(result.trend).toBeNull();
  });
});

// ── Single session: trend is null ────────────────────────────────────────────

describe('aggregateProgression — single session', () => {
  it('returns one session summary and null trend', () => {
    const session = makeSession('s1', '2025-01-10T00:00:00.000Z');
    const sets = [makeSet('set-a', 's1', 100, 5)];
    const setsBySession = new Map([['s1', sets]]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [session], setsBySession);

    expect(result.sessionCount).toBe(1);
    expect(result.trend).toBeNull();

    const summary = result.sessions[0];
    expect(summary.sessionId).toBe('s1');
    expect(summary.setCount).toBe(1);
    expect(summary.topWeightLbs).toBe(100);
    expect(summary.totalReps).toBe(5);
    expect(summary.completedReps).toBe(5);
    expect(summary.estimatedTotalVolumeLbs).toBe(500);
  });

  it('treats partial sets correctly: totalReps counts them, completedReps excludes them', () => {
    const session = makeSession('s1', '2025-01-10T00:00:00.000Z');
    const sets = [
      makeSet('set-a', 's1', 100, 5, false), // complete — 5 reps
      makeSet('set-b', 's1', 110, 3, true, 'device_signal'), // partial — 3 reps
    ];
    const setsBySession = new Map([['s1', sets]]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [session], setsBySession);

    const summary = result.sessions[0];
    expect(summary.totalReps).toBe(8); // 5 + 3
    expect(summary.completedReps).toBe(5); // only from non-partial set
  });
});

// ── Multi-session: positive trend ────────────────────────────────────────────

describe('aggregateProgression — multi-session positive trend', () => {
  it('computes trend correctly when weight increases', () => {
    const s1 = makeSession('s1', '2025-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', '2025-01-08T00:00:00.000Z');
    const s3 = makeSession('s3', '2025-01-15T00:00:00.000Z');

    const setsBySession = new Map([
      ['s1', [makeSet('a1', 's1', 80, 5)]], // vol = 400
      ['s2', [makeSet('a2', 's2', 90, 5)]], // vol = 450
      ['s3', [makeSet('a3', 's3', 100, 5)]], // vol = 500
    ]);

    // Pass in reverse order to verify sorting to oldest→newest.
    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [s3, s1, s2], setsBySession);

    expect(result.sessionCount).toBe(3);
    // Sessions must be oldest → newest.
    expect(result.sessions[0].sessionId).toBe('s1');
    expect(result.sessions[2].sessionId).toBe('s3');

    expect(result.trend).not.toBeNull();
    const trend = result.trend!;
    expect(trend.topWeightLbsFirst).toBe(80);
    expect(trend.topWeightLbsLast).toBe(100);
    expect(trend.topWeightLbsDelta).toBe(20);
    expect(trend.topWeightLbsDeltaPct).toBeCloseTo(25, 5);
    expect(trend.estimatedTotalVolumeFirst).toBe(400);
    expect(trend.estimatedTotalVolumeLast).toBe(500);
    expect(trend.estimatedTotalVolumeDeltaPct).toBeCloseTo(25, 5);
  });
});

// ── Multi-session: negative trend ────────────────────────────────────────────

describe('aggregateProgression — multi-session negative trend', () => {
  it('reports negative delta when weight decreases', () => {
    const s1 = makeSession('s1', '2025-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', '2025-01-08T00:00:00.000Z');

    const setsBySession = new Map([
      ['s1', [makeSet('a1', 's1', 100, 5)]],
      ['s2', [makeSet('a2', 's2', 80, 5)]],
    ]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [s1, s2], setsBySession);

    const trend = result.trend!;
    expect(trend.topWeightLbsDelta).toBe(-20);
    expect(trend.topWeightLbsDeltaPct).toBeCloseTo(-20, 5);
  });
});

// ── Multi-session: zero delta ─────────────────────────────────────────────────

describe('aggregateProgression — zero delta', () => {
  it('reports 0 delta pct when weight is the same', () => {
    const s1 = makeSession('s1', '2025-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', '2025-01-08T00:00:00.000Z');

    const setsBySession = new Map([
      ['s1', [makeSet('a1', 's1', 100, 5)]],
      ['s2', [makeSet('a2', 's2', 100, 5)]],
    ]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [s1, s2], setsBySession);

    const trend = result.trend!;
    expect(trend.topWeightLbsDelta).toBe(0);
    expect(trend.topWeightLbsDeltaPct).toBe(0);
    expect(trend.estimatedTotalVolumeDeltaPct).toBe(0);
  });

  it('returns deltaPct of 0 (not NaN/Infinity) when first session has 0 volume', () => {
    const s1 = makeSession('s1', '2025-01-01T00:00:00.000Z');
    const s2 = makeSession('s2', '2025-01-08T00:00:00.000Z');

    const setsBySession = new Map([
      ['s1', []], // no sets → volume = 0
      ['s2', [makeSet('a2', 's2', 100, 5)]],
    ]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [s1, s2], setsBySession);

    const trend = result.trend!;
    expect(trend.topWeightLbsDeltaPct).toBe(0);
    expect(trend.estimatedTotalVolumeDeltaPct).toBe(0);
  });
});

// ── topWeightLbs takes max across multiple sets ───────────────────────────────

describe('aggregateProgression — topWeightLbs', () => {
  it('picks the highest weight across all sets in the session', () => {
    const session = makeSession('s1', '2025-01-10T00:00:00.000Z');
    const sets = [
      makeSet('a1', 's1', 80, 3),
      makeSet('a2', 's1', 120, 5),
      makeSet('a3', 's1', 110, 5),
    ];
    const setsBySession = new Map([['s1', sets]]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [session], setsBySession);

    expect(result.sessions[0].topWeightLbs).toBe(120);
    // vol = 80*3 + 120*5 + 110*5 = 240 + 600 + 550 = 1390
    expect(result.sessions[0].estimatedTotalVolumeLbs).toBe(1390);
  });
});

// ── estimatedTotalVolumeLbs: manual cross-check ───────────────────────────────

describe('aggregateProgression — estimatedTotalVolumeLbs', () => {
  it('sums weight * reps across all sets correctly', () => {
    const session = makeSession('s1', '2025-01-10T00:00:00.000Z');
    const sets = [
      makeSet('a1', 's1', 50, 10), //  500
      makeSet('a2', 's1', 60, 8), //  480
      makeSet('a3', 's1', 65, 6, true), // 390 (partial)
    ];
    const setsBySession = new Map([['s1', sets]]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [session], setsBySession);

    expect(result.sessions[0].estimatedTotalVolumeLbs).toBe(1370);
  });
});

// ── Session with no sets ──────────────────────────────────────────────────────

describe('aggregateProgression — session with no sets', () => {
  it('returns zeros for a session that was ended before any set was started', () => {
    const session = makeSession('s1', '2025-01-10T00:00:00.000Z');
    const setsBySession = new Map<string, StoredSet[]>([['s1', []]]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, [session], setsBySession);

    const summary = result.sessions[0];
    expect(summary.setCount).toBe(0);
    expect(summary.topWeightLbs).toBe(0);
    expect(summary.totalReps).toBe(0);
    expect(summary.completedReps).toBe(0);
    expect(summary.estimatedTotalVolumeLbs).toBe(0);
  });
});

// ── Sorting guarantee ─────────────────────────────────────────────────────────

describe('aggregateProgression — sort order', () => {
  it('sorts output oldest → newest regardless of input order', () => {
    const sessions = [
      makeSession('s3', '2025-01-15T00:00:00.000Z'),
      makeSession('s1', '2025-01-01T00:00:00.000Z'),
      makeSession('s2', '2025-01-08T00:00:00.000Z'),
    ];
    const setsBySession = new Map<string, StoredSet[]>([
      ['s1', []],
      ['s2', []],
      ['s3', []],
    ]);

    const result = aggregateProgression(EX_ID, WINDOW_START, NOW, sessions, setsBySession);

    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
  });
});
