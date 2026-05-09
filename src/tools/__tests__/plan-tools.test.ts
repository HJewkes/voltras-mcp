// Unit tests for src/tools/plan-tools.ts.
//
// Coverage shape:
//   * Happy path for every create-tool (programs/blocks/weeks/templates/
//     exercises). Confirms the persisted entity shape, that the store was
//     called once with the right payload, and that the response wraps the
//     entity under the documented key (`program`, `block`, `week`, etc).
//   * list_* tools forward straight to the store and return rows in store
//     order. Most of the actual ordering work lives in the SQLite store
//     (`ORDER BY order_index ASC`) and is exercised in
//     `sqlite-store-plan-schema.test.ts`; here we just confirm the tool
//     handler does not re-sort or filter.
//   * Spot-check `.strict()` rejection on a handful of create schemas — an
//     unknown key on each must surface as INVALID_INPUT, not silently drop.
//   * ID auto-generation: when `id` is omitted the handler stamps a UUID;
//     when present it's preserved verbatim.
//   * Plan deletion cascade: a `:memory:` SqliteSessionStore exercises the
//     v3 schema's `ON DELETE CASCADE`. Because there is no archive-cascade
//     tool, the test issues the DELETE directly against the underlying
//     `node:sqlite` handle and then re-queries through the public
//     SessionStore methods.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type {
  SessionStore,
  StoredPlannedExercise,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { registerPlanTools } = await import('../plan-tools.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface FakeServer {
  tool: (...args: unknown[]) => unknown;
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
];

function makeFakePlaceholders(names: string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
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
  const invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  > = {};
  for (const name of names) {
    invokers[name] = async (args: unknown) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
  }
  return { placeholders, invokers };
}

function makeStore(): SessionStore & {
  putTrainingProgram: ReturnType<typeof vi.fn>;
  getTrainingProgram: ReturnType<typeof vi.fn>;
  listTrainingPrograms: ReturnType<typeof vi.fn>;
  putTrainingBlock: ReturnType<typeof vi.fn>;
  getTrainingBlocksForProgram: ReturnType<typeof vi.fn>;
  putTrainingWeek: ReturnType<typeof vi.fn>;
  getTrainingWeeksForBlock: ReturnType<typeof vi.fn>;
  putWorkoutTemplate: ReturnType<typeof vi.fn>;
  getWorkoutTemplate: ReturnType<typeof vi.fn>;
  getWorkoutTemplatesForWeek: ReturnType<typeof vi.fn>;
  putPlannedExercise: ReturnType<typeof vi.fn>;
  getPlannedExercisesForTemplate: ReturnType<typeof vi.fn>;
  putProgramAssignment: ReturnType<typeof vi.fn>;
  getAssignmentsForSession: ReturnType<typeof vi.fn>;
} {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    putTrainingProgram: vi.fn(async () => {}),
    getTrainingProgram: vi.fn(async () => undefined),
    listTrainingPrograms: vi.fn(async () => []),
    putTrainingBlock: vi.fn(async () => {}),
    getTrainingBlocksForProgram: vi.fn(async () => []),
    putTrainingWeek: vi.fn(async () => {}),
    getTrainingWeeksForBlock: vi.fn(async () => []),
    putWorkoutTemplate: vi.fn(async () => {}),
    getWorkoutTemplate: vi.fn(async () => undefined),
    getWorkoutTemplatesForWeek: vi.fn(async () => []),
    putPlannedExercise: vi.fn(async () => {}),
    getPlannedExercisesForTemplate: vi.fn(async () => []),
    putProgramAssignment: vi.fn(async () => {}),
    getAssignmentsForSession: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

interface Harness {
  state: ServerState;
  store: ReturnType<typeof makeStore>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function setup(): Harness {
  const store = makeStore();
  const state = {
    store,
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as FakeServer;
  registerPlanTools(
    server as unknown as Parameters<typeof registerPlanTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerPlanTools>[2],
  );
  return {
    state,
    store,
    invoke: (name, args) => invokers[name](args),
  };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Programs ─────────────────────────────────────────────────────────────
describe('plan.program.create', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a program with auto-generated id and ISO createdAt', async () => {
    const r = await h.invoke('plan.program.create', {
      name: 'Block 1',
      description: '12-week strength block',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { program: StoredTrainingProgram };
    expect(body.program.name).toBe('Block 1');
    expect(body.program.description).toBe('12-week strength block');
    expect(body.program.id).toMatch(UUID_RE);
    expect(typeof body.program.createdAt).toBe('string');
    expect(new Date(body.program.createdAt).toISOString()).toBe(body.program.createdAt);
    expect(body.program.archivedAt).toBeUndefined();

    expect(h.store.putTrainingProgram).toHaveBeenCalledTimes(1);
    expect(h.store.putTrainingProgram.mock.calls[0][0]).toEqual(body.program);
  });

  it('preserves an explicitly-supplied id', async () => {
    const r = await h.invoke('plan.program.create', { id: 'my-program', name: 'Custom' });
    const body = parseResult(r) as { program: StoredTrainingProgram };
    expect(body.program.id).toBe('my-program');
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('plan.program.create', { name: 'x', unexpected: true });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    expect(h.store.putTrainingProgram).not.toHaveBeenCalled();
  });
});

describe('plan.program.list', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns programs in store order', async () => {
    const programs: StoredTrainingProgram[] = [
      { id: 'p1', name: 'first', createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'second', createdAt: '2025-01-02T00:00:00.000Z' },
    ];
    h.store.listTrainingPrograms.mockResolvedValueOnce(programs);
    const r = await h.invoke('plan.program.list', {});
    expect(r.isError).toBeUndefined();
    expect((parseResult(r) as { programs: StoredTrainingProgram[] }).programs).toEqual(programs);
    expect(h.store.listTrainingPrograms).toHaveBeenCalledWith({});
  });

  it('forwards includeArchived to the store', async () => {
    h.store.listTrainingPrograms.mockResolvedValueOnce([]);
    await h.invoke('plan.program.list', { includeArchived: true });
    expect(h.store.listTrainingPrograms).toHaveBeenCalledWith({ includeArchived: true });
  });
});

describe('plan.program.get', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns null when no program matches', async () => {
    h.store.getTrainingProgram.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.program.get', { id: 'nope' });
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ program: null });
  });

  it('returns the program when present', async () => {
    const program: StoredTrainingProgram = {
      id: 'p1',
      name: 'x',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    h.store.getTrainingProgram.mockResolvedValueOnce(program);
    const r = await h.invoke('plan.program.get', { id: 'p1' });
    expect(parseResult(r)).toEqual({ program });
  });
});

describe('plan.program.archive', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('archives a known program by stamping archivedAt', async () => {
    const existing: StoredTrainingProgram = {
      id: 'p1',
      name: 'x',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    h.store.getTrainingProgram.mockResolvedValueOnce(existing);
    const r = await h.invoke('plan.program.archive', { id: 'p1' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { ok: true; archivedAt: string };
    expect(body.ok).toBe(true);
    expect(typeof body.archivedAt).toBe('string');
    expect(h.store.putTrainingProgram).toHaveBeenCalledTimes(1);
    const persisted = h.store.putTrainingProgram.mock.calls[0][0] as StoredTrainingProgram;
    expect(persisted.id).toBe('p1');
    expect(persisted.archivedAt).toBe(body.archivedAt);
    expect(persisted.name).toBe('x');
    expect(persisted.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns NOT_FOUND when the program does not exist', async () => {
    h.store.getTrainingProgram.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.program.archive', { id: 'nope' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
    expect(h.store.putTrainingProgram).not.toHaveBeenCalled();
  });
});

// ─── Blocks ────────────────────────────────────────────────────────────────
describe('plan.block.create', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a block with required + optional fields', async () => {
    const r = await h.invoke('plan.block.create', {
      programId: 'p1',
      orderIndex: 2,
      name: 'Hypertrophy',
      focus: 'hypertrophy',
      weeksCount: 4,
      notes: 'Volume',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { block: StoredTrainingBlock };
    expect(body.block).toMatchObject({
      programId: 'p1',
      orderIndex: 2,
      name: 'Hypertrophy',
      focus: 'hypertrophy',
      weeksCount: 4,
      notes: 'Volume',
    });
    expect(body.block.id).toMatch(UUID_RE);
    expect(h.store.putTrainingBlock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('plan.block.create', {
      programId: 'p1',
      orderIndex: 0,
      name: 'X',
      weeksCount: 1,
      bogus: 1,
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('plan.block.list_for_program', () => {
  it('returns store-ordered blocks for a program', async () => {
    const h = setup();
    const blocks: StoredTrainingBlock[] = [
      { id: 'b1', programId: 'p1', orderIndex: 0, name: 'A', weeksCount: 4 },
      { id: 'b2', programId: 'p1', orderIndex: 1, name: 'B', weeksCount: 4 },
    ];
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce(blocks);
    const r = await h.invoke('plan.block.list_for_program', { programId: 'p1' });
    expect((parseResult(r) as { blocks: StoredTrainingBlock[] }).blocks).toEqual(blocks);
    expect(h.store.getTrainingBlocksForProgram).toHaveBeenCalledWith('p1');
  });
});

// ─── Weeks ─────────────────────────────────────────────────────────────────
describe('plan.week.create', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a week with omitted optional name', async () => {
    const r = await h.invoke('plan.week.create', { blockId: 'b1', orderIndex: 0 });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { week: StoredTrainingWeek };
    expect(body.week.blockId).toBe('b1');
    expect(body.week.orderIndex).toBe(0);
    expect(body.week.name).toBeUndefined();
    expect(body.week.id).toMatch(UUID_RE);
  });

  it('preserves a supplied id and name', async () => {
    const r = await h.invoke('plan.week.create', {
      id: 'w-explicit',
      blockId: 'b1',
      orderIndex: 0,
      name: 'Week 1',
    });
    const body = parseResult(r) as { week: StoredTrainingWeek };
    expect(body.week.id).toBe('w-explicit');
    expect(body.week.name).toBe('Week 1');
  });
});

describe('plan.week.list_for_block', () => {
  it('returns store-ordered weeks for a block', async () => {
    const h = setup();
    const weeks: StoredTrainingWeek[] = [
      { id: 'w1', blockId: 'b1', orderIndex: 0 },
      { id: 'w2', blockId: 'b1', orderIndex: 1 },
    ];
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce(weeks);
    const r = await h.invoke('plan.week.list_for_block', { blockId: 'b1' });
    expect((parseResult(r) as { weeks: StoredTrainingWeek[] }).weeks).toEqual(weeks);
    expect(h.store.getTrainingWeeksForBlock).toHaveBeenCalledWith('b1');
  });
});

// ─── Workout templates ─────────────────────────────────────────────────────
describe('plan.template.create', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a workout template with optional dayLabel + notes', async () => {
    const r = await h.invoke('plan.template.create', {
      weekId: 'w1',
      dayLabel: 'Mon',
      name: 'Upper A',
      notes: 'Push focus',
      orderIndex: 0,
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { template: StoredWorkoutTemplate };
    expect(body.template).toMatchObject({
      weekId: 'w1',
      dayLabel: 'Mon',
      name: 'Upper A',
      notes: 'Push focus',
      orderIndex: 0,
    });
    expect(body.template.id).toMatch(UUID_RE);
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('plan.template.create', {
      weekId: 'w1',
      name: 'X',
      orderIndex: 0,
      typo: 'oops',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('plan.template.get', () => {
  it('returns the template or null', async () => {
    const h = setup();
    h.store.getWorkoutTemplate.mockResolvedValueOnce(undefined);
    const r1 = await h.invoke('plan.template.get', { id: 'nope' });
    expect(parseResult(r1)).toEqual({ template: null });

    const tmpl: StoredWorkoutTemplate = {
      id: 't1',
      weekId: 'w1',
      name: 'X',
      orderIndex: 0,
    };
    h.store.getWorkoutTemplate.mockResolvedValueOnce(tmpl);
    const r2 = await h.invoke('plan.template.get', { id: 't1' });
    expect(parseResult(r2)).toEqual({ template: tmpl });
  });
});

describe('plan.template.list_for_week', () => {
  it('returns store-ordered templates for a week', async () => {
    const h = setup();
    const tmpls: StoredWorkoutTemplate[] = [
      { id: 't1', weekId: 'w1', name: 'A', orderIndex: 0 },
      { id: 't2', weekId: 'w1', name: 'B', orderIndex: 1 },
    ];
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce(tmpls);
    const r = await h.invoke('plan.template.list_for_week', { weekId: 'w1' });
    expect((parseResult(r) as { templates: StoredWorkoutTemplate[] }).templates).toEqual(tmpls);
    expect(h.store.getWorkoutTemplatesForWeek).toHaveBeenCalledWith('w1');
  });
});

// ─── Planned exercises ─────────────────────────────────────────────────────
describe('plan.exercise.create', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a planned exercise with all optional prescription fields', async () => {
    const r = await h.invoke('plan.exercise.create', {
      workoutTemplateId: 't1',
      exerciseId: 'bench-press',
      orderIndex: 0,
      targetSets: 3,
      targetRepsLow: 8,
      targetRepsHigh: 12,
      targetWeightLbs: 135,
      targetRpe: 8,
      restSec: 120,
      notes: 'Pause at chest',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { plannedExercise: StoredPlannedExercise };
    expect(body.plannedExercise).toMatchObject({
      workoutTemplateId: 't1',
      exerciseId: 'bench-press',
      orderIndex: 0,
      targetSets: 3,
      targetRepsLow: 8,
      targetRepsHigh: 12,
      targetWeightLbs: 135,
      targetRpe: 8,
      restSec: 120,
      notes: 'Pause at chest',
    });
    expect(body.plannedExercise.id).toMatch(UUID_RE);
  });

  it('omits unset optional fields from the persisted row', async () => {
    const r = await h.invoke('plan.exercise.create', {
      workoutTemplateId: 't1',
      exerciseId: 'squat',
      orderIndex: 0,
      targetSets: 5,
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { plannedExercise: StoredPlannedExercise };
    expect(body.plannedExercise.targetRepsLow).toBeUndefined();
    expect(body.plannedExercise.targetRepsHigh).toBeUndefined();
    expect(body.plannedExercise.targetWeightLbs).toBeUndefined();
    expect(body.plannedExercise.targetRpe).toBeUndefined();
    expect(body.plannedExercise.restSec).toBeUndefined();
    expect(body.plannedExercise.notes).toBeUndefined();
  });
});

describe('plan.exercise.list_for_template', () => {
  it('returns store-ordered planned exercises for a template', async () => {
    const h = setup();
    const exes: StoredPlannedExercise[] = [
      {
        id: 'pe1',
        workoutTemplateId: 't1',
        exerciseId: 'bench-press',
        orderIndex: 0,
        targetSets: 3,
      },
      {
        id: 'pe2',
        workoutTemplateId: 't1',
        exerciseId: 'row',
        orderIndex: 1,
        targetSets: 3,
      },
    ];
    h.store.getPlannedExercisesForTemplate.mockResolvedValueOnce(exes);
    const r = await h.invoke('plan.exercise.list_for_template', { workoutTemplateId: 't1' });
    expect(
      (parseResult(r) as { plannedExercises: StoredPlannedExercise[] }).plannedExercises,
    ).toEqual(exes);
    expect(h.store.getPlannedExercisesForTemplate).toHaveBeenCalledWith('t1');
  });
});

// ─── Cascade deletion (direct sqlite) ─────────────────────────────────────
//
// No tool currently issues a hard delete on a program — `plan.program.archive`
// is a soft-delete that preserves the row. The schema's `ON DELETE CASCADE`
// constraints are still load-bearing once a future tool exposes hard delete,
// so this test exercises them against a real `:memory:` store via the
// underlying `node:sqlite` handle.
describe('plan deletion cascade (schema-level guarantee)', () => {
  it('deleting a program removes its blocks/weeks/templates/exercises', async () => {
    const store = SqliteSessionStore.open(':memory:');
    try {
      await store.putTrainingProgram({
        id: 'p1',
        name: 'Test program',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      await store.putTrainingBlock({
        id: 'b1',
        programId: 'p1',
        orderIndex: 0,
        name: 'Block',
        weeksCount: 1,
      });
      await store.putTrainingWeek({ id: 'w1', blockId: 'b1', orderIndex: 0 });
      await store.putWorkoutTemplate({
        id: 't1',
        weekId: 'w1',
        name: 'Template',
        orderIndex: 0,
      });
      await store.putPlannedExercise({
        id: 'pe1',
        workoutTemplateId: 't1',
        exerciseId: 'bench-press',
        orderIndex: 0,
        targetSets: 3,
      });

      // Sanity: everything is persisted before the cascade.
      expect(await store.getTrainingProgram('p1')).toBeDefined();
      expect((await store.getTrainingBlocksForProgram('p1')).length).toBe(1);
      expect((await store.getTrainingWeeksForBlock('b1')).length).toBe(1);
      expect(await store.getWorkoutTemplate('t1')).toBeDefined();
      expect((await store.getPlannedExercisesForTemplate('t1')).length).toBe(1);

      // Reach into the private DatabaseSync handle to issue the hard delete.
      // No public tool wraps this today — that's why the test pokes through.
      const db = (
        store as unknown as {
          db: {
            prepare(sql: string): { run(...params: unknown[]): unknown };
            exec(sql: string): unknown;
          };
        }
      ).db;
      // Defensive: ensure FK enforcement is on for THIS connection. The
      // store's open() sets it once, but we want a clear contract for the
      // cascade assertion.
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare('DELETE FROM training_programs WHERE id = ?').run('p1');

      expect(await store.getTrainingProgram('p1')).toBeUndefined();
      expect((await store.getTrainingBlocksForProgram('p1')).length).toBe(0);
      expect((await store.getTrainingWeeksForBlock('b1')).length).toBe(0);
      expect(await store.getWorkoutTemplate('t1')).toBeUndefined();
      expect((await store.getPlannedExercisesForTemplate('t1')).length).toBe(0);
    } finally {
      await store.close();
    }
  });
});
