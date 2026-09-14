// `exercise_chapters` store semantics and the clamp every reader shares
// (VW-361). A chapter is a DECLARED boundary after which the pre-boundary
// loads stop being the number to beat (rp:rp-s3-old-prs-irrelevant-reframe).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampToChapter } from '../exercise-chapters.js';
import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID } from '../types.js';

describe('clampToChapter', () => {
  it('passes the window through when no chapter is declared', () => {
    expect(clampToChapter('2026-06-01T00:00:00.000Z', null)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('moves the window start forward to a chapter inside it', () => {
    expect(clampToChapter('2026-06-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('never widens a window to reach a chapter older than it', () => {
    expect(clampToChapter('2026-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});

describe('SqliteSessionStore exercise chapters', () => {
  let dir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vmcp-chapters-'));
    store = SqliteSessionStore.open(join(dir, 'store.sqlite'));
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function mark(exerciseId: string, startedAt: string, reason?: string): Promise<string> {
    const row = await store.markExerciseChapter({
      userId: LOCAL_USER_ID,
      exerciseId,
      startedAt,
      declaredAt: '2026-09-14T00:00:00.000Z',
      ...(reason !== undefined ? { reason } : {}),
    });
    return row.id;
  }

  it('reports no chapter for an exercise nobody declared one for', async () => {
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBeNull();
  });

  it('reads back the declaration with its reason', async () => {
    const id = await mark('back-squat', '2026-08-01T00:00:00.000Z', 'reformed depth');
    expect(await store.listExerciseChapters(LOCAL_USER_ID, 'back-squat')).toEqual([
      {
        id,
        userId: LOCAL_USER_ID,
        exerciseId: 'back-squat',
        startedAt: '2026-08-01T00:00:00.000Z',
        declaredAt: '2026-09-14T00:00:00.000Z',
        reason: 'reformed depth',
      },
    ]);
  });

  it('is scoped per exercise', async () => {
    await mark('back-squat', '2026-08-01T00:00:00.000Z');
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'bench-press')).toBeNull();
  });

  it('takes the latest declaration when a movement is reformed twice', async () => {
    await mark('back-squat', '2026-05-01T00:00:00.000Z');
    await mark('back-squat', '2026-08-01T00:00:00.000Z');
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('retiring the latest falls back to the earlier live one, not to null', async () => {
    await mark('back-squat', '2026-05-01T00:00:00.000Z');
    const second = await mark('back-squat', '2026-08-01T00:00:00.000Z');
    await store.retireExerciseChapter(second, '2026-09-14T12:00:00.000Z');
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('keeps the retired row rather than deleting the declaration', async () => {
    const id = await mark('back-squat', '2026-08-01T00:00:00.000Z');
    const retired = await store.retireExerciseChapter(id, '2026-09-14T12:00:00.000Z');
    expect(retired?.retiredAt).toBe('2026-09-14T12:00:00.000Z');
    expect(await store.listExerciseChapters(LOCAL_USER_ID)).toHaveLength(1);
    expect(await store.chapterStartedAt(LOCAL_USER_ID, 'back-squat')).toBeNull();
  });

  it('reports an unknown id as undefined rather than inventing a row', async () => {
    expect(await store.retireExerciseChapter('nope', '2026-09-14T12:00:00.000Z')).toBeUndefined();
  });
});
