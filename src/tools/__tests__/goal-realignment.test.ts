// The block-boundary re-ask (VW-359, plan H3).
//
// A real `SqliteSessionStore` on `:memory:`, like `goal-tools.test.ts`: the
// re-ask reads the declaration, the plan tree, history and the diet phase, and
// a fake that answers all of those would be a second store with its own
// opinions. Only the exercise catalog is stubbed.
//
// What the cases are for:
//   * the prompt names the priorities and how long each has been held, so the
//     coach reads out the declaration rather than the free-text goal;
//   * the bands come back re-proposed for the next block, off the same path
//     `goal.propose_targets` writes from;
//   * an accepted target is reported as blocked, never re-banded — the re-ask
//     re-proposes and never lowers a target the lifter committed to;
//   * switching is what draws the warnings: rp-s6 for a priority still bound
//     to the block that just ended, rp-s5 for one held under two mesocycles.

import { beforeEach, describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredPriority, StoredRep, StoredSet } from '../../store/types.js';
import { buildGoalRealignment } from '../goal-realignment.js';
import { registerPlanTools } from '../plan-tools.js';

const CATALOG = [
  { id: 'bench-press', muscleGroups: ['chest'], name: 'Bench Press' },
  { id: 'curl', muscleGroups: ['biceps'], name: 'Curl' },
];

const PLAN_TOOL_NAMES = [
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
  'plan.current_block',
  'plan.block.planning_brief',
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
];

const BLOCK_ID = 'block-1';
const NEXT_BLOCK_ID = 'block-2';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(updates: { callback: FakeRegisteredTool['callback'] }): void;
}

interface Harness {
  store: SqliteSessionStore;
  state: ServerState;
  invoke: (name: string, args?: unknown) => Promise<Record<string, unknown>>;
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const state = {
    store,
    slots: new Map(),
    exercises: { list: () => CATALOG, getById: (id: string) => CATALOG.find((e) => e.id === id) },
  } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of PLAN_TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  registerPlanTools(
    { tool: () => undefined } as unknown as Parameters<typeof registerPlanTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerPlanTools>[2],
  );
  return {
    store,
    state,
    invoke: async (name, args = {}) => {
      const callback = placeholders.get(name)?.callback;
      if (callback === undefined) throw new Error(`no callback installed for ${name}`);
      const result = await callback(args);
      if (result.isError === true) throw new Error(`unexpected error: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
  };
}

/** Two blocks of one week each; the finished block's only template is `tmpl-1`. */
async function seedPlanTree(store: SqliteSessionStore): Promise<void> {
  await store.putTrainingProgram({
    id: 'prog-a',
    name: 'Program A',
    createdAt: daysAgo(60),
    archived: false,
  });
  for (const [index, id] of [BLOCK_ID, NEXT_BLOCK_ID].entries()) {
    await store.putTrainingBlock({
      id,
      programId: 'prog-a',
      orderIndex: index,
      name: `Block ${String(index + 1)}`,
      weeksCount: 1,
    });
    await store.putTrainingWeek({
      id: `week-${id}`,
      blockId: id,
      orderIndex: 0,
      isDeload: false,
    });
    await store.putWorkoutTemplate({
      id: `tmpl-${id}`,
      weekId: `week-${id}`,
      name: `Day ${String(index + 1)}`,
      orderIndex: 0,
    });
  }
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

/** Enough matched history for a lift leg to read a start value out of it. */
async function seedLiftHistory(store: SqliteSessionStore, exerciseId: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const at = daysAgo((3 - index) * 7);
    const sessionId = `${exerciseId}-sess-${String(index)}`;
    await store.putSession({
      kind: 'training',
      id: sessionId,
      startedAt: at,
      endedAt: at,
      exerciseId,
    });
    for (const suffix of ['a', 'b']) {
      const setId = `${exerciseId}-set-${String(index)}${suffix}`;
      const set: StoredSet = {
        id: setId,
        sessionId,
        userId: LOCAL_USER_ID,
        exerciseId,
        startedAt: at,
        endedAt: at,
        partial: false,
        weightLbs: 135,
        setPurpose: 'working',
        reps: makeReps(setId, 8),
      };
      await store.putSet(set);
    }
  }
}

async function declare(
  store: SqliteSessionStore,
  overrides: Partial<StoredPriority> = {},
): Promise<StoredPriority> {
  return store.putPriority({
    id: 'prio-1',
    userId: LOCAL_USER_ID,
    blockId: BLOCK_ID,
    horizonWeeks: 6,
    kind: 'lift',
    ref: 'bench-press',
    level: 'specialize',
    declaredAt: daysAgo(42),
    mesosHeld: 0,
    ...overrides,
  });
}

function codesOf(warnings: { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe('buildGoalRealignment', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await seedPlanTree(h.store);
  });

  it('returns null when nothing has been declared', async () => {
    expect(await buildGoalRealignment(h.state, BLOCK_ID)).toBeNull();
  });

  it('names every declared priority with its level and mesocycles held', async () => {
    await declare(h.store, { mesosHeld: 1 });

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    expect(realignment?.priorities).toHaveLength(1);
    expect(realignment?.priorities[0]).toMatchObject({
      ref: 'bench-press',
      level: 'specialize',
      mesosHeld: 1,
    });
    expect(realignment?.minMesosBeforeSwitch).toBe(2);
  });

  it('re-proposes a band for the next block off the measured start value', async () => {
    await declare(h.store);
    await seedLiftHistory(h.store, 'bench-press');

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    const target = realignment?.priorities[0].targets.find(
      (entry) => entry.metric === 'top_load_at_reps',
    );
    expect(target).toBeDefined();
    expect(target?.startValue).toBe(135);
    expect(target?.committedValue).toBeGreaterThanOrEqual(135);
    expect(target?.stretchValue).toBeGreaterThanOrEqual(target?.committedValue ?? 0);
    expect(target?.basis).toBeTruthy();
  });

  it('writes nothing: the re-ask leaves no proposal behind', async () => {
    await declare(h.store);
    await seedLiftHistory(h.store, 'bench-press');

    await buildGoalRealignment(h.state, BLOCK_ID);

    expect(
      await h.store.listGoalTargets({ priorityId: 'prio-1' }, { includeRetired: true }),
    ).toEqual([]);
  });

  it('reports an accepted target as skipped instead of re-banding it', async () => {
    await declare(h.store);
    await seedLiftHistory(h.store, 'bench-press');
    await h.store.putGoalTarget({
      id: 'target-1',
      priorityId: 'prio-1',
      metric: 'top_load_at_reps',
      exerciseId: 'bench-press',
      anchorReps: 8,
      startValue: 135,
      startMeasuredAt: daysAgo(7),
      bandLowPctPerWeek: 0.5,
      bandHighPctPerWeek: 1,
      committedValue: 140,
      stretchValue: 145,
      basis: 'rp_ramp',
      infoLevel: 'ramp',
      tierUsed: 'beginner',
      tierProvisional: false,
      dietPhaseAtDerivation: 'unknown',
      acceptedBy: 'user',
      acknowledgedStretch: false,
      derivedAt: daysAgo(42),
      endsAt: daysAgo(1),
    });

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    expect(realignment?.priorities[0].targets).toEqual([]);
    expect(realignment?.priorities[0].skipped[0]?.reason).toContain('already accepted');
  });

  it('warns per rp-s6 that the priority is still bound to the block that just ended', async () => {
    await declare(h.store);

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    const warning = realignment?.warningsIfChanged.find(
      (entry) => entry.code === 'priority_changed_mid_block',
    );
    expect(warning?.rpIds).toContain('rp:rp-s6-priority-muscle-held-constant-per-block');
  });

  it('nudges per rp-s5 when a specialization has been held under two mesocycles', async () => {
    await declare(h.store, { mesosHeld: 1 });

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    const nudge = realignment?.warningsIfChanged.find(
      (entry) => entry.code === 'priority_persistence_nudge',
    );
    expect(nudge?.message).toContain('1 mesocycle(s)');
    expect(nudge?.rpIds).toContain('rp:rp-s5-goal-persistence-multi-meso');
  });

  it('drops the persistence nudge once the priority has been held long enough', async () => {
    await declare(h.store, { mesosHeld: 2 });

    const realignment = await buildGoalRealignment(h.state, BLOCK_ID);

    expect(codesOf(realignment?.warningsIfChanged ?? [])).not.toContain(
      'priority_persistence_nudge',
    );
  });
});

interface BoundaryBody {
  blockBoundary: {
    finishedBlock: { id: string };
    nextBlock: { id: string } | null;
    prompt: string;
    realignment: {
      priorities: { ref: string; mesosHeld: number; targets: { metric: string }[] }[];
      warningsIfChanged: { code: string }[];
    } | null;
  } | null;
}

describe('plan.complete_workout block boundary', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await seedPlanTree(h.store);
    await h.store.putSession({ kind: 'training', id: 'sess-1', startedAt: daysAgo(1) });
  });

  it('carries the re-ask on the last template of a block', async () => {
    await declare(h.store, { mesosHeld: 1 });
    await seedLiftHistory(h.store, 'bench-press');

    const body = (await h.invoke('plan.complete_workout', {
      workoutTemplateId: `tmpl-${BLOCK_ID}`,
      sessionId: 'sess-1',
    })) as unknown as BoundaryBody;

    expect(body.blockBoundary?.finishedBlock.id).toBe(BLOCK_ID);
    expect(body.blockBoundary?.nextBlock?.id).toBe(NEXT_BLOCK_ID);
    expect(body.blockBoundary?.realignment?.priorities[0].ref).toBe('bench-press');
    expect(body.blockBoundary?.realignment?.priorities[0].targets).not.toHaveLength(0);
    expect(body.blockBoundary?.prompt).toContain('bench-press (specialize, held 1 mesocycle(s))');
    expect(body.blockBoundary?.prompt).toContain('Keep them, restate them, or re-architect');
    expect(body.blockBoundary?.prompt).toContain('Block 2');
  });

  it('keeps the free-text prompt for a lifter who has declared no priorities', async () => {
    await h.store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      goal: 'Bench 225',
      updatedAt: daysAgo(30),
    });

    const body = (await h.invoke('plan.complete_workout', {
      workoutTemplateId: `tmpl-${BLOCK_ID}`,
      sessionId: 'sess-1',
    })) as unknown as BoundaryBody;

    expect(body.blockBoundary?.realignment).toBeNull();
    expect(body.blockBoundary?.prompt).toContain("Your goal on file is 'Bench 225'");
  });

  it('reports a null nextBlock when the program’s last block ends', async () => {
    await declare(h.store);

    const body = (await h.invoke('plan.complete_workout', {
      workoutTemplateId: `tmpl-${NEXT_BLOCK_ID}`,
      sessionId: 'sess-1',
    })) as unknown as BoundaryBody;

    expect(body.blockBoundary?.nextBlock).toBeNull();
  });
});
