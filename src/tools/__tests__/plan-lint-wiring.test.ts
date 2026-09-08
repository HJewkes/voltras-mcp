// The B31 lints as the plan tools actually surface them (VMCP-06.03).
//
// A real `:memory:` SqliteSessionStore, so "the row still persisted" is a
// genuine claim about the database rather than about a spy. The exercise
// catalog is stubbed on `ExerciseService` because the lint's contract is about
// which FIELD it reads (`muscleGroups[0]`, never `secondaryMuscleGroups`), and
// a stub is the only way to state that without depending on the published
// catalog's data.
//
// The tier here is always the default beginner/provisional — nothing writes a
// `training_profile` row. The advanced-tier ceilings are covered in
// `src/plan/__tests__/lint-plan.test.ts`, at the seam that can express them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { registerPlanTools } = await import('../plan-tools.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');
const { SqliteSessionStore } = await import('../../store/sqlite-store.js');

import type { Exercise } from '../../exercises/exercise-service.js';
import type { PlanWarning } from '../../plan/lint-plan.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredPlannedExercise } from '../../store/types.js';

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

const TOOL_NAMES = [
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

/**
 * `chest` primary with a `triceps` SECONDARY on every entry: the per-muscle
 * lint must never reach the second field, so a test that trips over it would
 * report a triceps bucket that no plan asked for.
 */
const CATALOG: Record<string, Exercise> = {
  'bench-press': {
    id: 'bench-press',
    name: 'Bench Press',
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['triceps', 'shoulders'],
    movementPattern: 'push',
    exerciseType: 'compound',
    equipment: [{ name: 'cable', category: 'cable' }],
    cableEquivalent: true,
    qualityScore: 95,
  },
  'cable-fly': {
    id: 'cable-fly',
    name: 'Cable Fly',
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['triceps', 'shoulders'],
    movementPattern: 'push',
    exerciseType: 'isolation',
    equipment: [{ name: 'cable', category: 'cable' }],
    cableEquivalent: true,
    qualityScore: 90,
  },
};

interface Harness {
  store: InstanceType<typeof SqliteSessionStore>;
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const exercises = new ExerciseService();
  exercises.getById = ((id: string) => CATALOG[id]) as ExerciseService['getById'];
  const state = { store, exercises } as unknown as ServerState;

  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  registerPlanTools(
    { tool: vi.fn() } as unknown as Parameters<typeof registerPlanTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerPlanTools>[2],
  );

  const invoke = async (name: string, args: unknown): Promise<ToolResult> => {
    const cb = placeholders.get(name)?.callback;
    if (!cb) throw new Error(`no callback installed for ${name}`);
    return (await cb(args)) as ToolResult;
  };
  return { store, invoke };
}

function body<T>(r: ToolResult): T {
  return JSON.parse(r.content[0].text) as T;
}

/** Build program -> block -> week -> template through the real tools. */
async function makeTemplate(h: Harness): Promise<string> {
  const program = body<{ program: { id: string } }>(
    await h.invoke('plan.program.create', { name: 'Return Block' }),
  ).program;
  const block = body<{ block: { id: string } }>(
    await h.invoke('plan.block.create', {
      programId: program.id,
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 4,
    }),
  ).block;
  const week = body<{ week: { id: string } }>(
    await h.invoke('plan.week.create', { blockId: block.id, orderIndex: 0, name: 'Week 1' }),
  ).week;
  const created = await h.invoke('plan.template.create', {
    weekId: week.id,
    orderIndex: 0,
    name: 'Day A',
  });
  const parsed = body<{ template: { id: string }; warnings: PlanWarning[] }>(created);
  expect(parsed.warnings).toEqual([]);
  return parsed.template.id;
}

function addExercise(
  h: Harness,
  workoutTemplateId: string,
  exerciseId: string,
  targetSets: number,
  orderIndex: number,
): Promise<ToolResult> {
  return h.invoke('plan.exercise.create', {
    workoutTemplateId,
    exerciseId,
    orderIndex,
    targetSets,
  });
}

let h: Harness;

beforeEach(() => {
  h = setup();
});

describe('plan.exercise.create lints', () => {
  it('warns once when a beginner adds a 6-set exercise, and still persists the row', async () => {
    const templateId = await makeTemplate(h);

    const r = await addExercise(h, templateId, 'bench-press', 6, 0);

    const parsed = body<{ plannedExercise: StoredPlannedExercise; warnings: PlanWarning[] }>(r);
    expect(r.isError).toBeUndefined();
    expect(
      parsed.warnings.filter((w) => w.code === 'sets_per_exercise_over_tier_ceiling'),
    ).toHaveLength(1);
    const persisted = await h.store.getPlannedExercisesForTemplate(templateId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].targetSets).toBe(6);
  });

  it('sums the template into a per-muscle warning at 9 chest sets', async () => {
    const templateId = await makeTemplate(h);
    await addExercise(h, templateId, 'bench-press', 5, 0);

    const r = await addExercise(h, templateId, 'cable-fly', 4, 1);

    const { warnings } = body<{ warnings: PlanWarning[] }>(r);
    const perMuscle = warnings.filter(
      (w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling',
    );
    expect(perMuscle).toHaveLength(1);
    expect(perMuscle[0]).toMatchObject({ muscleGroup: 'chest', observed: 9, ceiling: 8 });
  });

  it('never counts secondary muscle groups into a bucket', async () => {
    const templateId = await makeTemplate(h);
    await addExercise(h, templateId, 'bench-press', 5, 0);

    const r = await addExercise(h, templateId, 'cable-fly', 4, 1);

    const { warnings } = body<{ warnings: PlanWarning[] }>(r);
    // 9 sets name triceps and shoulders as SECONDARIES on both lifts; a lint
    // that read `secondaryMuscleGroups` would report those buckets too.
    expect(warnings.map((w) => w.muscleGroup).filter(Boolean)).toEqual(['chest']);
  });

  it('marks a default-tier warning as provisional', async () => {
    const templateId = await makeTemplate(h);

    const r = await addExercise(h, templateId, 'bench-press', 6, 0);

    const { warnings } = body<{ warnings: PlanWarning[] }>(r);
    expect(warnings[0].tier).toBe('beginner');
    expect(warnings[0].message).toContain('tier is provisional');
  });

  it('returns no warnings for a plan inside every ceiling', async () => {
    const templateId = await makeTemplate(h);

    const r = await addExercise(h, templateId, 'bench-press', 3, 0);

    expect(body<{ warnings: PlanWarning[] }>(r).warnings).toEqual([]);
  });

  it('persists every row of a plan that is 3x over every ceiling', async () => {
    const templateId = await makeTemplate(h);
    await addExercise(h, templateId, 'bench-press', 15, 0);

    const r = await addExercise(h, templateId, 'cable-fly', 15, 1);

    expect(r.isError).toBeUndefined();
    const { warnings } = body<{ warnings: PlanWarning[] }>(r);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    const persisted = await h.store.getPlannedExercisesForTemplate(templateId);
    expect(persisted.map((e) => e.targetSets)).toEqual([15, 15]);
  });
});
