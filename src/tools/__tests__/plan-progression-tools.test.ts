// Unit tests for the four progression tools added on top of the W3 schema +
// T33 CRUD layer:
//
//   * plan.next_workout         — walks the program tree, returns the first
//                                 template without a ProgramAssignment row
//   * plan.complete_workout     — writes a ProgramAssignment row idempotently
//                                 against the active session (or a supplied
//                                 sessionId)
//   * plan.attach_to_session    — links a session to a planned exercise OR
//                                 a workout template (XOR via Zod refine)
//   * plan.suggest_progression  — reads the most-recent completed session for
//                                 an exercise and proposes a +5/0/-5 lb delta
//                                 based on rep-target hit/miss
//
// The mock-store factory mirrors the one in `plan-tools.test.ts`. Where
// `findPlannedExerciseInProgram` / `findPlannedExerciseById` walk the
// program tree, the test fixtures pre-load the right rows into the in-memory
// stubs so the walk resolves deterministically.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerState, SlotState } from '../../state/server-state.js';
import type {
  SessionStore,
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSession,
  StoredSet,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

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
const { PRIMARY_SLOT } = await import('../../state/server-state.js');

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
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
];

function makeFakePlaceholders(): {
  placeholders: Map<string, FakeRegisteredTool>;
  invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >;
} {
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
  const invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  > = {};
  for (const name of TOOL_NAMES) {
    invokers[name] = async (args: unknown) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
  }
  return { placeholders, invokers };
}

function makeStore(): SessionStore & {
  getSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  getSetsForSession: ReturnType<typeof vi.fn>;
  putTrainingProgram: ReturnType<typeof vi.fn>;
  getTrainingProgram: ReturnType<typeof vi.fn>;
  listTrainingPrograms: ReturnType<typeof vi.fn>;
  getTrainingBlocksForProgram: ReturnType<typeof vi.fn>;
  getTrainingWeeksForBlock: ReturnType<typeof vi.fn>;
  getWorkoutTemplate: ReturnType<typeof vi.fn>;
  getWorkoutTemplatesForWeek: ReturnType<typeof vi.fn>;
  getPlannedExercisesForTemplate: ReturnType<typeof vi.fn>;
  putProgramAssignment: ReturnType<typeof vi.fn>;
  getAssignmentsForSession: ReturnType<typeof vi.fn>;
  getAssignmentsForTemplate: ReturnType<typeof vi.fn>;
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
    getAssignmentsForTemplate: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

interface Harness {
  state: ServerState;
  store: ReturnType<typeof makeStore>;
  /** Mutate to install/clear an active session on the primary slot. */
  setActiveSession(sessionId: string | undefined): void;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function setup(): Harness {
  const store = makeStore();
  // Minimal slot state: only `live.session` is read by the progression
  // handlers. We model `live` as a bare object with a mutable `session` slot.
  const slot = {
    slotId: PRIMARY_SLOT,
    live: { session: undefined } as { session: { sessionId: string } | undefined },
  } as unknown as SlotState;
  const slots = new Map<string, SlotState>();
  slots.set(PRIMARY_SLOT, slot);
  const state = { store, slots } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders();
  const server = { tool: vi.fn() } as unknown as FakeServer;
  registerPlanTools(
    server as unknown as Parameters<typeof registerPlanTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerPlanTools>[2],
  );
  return {
    state,
    store,
    setActiveSession(sessionId) {
      const live = (slots.get(PRIMARY_SLOT) as unknown as { live: { session: unknown } }).live;
      live.session = sessionId === undefined ? undefined : { sessionId };
    },
    invoke: (name, args) => invokers[name](args),
  };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

const PROGRAM_A: StoredTrainingProgram = {
  id: 'prog-a',
  name: 'Program A',
  createdAt: '2025-02-01T00:00:00.000Z',
};
const PROGRAM_B: StoredTrainingProgram = {
  id: 'prog-b',
  name: 'Program B',
  createdAt: '2025-03-01T00:00:00.000Z',
};

const BLOCK_1: StoredTrainingBlock = {
  id: 'block-1',
  programId: 'prog-a',
  orderIndex: 0,
  name: 'Block 1',
  weeksCount: 1,
};

const WEEK_1: StoredTrainingWeek = { id: 'week-1', blockId: 'block-1', orderIndex: 0 };

const TMPL_1: StoredWorkoutTemplate = {
  id: 'tmpl-1',
  weekId: 'week-1',
  name: 'Upper A',
  orderIndex: 0,
};
const TMPL_2: StoredWorkoutTemplate = {
  id: 'tmpl-2',
  weekId: 'week-1',
  name: 'Upper B',
  orderIndex: 1,
};

const PE_BENCH: StoredPlannedExercise = {
  id: 'pe-bench',
  workoutTemplateId: 'tmpl-1',
  exerciseId: 'bench-press',
  orderIndex: 0,
  targetSets: 3,
  targetRepsLow: 8,
  targetRepsHigh: 12,
  targetWeightLbs: 135,
};

// ─── plan.next_workout ─────────────────────────────────────────────────────
describe('plan.next_workout', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns NO_PROGRAM_FOUND when no programs exist', async () => {
    h.store.listTrainingPrograms.mockResolvedValueOnce([]);
    const r = await h.invoke('plan.next_workout', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_PROGRAM_FOUND');
  });

  it('returns NOT_FOUND when an explicit programId does not exist', async () => {
    h.store.getTrainingProgram.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.next_workout', { programId: 'nope' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns { ok: true, completed: true } when every template has an assignment', async () => {
    h.store.getTrainingProgram.mockResolvedValueOnce(PROGRAM_A);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([BLOCK_1]);
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce([WEEK_1]);
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce([TMPL_1, TMPL_2]);
    // Both templates have at least one assignment.
    h.store.getAssignmentsForTemplate.mockImplementation(async (id: string) => [
      {
        id: `a-${id}`,
        sessionId: 'sess-x',
        workoutTemplateId: id,
        assignedAt: '2025-02-10T00:00:00.000Z',
      } as StoredProgramAssignment,
    ]);
    const r = await h.invoke('plan.next_workout', { programId: 'prog-a' });
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ ok: true, completed: true });
  });

  it('returns the first uncompleted template with its block, week, and planned exercises', async () => {
    h.store.getTrainingProgram.mockResolvedValueOnce(PROGRAM_A);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([BLOCK_1]);
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce([WEEK_1]);
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce([TMPL_1, TMPL_2]);
    // tmpl-1 is done; tmpl-2 is open.
    h.store.getAssignmentsForTemplate.mockImplementation(async (id: string) =>
      id === 'tmpl-1'
        ? [
            {
              id: 'a1',
              sessionId: 'sess-x',
              workoutTemplateId: 'tmpl-1',
              assignedAt: '2025-02-10T00:00:00.000Z',
            } as StoredProgramAssignment,
          ]
        : [],
    );
    h.store.getPlannedExercisesForTemplate.mockResolvedValueOnce([PE_BENCH]);
    const r = await h.invoke('plan.next_workout', { programId: 'prog-a' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      template: StoredWorkoutTemplate;
      plannedExercises: StoredPlannedExercise[];
      block: StoredTrainingBlock;
      week: StoredTrainingWeek;
    };
    expect(body.template).toEqual(TMPL_2);
    expect(body.block).toEqual(BLOCK_1);
    expect(body.week).toEqual(WEEK_1);
    expect(body.plannedExercises).toEqual([PE_BENCH]);
  });

  it('defaults to the most-recent non-archived program when programId is omitted', async () => {
    // Store sorts by created_at DESC, so PROGRAM_B (newer) comes first.
    h.store.listTrainingPrograms.mockResolvedValueOnce([PROGRAM_B, PROGRAM_A]);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([]);
    const r = await h.invoke('plan.next_workout', {});
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ ok: true, completed: true });
    // Confirm we read from the latest program, not the older one.
    expect(h.store.listTrainingPrograms).toHaveBeenCalledWith({ includeArchived: false });
    expect(h.store.getTrainingBlocksForProgram).toHaveBeenCalledWith('prog-b');
  });
});

// ─── plan.complete_workout ─────────────────────────────────────────────────
describe('plan.complete_workout', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('writes a ProgramAssignment row using the active session when sessionId is omitted', async () => {
    h.setActiveSession('sess-active');
    const session: StoredSession = { id: 'sess-active', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);
    const r = await h.invoke('plan.complete_workout', { workoutTemplateId: 'tmpl-1' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { assignment: StoredProgramAssignment };
    expect(body.assignment.sessionId).toBe('sess-active');
    expect(body.assignment.workoutTemplateId).toBe('tmpl-1');
    expect(typeof body.assignment.id).toBe('string');
    expect(typeof body.assignment.assignedAt).toBe('string');
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);
  });

  it('returns NO_ACTIVE_SESSION when no session is active and none is supplied', async () => {
    h.setActiveSession(undefined);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);
    const r = await h.invoke('plan.complete_workout', { workoutTemplateId: 'tmpl-1' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SESSION');
    expect(h.store.putProgramAssignment).not.toHaveBeenCalled();
  });

  // VMCP-02.36: bilateral setups bind `left` + `right` with no `primary`. The
  // old primary-only lookup threw on the missing slot and returned a false
  // NO_ACTIVE_SESSION. The slot scan now resolves a shared session and flags a
  // genuinely ambiguous one.
  const mkBareSlot = (slotId: string, sessionId: string): SlotState =>
    ({ slotId, live: { session: { sessionId } } }) as unknown as SlotState;

  it('VMCP-02.36: resolves the active session on a bilateral setup (left+right, no primary)', async () => {
    const slots = h.state.slots;
    slots.clear();
    slots.set('left', mkBareSlot('left', 'sess-bi'));
    slots.set('right', mkBareSlot('right', 'sess-bi'));
    const session: StoredSession = { id: 'sess-bi', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);

    const r = await h.invoke('plan.complete_workout', { workoutTemplateId: 'tmpl-1' });
    expect(r.isError).toBeUndefined();
    expect((parseResult(r) as { assignment: StoredProgramAssignment }).assignment.sessionId).toBe(
      'sess-bi',
    );
  });

  it('VMCP-02.36: returns AMBIGUOUS_SESSION when slots carry distinct active sessions', async () => {
    const slots = h.state.slots;
    slots.clear();
    slots.set('left', mkBareSlot('left', 'sess-left'));
    slots.set('right', mkBareSlot('right', 'sess-right'));

    const r = await h.invoke('plan.complete_workout', { workoutTemplateId: 'tmpl-1' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('AMBIGUOUS_SESSION');
    expect(h.store.putProgramAssignment).not.toHaveBeenCalled();
  });

  it('VMCP-02.36: an explicit sessionId still wins over the slot scan', async () => {
    const slots = h.state.slots;
    slots.clear();
    slots.set('left', mkBareSlot('left', 'sess-left'));
    slots.set('right', mkBareSlot('right', 'sess-right'));
    const session: StoredSession = { id: 'sess-explicit', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);

    const r = await h.invoke('plan.complete_workout', {
      workoutTemplateId: 'tmpl-1',
      sessionId: 'sess-explicit',
    });
    expect(r.isError).toBeUndefined();
    expect((parseResult(r) as { assignment: StoredProgramAssignment }).assignment.sessionId).toBe(
      'sess-explicit',
    );
  });

  it('returns NOT_FOUND when the workout template does not exist', async () => {
    h.store.getWorkoutTemplate.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.complete_workout', {
      workoutTemplateId: 'nope',
      sessionId: 'sess-1',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when the session does not exist', async () => {
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);
    h.store.getSession.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.complete_workout', {
      workoutTemplateId: 'tmpl-1',
      sessionId: 'nope',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('is idempotent — calling twice returns the existing assignment without writing a duplicate', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getWorkoutTemplate.mockResolvedValue(TMPL_1);
    h.store.getSession.mockResolvedValue(session);
    // First call: no prior assignment.
    h.store.getAssignmentsForSession.mockResolvedValueOnce([]);
    const first = await h.invoke('plan.complete_workout', {
      workoutTemplateId: 'tmpl-1',
      sessionId: 'sess-1',
    });
    const firstBody = parseResult(first) as { assignment: StoredProgramAssignment };
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);

    // Second call: the prior assignment exists.
    h.store.getAssignmentsForSession.mockResolvedValueOnce([firstBody.assignment]);
    const second = await h.invoke('plan.complete_workout', {
      workoutTemplateId: 'tmpl-1',
      sessionId: 'sess-1',
    });
    expect(second.isError).toBeUndefined();
    const secondBody = parseResult(second) as { assignment: StoredProgramAssignment };
    expect(secondBody.assignment).toEqual(firstBody.assignment);
    // No second write — the count is unchanged.
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);
  });
});

// ─── plan.attach_to_session ────────────────────────────────────────────────
describe('plan.attach_to_session', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('rejects INVALID_INPUT when both ids are provided', async () => {
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe-1',
      workoutTemplateId: 'tmpl-1',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('rejects INVALID_INPUT when neither id is provided', async () => {
    const r = await h.invoke('plan.attach_to_session', { sessionId: 'sess-1' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('attaches when only plannedExerciseId is provided', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    // findPlannedExerciseById walks every program → blocks → weeks →
    // templates → planned. Only the planned-exercise list returns a hit.
    h.store.listTrainingPrograms.mockResolvedValueOnce([PROGRAM_A]);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([BLOCK_1]);
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce([WEEK_1]);
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce([TMPL_1]);
    h.store.getPlannedExercisesForTemplate.mockResolvedValueOnce([PE_BENCH]);
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe-bench',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { assignment: StoredProgramAssignment };
    expect(body.assignment.sessionId).toBe('sess-1');
    expect(body.assignment.plannedExerciseId).toBe('pe-bench');
    expect(body.assignment.workoutTemplateId).toBeUndefined();
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);
  });

  it('attaches when only workoutTemplateId is provided', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(TMPL_1);
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      workoutTemplateId: 'tmpl-1',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { assignment: StoredProgramAssignment };
    expect(body.assignment.sessionId).toBe('sess-1');
    expect(body.assignment.workoutTemplateId).toBe('tmpl-1');
    expect(body.assignment.plannedExerciseId).toBeUndefined();
  });

  it('returns NOT_FOUND when the session is unknown', async () => {
    h.store.getSession.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'nope',
      workoutTemplateId: 'tmpl-1',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when plannedExerciseId is unknown', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    // Walk yields no matching planned exercise.
    h.store.listTrainingPrograms.mockResolvedValueOnce([PROGRAM_A]);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([]);
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe-nope',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when workoutTemplateId is unknown', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValueOnce(session);
    h.store.getWorkoutTemplate.mockResolvedValueOnce(undefined);
    const r = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      workoutTemplateId: 'tmpl-nope',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('is idempotent — calling twice with the same (sessionId, plannedExerciseId) returns the existing row without writing a duplicate', async () => {
    const session: StoredSession = { id: 'sess-1', startedAt: '2025-02-10T00:00:00.000Z' };
    h.store.getSession.mockResolvedValue(session);
    // First call: no prior assignment; walk finds PE_BENCH.
    h.store.getAssignmentsForSession.mockResolvedValueOnce([]);
    h.store.listTrainingPrograms.mockResolvedValueOnce([PROGRAM_A]);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([BLOCK_1]);
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce([WEEK_1]);
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce([TMPL_1]);
    h.store.getPlannedExercisesForTemplate.mockResolvedValueOnce([PE_BENCH]);
    const first = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe-bench',
    });
    expect(first.isError).toBeUndefined();
    const firstBody = parseResult(first) as { assignment: StoredProgramAssignment };
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);

    // Second call: the prior assignment is returned by getAssignmentsForSession.
    h.store.getAssignmentsForSession.mockResolvedValueOnce([firstBody.assignment]);
    const second = await h.invoke('plan.attach_to_session', {
      sessionId: 'sess-1',
      plannedExerciseId: 'pe-bench',
    });
    expect(second.isError).toBeUndefined();
    const secondBody = parseResult(second) as { assignment: StoredProgramAssignment };
    // Same row returned, no additional write.
    expect(secondBody.assignment).toEqual(firstBody.assignment);
    expect(h.store.putProgramAssignment).toHaveBeenCalledTimes(1);
  });
});

// ─── plan.suggest_progression ──────────────────────────────────────────────
describe('plan.suggest_progression', () => {
  /**
   * Build a StoredSet with `repCount` reps. By default every rep carries the
   * same peak concentric velocity (flat profile → 0% velocity loss → no VMCP-
   * 02.25 VBT override), so rep-band tests are unaffected. Pass `peakVelocities`
   * (one per rep) to model an intra-set velocity decline for the fatigue guard.
   */
  function setWithReps(
    setId: string,
    repCount: number,
    peakVelocities?: number[],
    weightLbs = 135,
  ): StoredSet {
    return {
      id: setId,
      sessionId: 'sess-prior',
      startedAt: '2025-02-09T00:00:00.000Z',
      endedAt: '2025-02-09T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs,
      reps: Array.from(
        { length: repCount },
        (_, i) =>
          ({
            id: `r${i}`,
            setId,
            index: i,
            concentric: { peakVelocity: peakVelocities?.[i] ?? 800 },
          }) as StoredSet['reps'][number],
      ),
    };
  }

  function primeProgramWithBenchPlan(h: Harness): void {
    h.store.getTrainingProgram.mockResolvedValueOnce(PROGRAM_A);
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([BLOCK_1]);
    h.store.getTrainingWeeksForBlock.mockResolvedValueOnce([WEEK_1]);
    h.store.getWorkoutTemplatesForWeek.mockResolvedValueOnce([TMPL_1]);
    h.store.getPlannedExercisesForTemplate.mockResolvedValueOnce([PE_BENCH]);
  }

  it('returns delta:0 / basedOnSessionId:null when no prior session exists', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      plannedExercise: StoredPlannedExercise;
      suggestion: { delta: number; reasoning: string; basedOnSessionId: string | null };
    };
    expect(body.plannedExercise).toEqual(PE_BENCH);
    expect(body.suggestion.delta).toBe(0);
    expect(body.suggestion.basedOnSessionId).toBeNull();
    expect(body.suggestion.reasoning.length).toBeGreaterThan(0);
  });

  it('suggests +5 lb when the majority of sets hit targetRepsHigh', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    // 3 sets, all 12 reps (== targetRepsHigh).
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('s1', 12),
      setWithReps('s2', 12),
      setWithReps('s3', 12),
    ]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      suggestion: { delta: number; reasoning: string; basedOnSessionId: string | null };
    };
    expect(body.suggestion.delta).toBe(5);
    expect(body.suggestion.basedOnSessionId).toBe('sess-prior');
    expect(body.suggestion.reasoning.length).toBeGreaterThan(0);
  });

  it('VMCP-02.25: holds (not +5) when a set hit its reps but at high velocity loss', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    // 1 set, 12 reps (== targetRepsHigh, so rep-count alone says +5), but peak
    // concentric velocity decays 1000 -> 500 mm/s = 50% loss (functional
    // failure). The VBT layer must override the increment to a hold.
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('s1', 12, [1000, 960, 920, 880, 840, 800, 760, 710, 660, 600, 550, 500]),
    ]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { suggestion: { delta: number; reasoning: string } };
    expect(body.suggestion.delta).toBe(0);
    expect(body.suggestion.reasoning.toLowerCase()).toContain('velocity');
  });

  it('VMCP-02.25: still suggests +5 when reps are hit with only mild velocity loss', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    // 3 sets of 12, peak velocity decays only 1000 -> 920 (~8% loss, under the
    // 25% ceiling) — the rep-band increment stands.
    const mild = [1000, 985, 970, 955, 940, 932, 928, 924, 922, 921, 920, 920];
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('s1', 12, mild),
      setWithReps('s2', 12, mild),
      setWithReps('s3', 12, mild),
    ]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { suggestion: { delta: number } };
    expect(body.suggestion.delta).toBe(5);
  });

  it('suggests 0 lb (hold) when sets land in the rep band', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    // 3 sets, all 10 reps (between 8 and 12).
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('s1', 10),
      setWithReps('s2', 10),
      setWithReps('s3', 10),
    ]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      suggestion: { delta: number; reasoning: string; basedOnSessionId: string | null };
    };
    expect(body.suggestion.delta).toBe(0);
    expect(body.suggestion.reasoning.length).toBeGreaterThan(0);
  });

  it('suggests -5 lb when the majority of sets miss targetRepsLow', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    // 3 sets, all 5 reps (below 8).
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('s1', 5),
      setWithReps('s2', 5),
      setWithReps('s3', 5),
    ]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      suggestion: { delta: number; reasoning: string; basedOnSessionId: string | null };
    };
    expect(body.suggestion.delta).toBe(-5);
    expect(body.suggestion.reasoning.length).toBeGreaterThan(0);
  });

  // VMCP-progression-warmups: warmups log through the same set path as working
  // sets and carry no warmup flag, so the heuristic must exclude them by load
  // (session top load) — otherwise light, low-rep warmups poison the rep tally.
  it('VMCP-progression-warmups: does NOT deload when warmups sit below two top-rep working sets', async () => {
    // Arrange: 3 ramp-up warmups (3/3/5 reps at 45/95/115 lb) + 2 working sets
    // (12/12 reps at 135 lb) against the 3×8-12 bench plan. Counting all five
    // sets yields missed=3 >= majority=3 → a bogus -5 deload despite both
    // working sets topping the band.
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('w1', 3, undefined, 45),
      setWithReps('w2', 3, undefined, 95),
      setWithReps('w3', 5, undefined, 115),
      setWithReps('s1', 12, undefined, 135),
      setWithReps('s2', 12, undefined, 135),
    ]);

    // Act
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });

    // Assert: both working sets topped the band → increment, never a deload.
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { suggestion: { delta: number } };
    expect(body.suggestion.delta).not.toBe(-5);
    expect(body.suggestion.delta).toBe(5);
  });

  it('VMCP-progression-warmups: still deloads when the top-load working sets genuinely miss', async () => {
    // Arrange: same warmup ramp, but the 3 working sets at 135 lb only hit 5
    // reps (below the low band of 8). A real deload must survive the filter.
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    h.store.getSetsForSession.mockResolvedValueOnce([
      setWithReps('w1', 3, undefined, 45),
      setWithReps('w2', 5, undefined, 95),
      setWithReps('s1', 5, undefined, 135),
      setWithReps('s2', 5, undefined, 135),
      setWithReps('s3', 5, undefined, 135),
    ]);

    // Act
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });

    // Assert
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { suggestion: { delta: number } };
    expect(body.suggestion.delta).toBe(-5);
  });

  // VMCP-progression-warmups: the load heuristic alone can't catch a warmup
  // performed AT working weight (a heavy low-rep primer). The explicit
  // `role: 'warmup'` marker must exclude it so it can't poison the tally.
  it('VMCP-progression-warmups: excludes role:warmup sets even at the session top load', async () => {
    // Arrange: 3 warmups at 135 lb (== working weight) with only 3 reps each +
    // 2 working sets at 135 lb × 12 reps. By load alone all five sit at top
    // load → missed=3 >= majority=3 → a bogus -5 deload. The role marker must
    // drop the three warmups, leaving two band-topping working sets.
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.listSessions.mockResolvedValueOnce([
      { id: 'sess-prior', startedAt: '2025-02-09T00:00:00.000Z' },
    ]);
    const warmup = (setId: string): StoredSet => ({
      ...setWithReps(setId, 3, undefined, 135),
      role: 'warmup',
    });
    h.store.getSetsForSession.mockResolvedValueOnce([
      warmup('w1'),
      warmup('w2'),
      warmup('w3'),
      setWithReps('s1', 12, undefined, 135),
      setWithReps('s2', 12, undefined, 135),
    ]);

    // Act
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
    });

    // Assert: warmups excluded → both working sets topped the band.
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { suggestion: { delta: number } };
    expect(body.suggestion.delta).not.toBe(-5);
    expect(body.suggestion.delta).toBe(5);
  });

  it('returns NOT_FOUND when no planned exercise matches the exerciseId', async () => {
    const h = setup();
    h.store.getTrainingProgram.mockResolvedValueOnce(PROGRAM_A);
    // No blocks → no walk → no planned exercise.
    h.store.getTrainingBlocksForProgram.mockResolvedValueOnce([]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'unknown-exercise',
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('uses the supplied completedSessionId when provided', async () => {
    const h = setup();
    primeProgramWithBenchPlan(h);
    h.store.getSession.mockResolvedValueOnce({
      id: 'sess-explicit',
      startedAt: '2025-02-08T00:00:00.000Z',
    });
    h.store.getSetsForSession.mockResolvedValueOnce([setWithReps('s1', 12), setWithReps('s2', 12)]);
    const r = await h.invoke('plan.suggest_progression', {
      programId: 'prog-a',
      exerciseId: 'bench-press',
      completedSessionId: 'sess-explicit',
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as {
      suggestion: { delta: number; basedOnSessionId: string | null };
    };
    expect(body.suggestion.basedOnSessionId).toBe('sess-explicit');
    expect(body.suggestion.delta).toBe(5);
    expect(h.store.listSessions).not.toHaveBeenCalled();
  });
});
