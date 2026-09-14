// The chapter half of the comparability subject writers (VW-380, follow-up to
// VW-361).
//
// Until this change `ComparabilitySubject.chapterStartedAt` had no writer, so
// the swap clause in `comparability.ts` never saw a declared chapter boundary
// and a pair straddling one compared like any other. These tests pin that it
// is now wired: `buildComparabilitySubjectGroups` reads the boundary from the
// injected `getChapterStartedAt` fetcher and writes it onto every set, and the
// swap clause then refuses a straddling pair while leaving a pair on one side
// of the boundary — or an exercise with no declared chapter — unchanged.

import { describe, expect, it, vi } from 'vitest';

import {
  buildComparabilitySubjectGroups,
  type ComparabilitySubjectFetchers,
} from '../comparability-subject.js';
import { isComparable } from '../comparability.js';
import type { StoredSet } from '../../store/types.js';

const CHAPTER_STARTED_AT = '2026-08-01T00:00:00.000Z';
const PRE_CHAPTER = '2026-07-01T00:00:00.000Z';
const POST_CHAPTER = '2026-09-01T00:00:00.000Z';

function makeSet(id: string, startedAt: string): StoredSet {
  return {
    id,
    sessionId: 'sess-1',
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId: 'bench-press',
    trainingMode: 'WeightTraining',
    settingsHash: 'v1:aaaa',
    side: 'right',
    weightLbs: 170,
  };
}

function makeFetchers(chapterStartedAt: string | null): ComparabilitySubjectFetchers {
  return {
    getSetsForExercise: vi.fn(async () => []),
    getFirstSessionStartedAt: vi.fn(async () => null),
    getLifterSessionExerciseIds: vi.fn(async () => []),
    primaryMuscleOf: vi.fn(() => undefined),
    getSessionDietPhase: vi.fn(async () => undefined),
    getChapterStartedAt: vi.fn(async () => chapterStartedAt),
  };
}

describe('buildComparabilitySubjectGroups — chapter (VW-380)', () => {
  it('writes the declared chapter boundary onto every set for that exercise', async () => {
    const [group] = await buildComparabilitySubjectGroups(
      [[makeSet('a', PRE_CHAPTER), makeSet('b', POST_CHAPTER)]],
      makeFetchers(CHAPTER_STARTED_AT),
    );

    expect(group?.map((s) => s.chapterStartedAt)).toEqual([CHAPTER_STARTED_AT, CHAPTER_STARTED_AT]);
  });

  it('leaves chapterStartedAt absent when no chapter is declared', async () => {
    const [group] = await buildComparabilitySubjectGroups(
      [[makeSet('a', POST_CHAPTER)]],
      makeFetchers(null),
    );

    expect(group?.[0]?.chapterStartedAt).toBeUndefined();
  });

  it('resolves the boundary once per exercise across every group', async () => {
    const fetchers = makeFetchers(CHAPTER_STARTED_AT);
    await buildComparabilitySubjectGroups(
      [[makeSet('a', POST_CHAPTER), makeSet('b', POST_CHAPTER)], [makeSet('c', POST_CHAPTER)]],
      fetchers,
    );

    expect(fetchers.getChapterStartedAt).toHaveBeenCalledTimes(1);
  });

  it('makes the swap clause refuse a pair straddling the declared chapter', async () => {
    const [[preSet], [postSet]] = await buildComparabilitySubjectGroups(
      [[makeSet('a', PRE_CHAPTER)], [makeSet('b', POST_CHAPTER)]],
      makeFetchers(CHAPTER_STARTED_AT),
    );

    const verdict = isComparable(preSet!, postSet!);

    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('swap:');
  });

  it('leaves a pair entirely after the chapter comparable', async () => {
    const [[a], [b]] = await buildComparabilitySubjectGroups(
      [[makeSet('a', POST_CHAPTER)], [makeSet('b', POST_CHAPTER)]],
      makeFetchers(CHAPTER_STARTED_AT),
    );

    const verdict = isComparable(a!, b!);

    expect(verdict.comparable).toBe(true);
  });

  it('leaves an undeclared exercise comparable exactly as before VW-380', async () => {
    const [[a], [b]] = await buildComparabilitySubjectGroups(
      [[makeSet('a', PRE_CHAPTER)], [makeSet('b', POST_CHAPTER)]],
      makeFetchers(null),
    );

    const verdict = isComparable(a!, b!);

    expect(verdict.comparable).toBe(true);
  });
});
