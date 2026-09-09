// The diet-phase half of the comparability subject writers (VW-150).
//
// Until this change `ComparabilitySubject.phase` had no writer, so the phase
// clause in `comparability.ts` was unchecked on EVERY pair. These tests pin
// that it is now live: a pair from two different declared phases is refused
// with a reason naming the phases, while a pair from before any declaration
// still passes with a note, which is what keeps old history comparable.

import { describe, expect, it, vi } from 'vitest';

import {
  buildComparabilitySubjectGroups,
  type ComparabilitySubjectFetchers,
} from '../comparability-subject.js';
import { isComparable } from '../comparability.js';
import type { StoredSet } from '../../store/types.js';

function makeSet(id: string, sessionId: string): StoredSet {
  return {
    id,
    sessionId,
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:01:00.000Z',
    partial: false,
    reps: [],
    exerciseId: 'bench-press',
    trainingMode: 'WeightTraining',
    settingsHash: 'v1:aaaa',
    side: 'right',
    weightLbs: 170,
  };
}

function makeFetchers(phaseBySession: Record<string, string>): ComparabilitySubjectFetchers {
  return {
    getSetsForExercise: vi.fn(async () => []),
    getFirstSessionStartedAt: vi.fn(async () => null),
    getLifterSessionExerciseIds: vi.fn(async () => []),
    primaryMuscleOf: vi.fn(() => undefined),
    getSessionDietPhase: vi.fn(async (sessionId: string) => phaseBySession[sessionId]),
  };
}

describe('buildComparabilitySubjectGroups — phase (VW-150)', () => {
  it('writes the session phase onto every set in the group', async () => {
    const [group] = await buildComparabilitySubjectGroups(
      [[makeSet('a', 'sess-1'), makeSet('b', 'sess-1')]],
      makeFetchers({ 'sess-1': 'fat-loss' }),
    );

    expect(group?.map((s) => s.phase)).toEqual(['fat-loss', 'fat-loss']);
  });

  it('leaves phase absent when no phase covers the session', async () => {
    const [group] = await buildComparabilitySubjectGroups(
      [[makeSet('a', 'sess-1')]],
      makeFetchers({}),
    );

    expect(group?.[0]?.phase).toBeUndefined();
  });

  it('resolves each session once across every group', async () => {
    const fetchers = makeFetchers({ 'sess-1': 'gain' });
    await buildComparabilitySubjectGroups(
      [[makeSet('a', 'sess-1'), makeSet('b', 'sess-1')], [makeSet('c', 'sess-1')]],
      fetchers,
    );

    expect(fetchers.getSessionDietPhase).toHaveBeenCalledTimes(1);
  });

  it('makes the phase clause refuse a pair straddling two declared phases', async () => {
    const [[cutSet], [bulkSet]] = await buildComparabilitySubjectGroups(
      [[makeSet('a', 'sess-cut')], [makeSet('b', 'sess-bulk')]],
      makeFetchers({ 'sess-cut': 'fat-loss', 'sess-bulk': 'gain' }),
    );

    const verdict = isComparable(cutSet!, bulkSet!);

    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('training phase');
  });

  it('still compares two sessions from before any declaration', async () => {
    const [[a], [b]] = await buildComparabilitySubjectGroups(
      [[makeSet('a', 'sess-1')], [makeSet('b', 'sess-2')]],
      makeFetchers({}),
    );

    const verdict = isComparable(a!, b!);

    // Absent on BOTH sides passes with a note — the degrade-never-refuse rule
    // that keeps every session recorded before VW-150 usable.
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('training phase');
  });
});
