// Set-level exercise scoping across the tool read paths (VMCP-01.72a).
//
// Every test here seeds ONE session holding two exercises — a 145 lb bench and
// a 325 lb squat — which today's `session.start` cannot produce, and asserts
// that each read path answers about the exercise it was asked about. Before the
// migration these paths filtered SESSIONS by exercise and then consumed
// `getSetsForSession()` unfiltered, so every one of them answered about the
// heavier movement instead.
//
// Driven against the real SQLite store rather than a stub, because the point is
// that the SETS carry the exercise: a fake that returns rows with no
// `exerciseId` cannot tell a scoped reader from an unscoped one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredRep, StoredSet } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError, TrainingMode: {}, TrainingModeNames: {} };
});

const { registerProgressionTools } = await import('../progression-tools.js');
const { registerPlanTools } = await import('../plan-tools.js');
const { registerMetricsTools } = await import('../metrics-tools.js');

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number, velocity: number): StoredRep {
  const rep = {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: index * 3000,
      endTime: index * 3000 + 1200,
      peakVelocity: velocity,
      // Mean velocity is _totalVelocity / _movementSampleCount; zeros here make
      // every velocity-derived assertion below trivially equal.
      _movementSampleCount: 10,
      _totalVelocity: velocity * 9,
    },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: index * 3000 + 1200,
      endTime: index * 3000 + 2600,
      peakVelocity: velocity * 0.7,
      _movementSampleCount: 10,
      _totalVelocity: velocity * 7,
    },
  } as Rep;
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

function makeSet(args: {
  id: string;
  sessionId: string;
  exerciseId?: string;
  weightLbs: number;
  reps: number;
  startedAt: string;
}): StoredSet {
  return {
    id: args.id,
    sessionId: args.sessionId,
    userId: LOCAL_USER_ID,
    startedAt: args.startedAt,
    endedAt: args.startedAt,
    partial: false,
    weightLbs: args.weightLbs,
    reps: Array.from({ length: args.reps }, (_, i) => makeRep(args.id, i, 0.7 - i * 0.03)),
    ...(args.exerciseId !== undefined ? { exerciseId: args.exerciseId } : {}),
  } as StoredSet;
}

const MIXED_SESSION_ID = 'sess-mixed';

/** One session, two exercises: 2×8 @135 bench and 1×3 @325 squat. */
async function seedMixedSession(store: SqliteSessionStore, startedAt: string): Promise<void> {
  await store.putSession({
    id: MIXED_SESSION_ID,
    startedAt,
    endedAt: startedAt,
    exerciseId: 'bench-press',
  });
  await store.putSet(
    makeSet({
      id: 'mixed-bench-1',
      sessionId: MIXED_SESSION_ID,
      exerciseId: 'bench-press',
      weightLbs: 135,
      reps: 8,
      startedAt,
    }),
  );
  await store.putSet(
    makeSet({
      id: 'mixed-bench-2',
      sessionId: MIXED_SESSION_ID,
      exerciseId: 'bench-press',
      weightLbs: 135,
      reps: 8,
      startedAt,
    }),
  );
  await store.putSet(
    makeSet({
      id: 'mixed-squat-1',
      sessionId: MIXED_SESSION_ID,
      exerciseId: 'back-squat',
      weightLbs: 325,
      reps: 3,
      startedAt,
    }),
  );
}

interface FakeTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(u: { callback: FakeTool['callback'] }): void;
  remove(): void;
}

function fakePlaceholders(names: readonly string[]): {
  placeholders: Map<string, FakeTool>;
  invoke: (name: string, args: unknown) => Promise<unknown>;
} {
  const placeholders = new Map<string, FakeTool>();
  for (const name of names) {
    const tool: FakeTool = {
      update(u) {
        tool.callback = u.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (cb === undefined) throw new Error(`no callback installed for ${name}`);
      const result = await cb(args);
      return JSON.parse(result.content[0]!.text) as unknown;
    },
  };
}

function stateWith(store: SqliteSessionStore): ServerState {
  return { store, slots: new Map() } as unknown as ServerState;
}

let store: SqliteSessionStore;

beforeEach(() => {
  store = SqliteSessionStore.open(':memory:');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('progression.get_for_exercise — set-level scoping', () => {
  it('summarises only the requested exercise when a session holds two', async () => {
    await seedMixedSession(store, '2026-07-16T18:00:00.000Z');
    const { placeholders, invoke } = fakePlaceholders(['progression.get_for_exercise']);
    registerProgressionTools({} as never, stateWith(store), placeholders);

    const res = (await invoke('progression.get_for_exercise', {
      exerciseId: 'bench-press',
    })) as { sessions: { setCount: number; topWeightLbs: number; totalReps: number }[] };

    expect(res.sessions).toHaveLength(1);
    // Unscoped this reads 3 sets, a 325 lb top weight and 19 reps — the squat's.
    expect(res.sessions[0]).toMatchObject({ setCount: 2, topWeightLbs: 135, totalReps: 16 });
  });
});

describe('plan.suggest_progression — set-level scoping', () => {
  const PLAN_TOOLS = [
    'plan.program.create',
    'plan.program.list',
    'plan.program.get',
    'plan.program.archive',
    'plan.block.create',
    'plan.block.list_for_program',
    'plan.week.create',
    'plan.week.list_for_block',
    'plan.template.create',
    'plan.template.get',
    'plan.template.list_for_week',
    'plan.exercise.create',
    'plan.exercise.list_for_template',
    'plan.next_workout',
    'plan.complete_workout',
    'plan.attach_to_session',
    'plan.suggest_progression',
  ];

  async function seedPlan(): Promise<void> {
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Scoping',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 4,
    });
    await store.putTrainingWeek({
      id: 'week-1',
      blockId: 'block-1',
      orderIndex: 0,
      weekIndex: 0,
      isDeload: false,
    });
    await store.putWorkoutTemplate({ id: 'tmpl-1', weekId: 'week-1', orderIndex: 0, name: 'Full' });
    await store.putPlannedExercise({
      id: 'pe-bench',
      workoutTemplateId: 'tmpl-1',
      exerciseId: 'bench-press',
      orderIndex: 0,
      targetSets: 2,
      targetRepsLow: 6,
      targetRepsHigh: 8,
    });
  }

  it('scores the bench sets, not the session-heaviest squat set', async () => {
    await seedPlan();
    await seedMixedSession(store, '2026-07-16T18:00:00.000Z');
    const { placeholders, invoke } = fakePlaceholders(PLAN_TOOLS);
    registerPlanTools({} as never, stateWith(store), placeholders);

    const res = (await invoke('plan.suggest_progression', { exerciseId: 'bench-press' })) as {
      suggestion: { delta: number; reasoning: string; basedOnSessionId: string };
    };

    expect(res.suggestion.basedOnSessionId).toBe(MIXED_SESSION_ID);
    // `selectWorkingSets` keeps the sets at the TOP load of whatever it is
    // given. Unscoped, the 325 lb squat is the top load, both bench sets are
    // discarded as warm-ups, and the 3-rep squat scores as "1/1 sets missed 6
    // reps" → a -5 lb back-off on the bench.
    expect(res.suggestion.reasoning).toContain('2/2 sets');
    expect(res.suggestion.reasoning).not.toContain('1/1 sets');
    expect(res.suggestion.delta).toBeGreaterThanOrEqual(0);
  });
});

describe('metrics.compute session pipelines — set-level scoping', () => {
  it('estimates strength from the session exercise only', async () => {
    await seedMixedSession(store, '2026-07-16T18:00:00.000Z');
    const { placeholders, invoke } = fakePlaceholders(['metrics.compute']);
    registerMetricsTools({ tool: () => undefined } as never, stateWith(store), placeholders);

    const res = (await invoke('metrics.compute', {
      pipeline: 'session.strength',
      sessionId: MIXED_SESSION_ID,
    })) as { estimated1RM: number };

    // Bench at 135×8 estimates ~171 lb; folding the 325 lb squat in pushes the
    // estimate past 300.
    expect(res.estimated1RM).toBeLessThan(200);
  });

  it('leaves session.volume as whole-session tonnage (explicitly out of scope)', async () => {
    await seedMixedSession(store, '2026-07-16T18:00:00.000Z');
    const { placeholders, invoke } = fakePlaceholders(['metrics.compute']);
    registerMetricsTools({ tool: () => undefined } as never, stateWith(store), placeholders);

    const res = (await invoke('metrics.compute', {
      pipeline: 'session.volume',
      sessionId: MIXED_SESSION_ID,
    })) as number;

    // 135×8 + 135×8 + 325×3 — every set in the session, squat included.
    expect(res).toBe(135 * 8 + 135 * 8 + 325 * 3);
  });
});
