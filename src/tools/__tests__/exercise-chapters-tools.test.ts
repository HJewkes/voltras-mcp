// VW-361 end to end: a declared chapter clamps every read that could hand a
// pre-reform number back as the one to beat.
//
// A real `SqliteSessionStore` on `:memory:` rather than a faked store, for the
// same reason `goal-tools.test.ts` uses one: the clamp lives between the tool
// and the real `getSetsForExercise` window, and a fake that answers a `from`
// filter is a second implementation of the thing under test.
//
// THE MUTATION CHECK. `reports the pre-chapter best as a PR once the clamp is
// gone` is the guard on the guard: it pins the behaviour that exists WITHOUT
// the clamp, so deleting the clamp in `priorBestE1RM` cannot leave the suite
// green. Run both together: with the clamp removed by hand, the clamped case
// fails; with it restored, both pass.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { toExerciseIsPR } from '../../dashboard/spa/panels/exercise-hero-view.js';
import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import { registerExerciseTools } from '../exercise-tools.js';
import { registerMetricsTools } from '../metrics-tools.js';
import { registerProgressionTools } from '../progression-tools.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const EXERCISE_ID = 'back-squat';
const CATALOG = [{ id: EXERCISE_ID, muscleGroups: ['quads'], name: 'Back Squat' }];
const TOOL_NAMES = [
  'metrics.compute',
  'progression.get_for_exercise',
  'exercise.search',
  'exercise.get',
  'exercise.confirm_setup',
  'exercise.mark_new_chapter',
  'exercise.retire_chapter',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(updates: { callback: FakeRegisteredTool['callback'] }): void;
}

interface Harness {
  store: SessionStore;
  invoke: (name: string, args?: unknown) => Promise<Record<string, unknown>>;
  expectError: (name: string, args?: unknown) => Promise<{ code: string; message: string }>;
}

function makeReps(setId: string, count: number): StoredRep[] {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 1000,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return Array.from({ length: count }, (_, index) => ({
    repNumber: index + 1,
    concentric: phase,
    eccentric: phase,
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  }));
}

/** One session of two working sets at `weightLbs`, `daysBack` days ago. */
async function seedSession(
  store: SessionStore,
  id: string,
  daysBack: number,
  weightLbs: number,
): Promise<void> {
  const at = daysAgo(daysBack);
  await store.putSession({
    kind: 'training',
    id,
    startedAt: at,
    endedAt: at,
    exerciseId: EXERCISE_ID,
  });
  for (const suffix of ['a', 'b']) {
    const setId = `${id}-${suffix}`;
    const set: StoredSet = {
      id: setId,
      sessionId: id,
      userId: LOCAL_USER_ID,
      exerciseId: EXERCISE_ID,
      startedAt: at,
      endedAt: at,
      partial: false,
      weightLbs,
      setPurpose: 'working',
      reps: makeReps(setId, 5),
    };
    await store.putSet(set);
  }
}

function setup(): Harness {
  const store = openTestStore();
  const state = {
    store,
    exercises: {
      list: () => CATALOG,
      getById: (id: string) => CATALOG.find((e) => e.id === id),
      search: () => CATALOG,
    },
  } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  const server = undefined as unknown as McpServer;
  const asMap = placeholders as unknown as Map<string, RegisteredTool>;
  registerMetricsTools(server, state, asMap);
  registerProgressionTools(server, state, asMap as never);
  registerExerciseTools(server, state, asMap);
  const call = async (name: string, args: unknown = {}) => {
    const callback = placeholders.get(name)?.callback;
    if (callback === undefined) throw new Error(`no callback installed for ${name}`);
    return callback(args);
  };
  return {
    store,
    invoke: async (name, args) => {
      const result = await call(name, args);
      if (result.isError === true) throw new Error(`unexpected error: ${result.content[0]!.text}`);
      return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    },
    expectError: async (name, args) => {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      return JSON.parse(result.content[0]!.text) as { code: string; message: string };
    },
  };
}

async function priorBestFor(harness: Harness, load: number): Promise<number | null> {
  const body = await harness.invoke('metrics.compute', {
    pipeline: 'strength.e1rm',
    exerciseId: EXERCISE_ID,
    load,
    reps: 5,
  });
  return body.priorBest as number | null;
}

let harness: Harness;

beforeEach(() => {
  harness = setup();
});

describe('exercise.mark_new_chapter / exercise.retire_chapter', () => {
  it('declares a chapter at now by default and reads it back', async () => {
    const chapter = await harness.invoke('exercise.mark_new_chapter', {
      exerciseId: EXERCISE_ID,
      reason: 'reformed depth',
    });
    expect(chapter).toMatchObject({ exerciseId: EXERCISE_ID, reason: 'reformed depth' });
    expect(await harness.store.chapterStartedAt(LOCAL_USER_ID, EXERCISE_ID)).toBe(
      chapter.startedAt,
    );
  });

  it('backdates to a given startedAt', async () => {
    const startedAt = daysAgo(30);
    await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID, startedAt });
    expect(await harness.store.chapterStartedAt(LOCAL_USER_ID, EXERCISE_ID)).toBe(startedAt);
  });

  it('retires a chapter and restores the full history', async () => {
    const chapter = await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID });
    const retired = await harness.invoke('exercise.retire_chapter', {
      chapterId: chapter.id as string,
    });
    expect(retired.retiredAt).toEqual(expect.any(String));
    expect(await harness.store.chapterStartedAt(LOCAL_USER_ID, EXERCISE_ID)).toBeNull();
  });

  it('reports an unknown chapter id as NOT_FOUND', async () => {
    expect((await harness.expectError('exercise.retire_chapter', { chapterId: 'nope' })).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('e1RM PR across a chapter boundary (VW-361)', () => {
  // 315 lb pre-reform is higher than every post-reform load, so it wins
  // unconditionally until the boundary is declared.
  beforeEach(async () => {
    await seedSession(harness.store, 'pre-reform', 60, 315);
  });

  it('reports the pre-chapter best as a PR once the clamp is gone', async () => {
    // THE MUTATION CHECK's other half: with no chapter declared, the window is
    // unclamped and the 315 lb session is exactly the number to beat. Delete
    // the clamp in `priorBestE1RM` and the clamped cases below collapse into
    // this one.
    expect(await priorBestFor(harness, 225)).toBeGreaterThan(300);
  });

  it('hides the pre-chapter best from the first post-chapter session', async () => {
    await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID });
    const body = await harness.invoke('metrics.compute', {
      pipeline: 'strength.e1rm',
      exerciseId: EXERCISE_ID,
      load: 225,
      reps: 5,
    });
    expect(body.priorBest).toBeNull();
    expect(body.isPR).toBe(false);
  });

  it('compares the second post-chapter session against the first, not the old best', async () => {
    await harness.invoke('exercise.mark_new_chapter', {
      exerciseId: EXERCISE_ID,
      startedAt: daysAgo(20),
    });
    await seedSession(harness.store, 'post-reform', 10, 225);
    const priorBest = await priorBestFor(harness, 235);
    expect(priorBest).not.toBeNull();
    expect(priorBest).toBeGreaterThan(225);
    expect(priorBest).toBeLessThan(300);
  });

  it('restores the pre-chapter best when the chapter is retired', async () => {
    const chapter = await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID });
    expect(await priorBestFor(harness, 225)).toBeNull();
    await harness.invoke('exercise.retire_chapter', { chapterId: chapter.id as string });
    expect(await priorBestFor(harness, 225)).toBeGreaterThan(300);
  });

  it('hands the SPA hero card the clamped value, so a live set is a PR again', async () => {
    await harness.invoke('exercise.mark_new_chapter', {
      exerciseId: EXERCISE_ID,
      startedAt: daysAgo(20),
    });
    await seedSession(harness.store, 'post-reform', 10, 225);
    const historyBest = await priorBestFor(harness, 235);
    const liveViews = [{ weightLbs: 245, reps: makeReps('live', 5) }];
    // Unclamped, 315 lb would still be the bar and this set would not be a PR.
    expect(toExerciseIsPR(liveViews as never, historyBest)).toBe(true);
  });
});

describe('history.trend across a chapter boundary (VW-361)', () => {
  it('returns null chapterStartedAt and a fit when no chapter is declared', async () => {
    await seedSession(harness.store, 'a', 30, 300);
    await seedSession(harness.store, 'b', 10, 310);
    const body = await harness.invoke('metrics.compute', {
      pipeline: 'history.trend',
      exerciseId: EXERCISE_ID,
    });
    expect(body.chapterStartedAt).toBeNull();
    expect(body.newChapter).toBeNull();
    expect(body.trend).not.toBeNull();
  });

  it('clamps the series to the chapter and reports where it restarts', async () => {
    await seedSession(harness.store, 'pre-reform', 60, 315);
    await seedSession(harness.store, 'post-a', 20, 225);
    await seedSession(harness.store, 'post-b', 10, 235);
    const startedAt = daysAgo(30);
    await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID, startedAt });
    const body = await harness.invoke('metrics.compute', {
      pipeline: 'history.trend',
      exerciseId: EXERCISE_ID,
    });
    expect(body.chapterStartedAt).toBe(startedAt);
    const series = body.series as { value: number }[];
    expect(series).toHaveLength(2);
    // The 315 lb week is gone from the top-load series, so no chart or PR
    // badge downstream can read it as the number to beat.
    expect(Math.max(...series.map((p) => p.value))).toBe(235);
    expect(body.newChapter).toMatchObject({ startedAt, sessionsSince: 2 });
  });

  it('returns a new-chapter state, never NOT_FOUND, for an empty post-chapter window', async () => {
    await seedSession(harness.store, 'pre-reform', 60, 315);
    const startedAt = daysAgo(2);
    await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID, startedAt });
    const body = await harness.invoke('metrics.compute', {
      pipeline: 'history.trend',
      exerciseId: EXERCISE_ID,
    });
    expect(body.trend).toBeNull();
    expect(body.plateau).toBeNull();
    expect(body.series).toEqual([]);
    expect(body.newChapter).toMatchObject({ startedAt, sessionsSince: 0 });
    expect((body.newChapter as { rpIds: string[] }).rpIds).toContain(
      'rp-s3-old-prs-irrelevant-reframe',
    );
  });

  it('still reports NOT_FOUND for an exercise with no sets and no chapter', async () => {
    const error = await harness.expectError('metrics.compute', {
      pipeline: 'history.trend',
      exerciseId: EXERCISE_ID,
    });
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('progression.get_for_exercise across a chapter boundary (VW-361)', () => {
  it('clamps windowStartedAt and drops the pre-chapter sessions', async () => {
    await seedSession(harness.store, 'pre-reform', 40, 315);
    await seedSession(harness.store, 'post-reform', 5, 225);
    const startedAt = daysAgo(20);
    await harness.invoke('exercise.mark_new_chapter', { exerciseId: EXERCISE_ID, startedAt });
    const body = await harness.invoke('progression.get_for_exercise', {
      exerciseId: EXERCISE_ID,
    });
    expect(body.chapterStartedAt).toBe(startedAt);
    expect(body.windowStartedAt).toBe(startedAt);
    expect(body.sessionCount).toBe(1);
  });

  it('reports zero sessions rather than an error for an empty post-chapter window', async () => {
    await seedSession(harness.store, 'pre-reform', 40, 315);
    await harness.invoke('exercise.mark_new_chapter', {
      exerciseId: EXERCISE_ID,
      startedAt: daysAgo(2),
    });
    const body = await harness.invoke('progression.get_for_exercise', {
      exerciseId: EXERCISE_ID,
    });
    expect(body.sessionCount).toBe(0);
    expect(body.chapterStartedAt).not.toBeNull();
  });

  it('leaves the window alone when no chapter is declared', async () => {
    await seedSession(harness.store, 'pre-reform', 40, 315);
    const body = await harness.invoke('progression.get_for_exercise', {
      exerciseId: EXERCISE_ID,
    });
    expect(body.chapterStartedAt).toBeNull();
    expect(body.sessionCount).toBe(1);
  });
});
