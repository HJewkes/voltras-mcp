// Route-level tests for the plan builder + session completion endpoints (VW-120).
//
// These run the real `node:http` server against an in-memory store fake, so the
// method gate, the body parser, the route table, and the `PlanApiError` → status
// mapping are all exercised end to end. The pure shaping is covered separately
// in `plan-tree-read-model.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSession,
  StoredSet,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

const handles: DashboardServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    await handles
      .pop()
      ?.close()
      .catch(() => undefined);
  }
});

/**
 * In-memory implementation of every store method the plan routes touch.
 * Ordering matches the sqlite store's contract (`ORDER BY order_index`) so the
 * read-model isn't accidentally covering for a store that returns rows unsorted.
 */
class FakePlanStore {
  readonly programs = new Map<string, StoredTrainingProgram>();
  readonly blocks = new Map<string, StoredTrainingBlock>();
  readonly weeks = new Map<string, StoredTrainingWeek>();
  readonly templates = new Map<string, StoredWorkoutTemplate>();
  readonly plannedExercises = new Map<string, StoredPlannedExercise>();
  readonly assignments = new Map<string, StoredProgramAssignment>();
  readonly sessions = new Map<string, StoredSession>();
  readonly setsBySession = new Map<string, StoredSet[]>();

  putTrainingProgram = async (p: StoredTrainingProgram): Promise<void> => {
    this.programs.set(p.id, p);
  };
  getTrainingProgram = async (id: string): Promise<StoredTrainingProgram | undefined> =>
    this.programs.get(id);
  listTrainingPrograms = async (opts?: {
    includeArchived?: boolean;
  }): Promise<StoredTrainingProgram[]> =>
    [...this.programs.values()]
      .filter((p) => opts?.includeArchived === true || p.archivedAt === undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  putTrainingBlock = async (b: StoredTrainingBlock): Promise<void> => {
    this.blocks.set(b.id, b);
  };
  getTrainingBlocksForProgram = async (programId: string): Promise<StoredTrainingBlock[]> =>
    ordered([...this.blocks.values()].filter((b) => b.programId === programId));

  putTrainingWeek = async (w: StoredTrainingWeek): Promise<void> => {
    this.weeks.set(w.id, w);
  };
  getTrainingWeeksForBlock = async (blockId: string): Promise<StoredTrainingWeek[]> =>
    ordered([...this.weeks.values()].filter((w) => w.blockId === blockId));

  putWorkoutTemplate = async (t: StoredWorkoutTemplate): Promise<void> => {
    this.templates.set(t.id, t);
  };
  getWorkoutTemplate = async (id: string): Promise<StoredWorkoutTemplate | undefined> =>
    this.templates.get(id);
  getWorkoutTemplatesForWeek = async (weekId: string): Promise<StoredWorkoutTemplate[]> =>
    ordered([...this.templates.values()].filter((t) => t.weekId === weekId));

  putPlannedExercise = async (e: StoredPlannedExercise): Promise<void> => {
    this.plannedExercises.set(e.id, e);
  };
  getPlannedExercise = async (id: string): Promise<StoredPlannedExercise | undefined> =>
    this.plannedExercises.get(id);
  getPlannedExercisesForTemplate = async (templateId: string): Promise<StoredPlannedExercise[]> =>
    ordered([...this.plannedExercises.values()].filter((e) => e.workoutTemplateId === templateId));

  putProgramAssignment = async (a: StoredProgramAssignment): Promise<void> => {
    this.assignments.set(a.id, a);
  };
  getAssignmentsForSession = async (sessionId: string): Promise<StoredProgramAssignment[]> =>
    [...this.assignments.values()].filter((a) => a.sessionId === sessionId);
  getAssignmentsForTemplate = async (templateId: string): Promise<StoredProgramAssignment[]> =>
    [...this.assignments.values()].filter((a) => a.workoutTemplateId === templateId);

  getSession = async (id: string): Promise<StoredSession | undefined> => this.sessions.get(id);
  getSetsForSession = async (sessionId: string): Promise<StoredSet[]> =>
    this.setsBySession.get(sessionId) ?? [];
  listSessions = async (filter: {
    sort: 'startedAt:desc' | 'startedAt:asc';
    limit: number;
    offset: number;
  }): Promise<StoredSession[]> =>
    [...this.sessions.values()]
      .sort((a, b) =>
        filter.sort === 'startedAt:desc'
          ? b.startedAt.localeCompare(a.startedAt)
          : a.startedAt.localeCompare(b.startedAt),
      )
      .slice(filter.offset, filter.offset + filter.limit);
}

function ordered<T extends { orderIndex: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.orderIndex - b.orderIndex);
}

const CATALOG = [
  {
    id: 'cable-row',
    name: 'Cable Row',
    muscleGroups: ['back'],
    movementPattern: 'horizontal-pull',
  },
  {
    id: 'cable-chest-press',
    name: 'Cable Chest Press',
    muscleGroups: ['chest'],
    movementPattern: 'horizontal-push',
  },
];

function makeState(
  store: FakePlanStore,
  session?: { sessionId: string; exerciseId?: string },
): DashboardServerState {
  const slots = new Map<
    string,
    DashboardServerState['slots'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  slots.set('primary', {
    live: {
      snapshotDevice: () => ({ connected: false }),
      snapshotSession: () =>
        session === undefined
          ? undefined
          : {
              sessionId: session.sessionId,
              startedAt: '2026-07-30T10:00:00.000Z',
              setIds: [],
              status: 'active' as const,
              ...(session.exerciseId !== undefined ? { exerciseId: session.exerciseId } : {}),
            },
      snapshotSet: () => undefined,
    },
  });
  return {
    slots,
    store,
    exercises: {
      getById: (id) => CATALOG.find((e) => e.id === id),
      list: () => CATALOG,
      search: (q) => CATALOG.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())),
      byMuscleGroup: (m) => CATALOG.filter((e) => e.muscleGroups.includes(m)),
    },
  };
}

interface Result {
  status: number;
  body: unknown;
}

async function call(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Result> {
  const raw = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      {
        host: DEFAULT_DASHBOARD_HOST,
        port,
        path,
        method,
        ...(raw === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

async function start(state: DashboardServerState): Promise<number> {
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

interface PlanTreeBody {
  programs: { id: string; name: string }[];
  program: {
    id: string;
    blocks: {
      weeks: { templates: { id: string; exercises: { id: string; name: string }[] }[] }[];
    }[];
  } | null;
  activeTemplateId: string | null;
  activeExerciseId: string | null;
}

/** First template of the (single-branch) tree the scaffold creates. */
function firstTemplate(tree: PlanTreeBody): {
  id: string;
  exercises: { id: string; name: string }[];
} {
  const template = tree.program?.blocks[0]?.weeks[0]?.templates[0];
  if (template === undefined) throw new Error('expected a scaffolded template');
  return template;
}

describe('GET /api/exercises', () => {
  it('returns the whole catalog, name-sorted', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = await call(port, 'GET', '/api/exercises');
    expect(res.status).toBe(200);
    expect((res.body as { exercises: { name: string }[] }).exercises.map((e) => e.name)).toEqual([
      'Cable Chest Press',
      'Cable Row',
    ]);
  });

  it('filters by free-text query and by muscle group', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const byQuery = (await call(port, 'GET', '/api/exercises?q=row')).body as {
      exercises: { id: string }[];
    };
    expect(byQuery.exercises.map((e) => e.id)).toEqual(['cable-row']);
    const byMuscle = (await call(port, 'GET', '/api/exercises?muscle=chest')).body as {
      exercises: { id: string }[];
    };
    expect(byMuscle.exercises.map((e) => e.id)).toEqual(['cable-chest-press']);
  });

  it('honours ?limit=', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = (await call(port, 'GET', '/api/exercises?limit=1')).body as {
      exercises: unknown[];
    };
    expect(res.exercises).toHaveLength(1);
  });
});

describe('plan write routes', () => {
  it('creates a program with a block/week/workout scaffold ready for exercises', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    const created = await call(port, 'POST', '/api/plan/programs', { name: 'Base Build' });
    expect(created.status).toBe(201);
    expect(store.programs.size).toBe(1);
    expect(store.blocks.size).toBe(1);
    expect(store.weeks.size).toBe(1);
    expect(store.templates.size).toBe(1);

    const tree = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    expect(firstTemplate(tree).exercises).toEqual([]);
  });

  it('rejects a program with no name', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = await call(port, 'POST', '/api/plan/programs', {});
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_input');
  });

  it('appends planned exercises to a template in add order', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'Base Build' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;

    await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      targetSets: 4,
      targetRepsLow: 8,
      targetRepsHigh: 12,
    });
    await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-chest-press',
    });

    const tree = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    expect(firstTemplate(tree).exercises.map((e) => e.name)).toEqual([
      'Cable Row',
      'Cable Chest Press',
    ]);
  });

  it('404s when adding an exercise to a template that does not exist', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = await call(port, 'POST', '/api/plan/templates/nope/exercises', {
      exerciseId: 'cable-row',
    });
    expect(res.status).toBe(404);
  });

  it('edits one exercise’s targets without disturbing the others', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    const created = (await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      targetSets: 3,
      targetRepsLow: 8,
    })) as { body: { plannedExercise: StoredPlannedExercise } };

    const patched = await call(
      port,
      'PATCH',
      `/api/plan/exercises/${created.body.plannedExercise.id}`,
      {
        targetWeightLbs: 135,
      },
    );
    expect(patched.status).toBe(200);
    const row = store.plannedExercises.get(created.body.plannedExercise.id);
    expect(row?.targetWeightLbs).toBe(135);
    // Untouched fields survive the PATCH — a full-row PUT would have blanked them.
    expect(row?.targetRepsLow).toBe(8);
    expect(row?.targetSets).toBe(3);
  });

  it('reorders a template’s exercises', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    for (const exerciseId of ['cable-row', 'cable-chest-press']) {
      await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, { exerciseId });
    }
    const before = firstTemplate((await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody);
    const reversed = [...before.exercises].reverse().map((e) => e.id);

    const res = await call(port, 'POST', `/api/plan/templates/${templateId}/reorder`, {
      plannedExerciseIds: reversed,
    });
    expect(res.status).toBe(200);
    const after = firstTemplate((await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody);
    expect(after.exercises.map((e) => e.name)).toEqual(['Cable Chest Press', 'Cable Row']);
  });

  it('rejects a reorder naming an exercise from another template', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    const res = await call(port, 'POST', `/api/plan/templates/${templateId}/reorder`, {
      plannedExerciseIds: ['not-mine'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body before touching the store', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    const res = await new Promise<Result>((resolve, reject) => {
      const req = httpRequest(
        { host: DEFAULT_DASHBOARD_HOST, port, path: '/api/plan/programs', method: 'POST' },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write('{not json');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(store.programs.size).toBe(0);
  });

  it('still rejects unsupported methods', async () => {
    const port = await start(makeState(new FakePlanStore()));
    expect((await call(port, 'DELETE', '/api/plan/programs')).status).toBe(405);
  });

  it('404s an unknown write path', async () => {
    const port = await start(makeState(new FakePlanStore()));
    expect((await call(port, 'POST', '/api/plan/nope', {})).status).toBe(404);
  });
});

describe('GET /api/plan-tree', () => {
  it('flags the template and exercise the live session is on', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store, { sessionId: 'sess-1', exerciseId: 'cable-row' }));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    await store.putProgramAssignment({
      id: 'asg-1',
      sessionId: 'sess-1',
      workoutTemplateId: templateId,
      assignedAt: '2026-07-30T10:05:00.000Z',
    });

    const tree = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    expect(tree.activeTemplateId).toBe(templateId);
    expect(tree.activeExerciseId).toBe('cable-row');
  });

  it('501s when the wired store carries no planning methods', async () => {
    const port = await start({
      slots: new Map(),
      store: { listSessions: async () => [] },
    });
    expect((await call(port, 'GET', '/api/plan-tree')).status).toBe(501);
    expect((await call(port, 'POST', '/api/plan/programs', { name: 'P' })).status).toBe(501);
  });
});

describe('GET /api/session-summary/:sessionId', () => {
  function withSession(store: FakePlanStore): FakePlanStore {
    store.sessions.set('sess-1', {
      id: 'sess-1',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt: '2026-07-30T11:00:00.000Z',
      status: 'ended',
    } as StoredSession);
    return store;
  }

  it('summarises a session by id', async () => {
    const port = await start(makeState(withSession(new FakePlanStore())));
    const res = await call(port, 'GET', '/api/session-summary/sess-1');
    expect(res.status).toBe(200);
    expect((res.body as { session: { id: string } }).session.id).toBe('sess-1');
  });

  it('resolves `latest` to the most recent session', async () => {
    const port = await start(makeState(withSession(new FakePlanStore())));
    const res = await call(port, 'GET', '/api/session-summary/latest');
    expect(res.status).toBe(200);
    expect((res.body as { session: { id: string } }).session.id).toBe('sess-1');
  });

  it('404s an unknown session id and a `latest` with no sessions at all', async () => {
    const port = await start(makeState(withSession(new FakePlanStore())));
    expect((await call(port, 'GET', '/api/session-summary/ghost')).status).toBe(404);
    const emptyPort = await start(makeState(new FakePlanStore()));
    expect((await call(emptyPort, 'GET', '/api/session-summary/latest')).status).toBe(404);
  });

  it('501s without a planning store', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    expect((await call(port, 'GET', '/api/session-summary/latest')).status).toBe(501);
  });
});
