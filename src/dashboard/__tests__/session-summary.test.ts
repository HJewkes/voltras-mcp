// Unit tests for the session-completion read-model (VW-120).
//
// The two properties that matter:
//
//   1. MULTI-EXERCISE. VW-114 shipped `session.set_exercise`, so a session can
//      hold several exercises. The screen must group by each set's own
//      `exerciseId` — a regression here silently attributes a bench set's
//      progression to the squat.
//   2. ONE heuristic. The recommendation must be whatever
//      `computeProgressionDelta` says (the same function `plan.suggest_progression`
//      runs), scored against THIS exercise's sets only.

import { describe, expect, it } from 'vitest';
import {
  addSampleToSet,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

import { buildSessionSummary, resolveSummarySessionId } from '../session-summary.js';
import type { DashboardPlanStore } from '../plan-api.js';
import type { DashboardSessionStore } from '../session-summary.js';
import type {
  StoredPlannedExercise,
  StoredSession,
  StoredSet,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

const PROGRAM: StoredTrainingProgram = {
  id: 'prog-1',
  name: 'Base Build',
  createdAt: '2026-07-01T00:00:00.000Z',
};
const BLOCK: StoredTrainingBlock = {
  id: 'blk-1',
  programId: 'prog-1',
  orderIndex: 0,
  name: 'B1',
  weeksCount: 1,
};
const WEEK: StoredTrainingWeek = { id: 'wk-1', blockId: 'blk-1', orderIndex: 0 };
const TEMPLATE: StoredWorkoutTemplate = {
  id: 'tpl-1',
  weekId: 'wk-1',
  name: 'Upper A',
  orderIndex: 0,
};

function planned(
  exerciseId: string,
  overrides: Partial<StoredPlannedExercise> = {},
): StoredPlannedExercise {
  return {
    id: `pe-${exerciseId}`,
    workoutTemplateId: 'tpl-1',
    exerciseId,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 10,
    targetWeightLbs: 100,
    ...overrides,
  };
}

const SESSION: StoredSession = {
  id: 'sess-1',
  startedAt: '2026-07-30T10:00:00.000Z',
  endedAt: '2026-07-30T11:00:00.000Z',
  status: 'ended',
} as StoredSession;

/**
 * Four samples spanning one rep's concentric + eccentric, the same shape
 * `spa-fatigue-view.test.ts` uses. Real samples matter here: the analytics
 * fatigue/verdict calls walk BOTH phases, so a rep stubbed with only a peak
 * velocity throws rather than degrading — and a stored rep always has both.
 */
function repSamples(concVel: number, seq: number, t0: number): WorkoutSample[] {
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + 500,
      phase: MovementPhase.CONCENTRIC,
      position: 0.5,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + 600,
      phase: MovementPhase.ECCENTRIC,
      position: 0.5,
      velocity: concVel * 0.5,
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + 1600,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: concVel * 0.5,
      force: 80,
    },
  ];
}

/** `repCount` real WA reps at a steady velocity. */
function buildReps(repCount: number): Rep[] {
  let set = createSet();
  let t = 1000;
  for (let i = 0; i < repCount; i += 1) {
    for (const sample of repSamples(0.8, i * 4, t)) set = addSampleToSet(set, sample);
    t += 3000;
  }
  return [...set.reps];
}

/** A stored set carrying `repCount` real reps. */
function makeSet(
  id: string,
  exerciseId: string | undefined,
  repCount: number,
  overrides: Partial<StoredSet> = {},
): StoredSet {
  return {
    id,
    sessionId: 'sess-1',
    startedAt: '2026-07-30T10:00:00.000Z',
    endedAt: '2026-07-30T10:02:00.000Z',
    partial: false,
    weightLbs: 100,
    ...(exerciseId === undefined ? {} : { exerciseId }),
    reps: buildReps(repCount) as StoredSet['reps'],
    ...overrides,
  } as StoredSet;
}

function makeStore(
  sets: StoredSet[],
  plannedRows: StoredPlannedExercise[],
  opts: { programs?: StoredTrainingProgram[] } = {},
): DashboardSessionStore & DashboardPlanStore {
  const noop = async (): Promise<void> => undefined;
  return {
    getSession: async (id) => (id === SESSION.id ? SESSION : undefined),
    getSetsForSession: async () => sets,
    listSessions: async () => [SESSION],
    listTrainingPrograms: async () => opts.programs ?? [PROGRAM],
    getTrainingProgram: async () => PROGRAM,
    getTrainingBlocksForProgram: async () => [BLOCK],
    getTrainingWeeksForBlock: async () => [WEEK],
    getWorkoutTemplatesForWeek: async () => [TEMPLATE],
    getWorkoutTemplate: async () => TEMPLATE,
    getPlannedExercisesForTemplate: async () => plannedRows,
    getPlannedExercise: async (id) => plannedRows.find((p) => p.id === id),
    getAssignmentsForTemplate: async () => [],
    getAssignmentsForSession: async () => [],
    putTrainingProgram: noop,
    putTrainingBlock: noop,
    putTrainingWeek: noop,
    putWorkoutTemplate: noop,
    putPlannedExercise: noop,
  };
}

const nameOf = (id: string): string | undefined =>
  ({ 'cable-row': 'Cable Row', 'cable-chest-press': 'Cable Chest Press' })[id];

describe('buildSessionSummary', () => {
  it('returns undefined for a session that does not exist', async () => {
    const store = makeStore([], []);
    await expect(buildSessionSummary({ store, nameOf }, 'nope')).resolves.toBeUndefined();
  });

  it('groups a multi-exercise session into one card per exercise, in first-set order', async () => {
    const store = makeStore(
      [
        makeSet('s1', 'cable-row', 10),
        makeSet('s2', 'cable-chest-press', 10),
        makeSet('s3', 'cable-row', 10),
      ],
      [planned('cable-row'), planned('cable-chest-press')],
    );
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises.map((e) => e.name)).toEqual(['Cable Row', 'Cable Chest Press']);
    expect(summary?.exercises[0]?.setCount).toBe(2);
    expect(summary?.exercises[1]?.setCount).toBe(1);
  });

  it('scores progression against only that exercise’s sets', async () => {
    // Row hits 10 (the top of its 8-10 band) on both sets ⇒ +5.
    // Press misses 8 on its only set ⇒ -5. A cross-contaminated grouping would
    // give both exercises the same verdict.
    const store = makeStore(
      [
        makeSet('s1', 'cable-row', 10),
        makeSet('s2', 'cable-row', 10),
        makeSet('s3', 'cable-chest-press', 4),
      ],
      [planned('cable-row'), planned('cable-chest-press')],
    );
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises[0]?.progression?.delta).toBe(5);
    expect(summary?.exercises[1]?.progression?.delta).toBe(-5);
    expect(summary?.exercises[0]?.progression?.basedOnSessionId).toBe('sess-1');
  });

  it('excludes warm-ups from the working-set count', async () => {
    const store = makeStore(
      [
        makeSet('s0', 'cable-row', 5, { isWarmup: true, weightLbs: 60 }),
        makeSet('s1', 'cable-row', 10),
      ],
      [planned('cable-row')],
    );
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises[0]?.setCount).toBe(2);
    expect(summary?.exercises[0]?.workingSetCount).toBe(1);
  });

  it('reports totals from the sets, and the top load actually lifted', async () => {
    const store = makeStore(
      [makeSet('s1', 'cable-row', 10), makeSet('s2', 'cable-row', 8, { weightLbs: 120 })],
      [planned('cable-row')],
    );
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises[0]?.totalReps).toBe(18);
    expect(summary?.exercises[0]?.topWeightLbs).toBe(120);
    expect(summary?.exercises[0]?.volumeLbs).toBe(10 * 100 + 8 * 120);
  });

  it('reports volume and top load as gaps, not zeros, when no set recorded a load', async () => {
    const store = makeStore([makeSet('s1', 'cable-row', 10, { weightLbs: undefined })], []);
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises[0]?.topWeightLbs).toBeNull();
    expect(summary?.exercises[0]?.volumeLbs).toBeNull();
  });

  it('explains a missing recommendation instead of inventing one', async () => {
    const notPrescribed = makeStore([makeSet('s1', 'cable-row', 10)], []);
    const noPlan = (await buildSessionSummary({ store: notPrescribed, nameOf }, 'sess-1'))
      ?.exercises[0];
    expect(noPlan?.progression).toBeNull();
    expect(noPlan?.progressionNote).toContain('not prescribed');

    const noProgram = makeStore([makeSet('s1', 'cable-row', 10)], [], { programs: [] });
    const withoutProgram = (await buildSessionSummary({ store: noProgram, nameOf }, 'sess-1'))
      ?.exercises[0];
    expect(withoutProgram?.progression).toBeNull();
    expect(withoutProgram?.progressionNote).toContain('No active training program');
  });

  it('falls back to an unattributed group for sets that recorded no exercise', async () => {
    const store = makeStore([makeSet('s1', undefined, 10)], []);
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises).toHaveLength(1);
    expect(summary?.exercises[0]?.exerciseId).toBeNull();
    expect(summary?.exercises[0]?.name).toBe('Unattributed');
  });

  it('reports no exercises for a session with no sets', async () => {
    const summary = await buildSessionSummary({ store: makeStore([], []), nameOf }, 'sess-1');
    expect(summary?.exercises).toEqual([]);
  });

  it('names an exercise the catalog does not know by its raw id', async () => {
    const store = makeStore([makeSet('s1', 'mystery-lift', 5)], []);
    const summary = await buildSessionSummary({ store, nameOf }, 'sess-1');
    expect(summary?.exercises[0]?.name).toBe('mystery-lift');
  });
});

describe('resolveSummarySessionId', () => {
  it('resolves "latest" to the most recently started session', async () => {
    const store = makeStore([], []);
    await expect(resolveSummarySessionId(store, 'latest')).resolves.toBe('sess-1');
  });

  it('passes an explicit id through when it exists, and undefined when it does not', async () => {
    const store = makeStore([], []);
    await expect(resolveSummarySessionId(store, 'sess-1')).resolves.toBe('sess-1');
    await expect(resolveSummarySessionId(store, 'ghost')).resolves.toBeUndefined();
  });
});
