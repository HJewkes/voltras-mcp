// Unit tests for the `StoredSet`/`StoredSession` -> WA `ProcessedSession`
// mapper (VW-144/145). This is the one piece of new logic the history.trend /
// history.weekly_volume pipelines add — everything downstream is
// `@voltras/workout-analytics`, unit-tested there already.

import { describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';
import {
  groupBySessionId,
  toProcessedSession,
  toProcessedSessions,
} from '../processed-session-mapper.js';
import type { StoredRep, StoredSet } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 1,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0.5,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE },
    eccentric: { ...EMPTY_PHASE },
  };
}

function makeSet(overrides: Partial<StoredSet> & { id: string }): StoredSet {
  const repCount = overrides.reps?.length ?? 2;
  return {
    sessionId: 'sess-1',
    startedAt: '2026-09-08T00:00:00.000Z',
    endedAt: '2026-09-08T00:00:30.000Z',
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: repCount }, (_, i) => makeRep(overrides.id, i)),
    ...overrides,
  };
}

describe('toProcessedSession', () => {
  it('excludes warm-ups by setPurpose, keeping working sets', () => {
    const sets = [
      makeSet({ id: 'warm-1', setPurpose: 'warmup', weightLbs: 45 }),
      makeSet({ id: 'work-1', setPurpose: 'working', weightLbs: 135 }),
    ];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets).toEqual([
      { weightLbs: 135, repCount: 2, estimated1rm: expect.any(Number) },
    ]);
  });

  it('excludes probe and technique rungs the same as warm-ups', () => {
    const sets = [
      makeSet({ id: 'probe-1', setPurpose: 'probe', weightLbs: 200 }),
      makeSet({ id: 'tech-1', setPurpose: 'technique', weightLbs: 50 }),
      makeSet({ id: 'work-1', setPurpose: 'working', weightLbs: 135 }),
    ];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets).toHaveLength(1);
    expect(result?.sets[0]?.weightLbs).toBe(135);
  });

  it('excludes a guest lifter set, keeping the owner set', () => {
    const sets = [
      makeSet({ id: 'guest-1', lifter: 'Jordan', weightLbs: 90 }),
      makeSet({ id: 'owner-1', weightLbs: 135 }),
    ];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets).toHaveLength(1);
    expect(result?.sets[0]?.weightLbs).toBe(135);
  });

  it('excludes a set with no finite weightLbs (Band/Damper/Iso) without coercing to 0', () => {
    const sets = [
      makeSet({ id: 'iso-1', weightLbs: undefined }),
      makeSet({ id: 'owner-1', weightLbs: 135 }),
    ];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets).toHaveLength(1);
    expect(result?.sets[0]?.weightLbs).toBe(135);
  });

  it('maps bilateral L/R rows one-for-one, uncollapsed, same as session.volume tonnage', () => {
    const sets = [
      makeSet({ id: 'l-1', side: 'left', weightLbs: 50, bilateralGroupId: 'grp-1' }),
      makeSet({ id: 'r-1', side: 'right', weightLbs: 55, bilateralGroupId: 'grp-1' }),
    ];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets).toHaveLength(2);
    expect(result?.sets.map((s) => s.weightLbs).sort()).toEqual([50, 55]);
  });

  it('carries repCount from firmwareRepCount over the derived reps array', () => {
    const sets = [makeSet({ id: 'work-1', weightLbs: 135, firmwareRepCount: 11 })];

    const result = toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets);

    expect(result?.sets[0]?.repCount).toBe(11);
  });

  it('returns undefined when nothing survives filtering', () => {
    const sets = [makeSet({ id: 'warm-1', setPurpose: 'warmup' })];

    expect(
      toProcessedSession({ id: 'sess-1', startedAt: sets[0]!.startedAt }, sets),
    ).toBeUndefined();
  });

  it('echoes session id/startedAt/exerciseId onto the result', () => {
    const sets = [makeSet({ id: 'work-1', weightLbs: 135, exerciseId: 'back-squat' })];

    const result = toProcessedSession(
      { id: 'sess-42', startedAt: '2026-08-01T12:00:00.000Z', exerciseId: 'back-squat' },
      sets,
    );

    expect(result).toMatchObject({
      id: 'sess-42',
      startedAt: '2026-08-01T12:00:00.000Z',
      exerciseId: 'back-squat',
    });
  });
});

describe('toProcessedSessions', () => {
  it('drops sessions that map to nothing and keeps the rest, in order', () => {
    const sources = [
      { id: 'sess-1', startedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'sess-2', startedAt: '2026-08-08T00:00:00.000Z' },
    ];
    const setsBySession = new Map([
      ['sess-1', [makeSet({ id: 'warm-1', setPurpose: 'warmup' })]],
      ['sess-2', [makeSet({ id: 'work-1', weightLbs: 135 })]],
    ]);

    const result = toProcessedSessions(sources, setsBySession);

    expect(result.map((s) => s.id)).toEqual(['sess-2']);
  });

  it('treats a session with no entry in the map as having no sets', () => {
    const sources = [{ id: 'sess-1', startedAt: '2026-08-01T00:00:00.000Z' }];

    expect(toProcessedSessions(sources, new Map())).toEqual([]);
  });
});

describe('groupBySessionId', () => {
  it('groups a flat set list by sessionId, preserving order within a group', () => {
    const sets = [
      makeSet({ id: 'a', sessionId: 'sess-1' }),
      makeSet({ id: 'b', sessionId: 'sess-2' }),
      makeSet({ id: 'c', sessionId: 'sess-1' }),
    ];

    const groups = groupBySessionId(sets);

    expect([...groups.keys()]).toEqual(['sess-1', 'sess-2']);
    expect(groups.get('sess-1')?.map((s) => s.id)).toEqual(['a', 'c']);
    expect(groups.get('sess-2')?.map((s) => s.id)).toEqual(['b']);
  });
});
