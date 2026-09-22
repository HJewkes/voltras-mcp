// Route-level tests for the plan builder + session completion endpoints (VW-120).
//
// These run the real `node:http` server against an in-memory store fake, so the
// method gate, the body parser, the route table, and the `PlanApiError` → status
// mapping are all exercised end to end. The pure shaping is covered separately
// in `plan-tree-read-model.test.ts`.
//
// Every write below goes through the VW-500 guard, and `call` gets its token the
// way the SPA does — from `GET /api/bootstrap`. So the whole builder flow in
// this file doubles as the proof that the legitimate flow still works guarded.
// The guard's own rule table is unit-tested in `write-guard.test.ts`; the
// per-route refusals live at the bottom of this file.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { z } from 'zod';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { WRITE_TOKEN_HEADER } from '../write-guard.js';
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
  deletePlannedExercise = async (id: string): Promise<boolean> => this.plannedExercises.delete(id);
  // No block here is dated (VW-475), so the current-block rule falls back to work remaining.
  getLiveBlockSchedule = async (): Promise<undefined> => undefined;

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
  getSetsForExercise = async (filter: { exerciseId: string }): Promise<StoredSet[]> =>
    [...this.setsBySession.values()].flat().filter((s) => s.exerciseId === filter.exerciseId);
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

/**
 * Call a route the way the SPA does. A write picks its token up from
 * `/api/bootstrap` first, exactly as a wall tab whose page predates a restart
 * does, and carries the same-origin `Origin` a browser would set.
 */
async function call(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Result> {
  if (method === 'GET') return callRaw(port, method, path, payload);
  // A write carries all three guard facts, a bodyless DELETE included: the
  // content type is what a cross-site form post can never set.
  return callRaw(port, method, path, payload, {
    origin: `http://${DEFAULT_DASHBOARD_HOST}:${port}`,
    'content-type': 'application/json',
    [WRITE_TOKEN_HEADER]: await bootstrapToken(port),
  });
}

/** The token the SPA would read from `/api/bootstrap`. */
async function bootstrapToken(port: number): Promise<string> {
  const res = await callRaw(port, 'GET', '/api/bootstrap');
  return (res.body as { token: string }).token;
}

/** Send exactly the headers given — nothing is added. Used by the guard tests. */
async function callRaw(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  const raw = payload === undefined ? undefined : JSON.stringify(payload);
  const sent = {
    ...headers,
    ...(raw === undefined || 'content-type' in headers
      ? {}
      : { 'content-type': 'application/json' }),
  };
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      {
        host: DEFAULT_DASHBOARD_HOST,
        port,
        path,
        method,
        headers: sent,
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

  // ── VW-121 regression: the delete route and the target gate ──────────────

  it('deletes a planned exercise and closes the gap in the template order', async () => {
    // The review double-clicked "Add" into four duplicate rows and found no way
    // to remove any of them: `SessionStore` had no planning delete at all.
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    const ids: string[] = [];
    for (const exerciseId of ['cable-row', 'cable-chest-press', 'cable-row']) {
      const created = (await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
        exerciseId,
      })) as { body: { plannedExercise: StoredPlannedExercise } };
      ids.push(created.body.plannedExercise.id);
    }

    const res = await call(port, 'DELETE', `/api/plan/exercises/${ids[1]}`);
    expect(res.status).toBe(200);
    expect(store.plannedExercises.has(ids[1])).toBe(false);

    // Survivors renumber 0..n-1, or the builder's "1. 2. 3." numbering skips.
    const survivors = await store.getPlannedExercisesForTemplate(templateId);
    expect(survivors.map((e) => e.id)).toEqual([ids[0], ids[2]]);
    expect(survivors.map((e) => e.orderIndex)).toEqual([0, 1]);
  });

  it('404s a delete of a planned exercise that does not exist', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    expect((await call(port, 'DELETE', '/api/plan/exercises/ghost')).status).toBe(404);
  });

  it('rejects an out-of-range target on create and on edit, and stores nothing', async () => {
    // `-999 lb` reached a real prescription and survived a reload, because both
    // sides only checked `Number.isFinite`. The server is the half that matters:
    // a client can be bypassed with one curl.
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;

    const badCreate = await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      targetWeightLbs: -999,
    });
    expect(badCreate.status).toBe(400);
    expect(store.plannedExercises.size).toBe(0);

    const created = (await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      targetSets: 3,
      targetWeightLbs: 135,
    })) as { body: { plannedExercise: StoredPlannedExercise } };
    const id = created.body.plannedExercise.id;

    for (const patch of [{ targetWeightLbs: -999 }, { targetSets: -1 }, { targetSets: 0 }]) {
      expect((await call(port, 'PATCH', `/api/plan/exercises/${id}`, patch)).status).toBe(400);
    }
    // The row is untouched by every rejected write.
    expect(store.plannedExercises.get(id)?.targetWeightLbs).toBe(135);
    expect(store.plannedExercises.get(id)?.targetSets).toBe(3);
  });

  it('rejects a rep band inverted against the values already stored', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const templateId = firstTemplate(
      (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody,
    ).id;
    const created = (await call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      targetRepsLow: 8,
      targetRepsHigh: 12,
    })) as { body: { plannedExercise: StoredPlannedExercise } };
    const id = created.body.plannedExercise.id;

    // Only `hi` moves; `lo = 8` comes from the stored row, so a patch-only check
    // sees one in-range number and lets an impossible band through.
    expect(
      (await call(port, 'PATCH', `/api/plan/exercises/${id}`, { targetRepsHigh: 4 })).status,
    ).toBe(400);
    expect(store.plannedExercises.get(id)?.targetRepsHigh).toBe(12);
    // A band that stays coherent still saves.
    expect(
      (await call(port, 'PATCH', `/api/plan/exercises/${id}`, { targetRepsHigh: 15 })).status,
    ).toBe(200);
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
    // Guard headers and all: the body parser is only reachable past the guard.
    const headers = await guardHeaders(port);
    const res = await new Promise<Result>((resolve, reject) => {
      const req = httpRequest(
        { host: DEFAULT_DASHBOARD_HOST, port, path: '/api/plan/programs', method: 'POST', headers },
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
    // PUT, not DELETE: VW-121 opened DELETE for `/api/plan/exercises/:id`, so
    // DELETE now falls through to a 404 on a path with no delete route.
    expect((await call(port, 'PUT', '/api/plan/programs')).status).toBe(405);
    expect((await call(port, 'DELETE', '/api/plan/programs')).status).toBe(404);
  });

  it('404s an unknown write path', async () => {
    const port = await start(makeState(new FakePlanStore()));
    expect((await call(port, 'POST', '/api/plan/nope', {})).status).toBe(404);
  });
});

// VW-537: the dashboard is the second of three write paths through the shared validator.
describe('plan write routes: the goal and the rest pair', () => {
  async function withTemplate(): Promise<{
    store: FakePlanStore;
    port: number;
    templateId: string;
  }> {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    await call(port, 'POST', '/api/plan/programs', { name: 'P' });
    const tree = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    return { store, port, templateId: firstTemplate(tree).id };
  }

  async function create(port: number, templateId: string, body: object): Promise<Result> {
    return call(port, 'POST', `/api/plan/templates/${templateId}/exercises`, {
      exerciseId: 'cable-row',
      ...body,
    });
  }

  it('defaults the goal kind on create and states learning on', async () => {
    const { store, port, templateId } = await withTemplate();
    const res = await create(port, templateId, { targetRepsLow: 8, targetRpe: 9 });
    expect(res.status).toBe(201);
    const [row] = [...store.plannedExercises.values()];
    expect(row).toMatchObject({ goalKind: 'rep_range', restLearning: true });
  });

  it.each([
    ['rep_range', { goalKind: 'rep_range', targetRpe: 8 }],
    ['target_rpe', { goalKind: 'target_rpe', targetRepsLow: 8 }],
    ['velocity_loss', { goalKind: 'velocity_loss', targetRepsLow: 8 }],
    [
      'a loss percent on a rep range',
      { goalKind: 'rep_range', targetRepsLow: 8, targetVelocityLossPct: 20 },
    ],
    ['learning off with no rest', { restLearning: false }],
    ['an unknown goal type', { goalKind: 'max_effort' }],
    ['a non-boolean learning flag', { restLearning: 'no' }],
    ['a loss percent out of range', { goalKind: 'velocity_loss', targetVelocityLossPct: 99 }],
  ])('refuses %s on create and stores nothing', async (_label, body) => {
    const { store, port, templateId } = await withTemplate();
    const res = await create(port, templateId, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_input' });
    expect(store.plannedExercises.size).toBe(0);
  });

  it('refuses a patch that clears the rest of a learning-off row', async () => {
    const { store, port, templateId } = await withTemplate();
    await create(port, templateId, { targetRepsLow: 8, restSec: 90, restLearning: false });
    const [row] = [...store.plannedExercises.values()];

    const res = await call(port, 'PATCH', `/api/plan/exercises/${row.id}`, { restSec: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_input',
      message:
        'Rest learning is off, so this exercise needs a fixed rest. Add a rest time, or turn ' +
        'rest learning on.',
      field: 'restSec',
    });
    expect(store.plannedExercises.get(row.id)).toMatchObject({ restSec: 90, restLearning: false });
  });

  it('accepts the same clearing patch when it also turns learning on', async () => {
    const { store, port, templateId } = await withTemplate();
    await create(port, templateId, { targetRepsLow: 8, restSec: 90, restLearning: false });
    const [row] = [...store.plannedExercises.values()];

    const res = await call(port, 'PATCH', `/api/plan/exercises/${row.id}`, {
      restSec: null,
      restLearning: true,
    });
    expect(res.status).toBe(200);
    expect(store.plannedExercises.get(row.id)?.restSec).toBeUndefined();
    expect(store.plannedExercises.get(row.id)?.restLearning).toBe(true);
  });

  // Coordinator ruling on #497: a row stored with both null is a tolerated fallback, not a locked row.
  it('lets a weight-only edit through on a learning-off row with no rest, and leaves it so', async () => {
    const { store, port, templateId } = await withTemplate();
    await create(port, templateId, { targetRepsLow: 8, restSec: 90, restLearning: false });
    const [row] = [...store.plannedExercises.values()];
    const { restSec: _dropped, ...withoutRest } = row;
    await store.putPlannedExercise(withoutRest);
    const path = `/api/plan/exercises/${row.id}`;

    expect((await call(port, 'PATCH', path, { targetWeightLbs: 135 })).status).toBe(200);
    expect(store.plannedExercises.get(row.id)).toMatchObject({
      targetWeightLbs: 135,
      restLearning: false,
    });
    expect(store.plannedExercises.get(row.id)?.restSec).toBeUndefined();
    expect((await call(port, 'PATCH', path, { restLearning: false })).status).toBe(400);
  });

  it('checks the goal only when an edit touches a goal field', async () => {
    const { store, port, templateId } = await withTemplate();
    await create(port, templateId, { targetRpe: 8 });
    const [row] = [...store.plannedExercises.values()];
    await store.putPlannedExercise({ ...row, goalKind: 'rep_range' });
    const path = `/api/plan/exercises/${row.id}`;

    expect((await call(port, 'PATCH', path, { restSec: 120 })).status).toBe(200);
    expect(store.plannedExercises.get(row.id)?.goalKind).toBe('rep_range');
    const res = await call(port, 'PATCH', path, { targetRpe: 9 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'A rep-range goal needs a rep range. Add one, or choose a different goal type.',
      field: 'targetRepsLow',
    });
  });

  it('switches a velocity_loss row to a rep range only when the percent is cleared too', async () => {
    const { store, port, templateId } = await withTemplate();
    await create(port, templateId, { targetRepsLow: 5, targetVelocityLossPct: 20 });
    const [row] = [...store.plannedExercises.values()];
    expect(row.goalKind).toBe('velocity_loss');
    const path = `/api/plan/exercises/${row.id}`;

    expect((await call(port, 'PATCH', path, { goalKind: 'rep_range' })).status).toBe(400);
    const res = await call(port, 'PATCH', path, {
      goalKind: 'rep_range',
      targetVelocityLossPct: null,
    });
    expect(res.status).toBe(200);
    expect(store.plannedExercises.get(row.id)).toMatchObject({ goalKind: 'rep_range' });
    expect(store.plannedExercises.get(row.id)?.targetVelocityLossPct).toBeUndefined();
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

// ── The write guard (VW-500) ──────────────────────────────────────────────
//
// Until this landed the loopback bind was the sidecar's only protection, so any
// page open in any browser on this machine could drive the plan writes. Each
// case below breaks ONE guard fact on EVERY one of the six routes, and asserts
// the request never reached a handler.

/** The six write routes, each with a body its handler would accept. */
const WRITE_ROUTES: { name: string; method: string; path: string; payload?: unknown }[] = [
  { name: 'create program', method: 'POST', path: '/api/plan/programs', payload: { name: 'P' } },
  {
    name: 'create workout',
    method: 'POST',
    path: '/api/plan/programs/prog-1/workouts',
    payload: { name: 'W' },
  },
  {
    name: 'create planned exercise',
    method: 'POST',
    path: '/api/plan/templates/tmpl-1/exercises',
    payload: { exerciseId: 'cable-row' },
  },
  {
    name: 'reorder planned exercises',
    method: 'POST',
    path: '/api/plan/templates/tmpl-1/reorder',
    payload: { plannedExerciseIds: [] },
  },
  {
    name: 'update planned exercise',
    method: 'PATCH',
    path: '/api/plan/exercises/pe-1',
    payload: { targetSets: 4 },
  },
  { name: 'delete planned exercise', method: 'DELETE', path: '/api/plan/exercises/pe-1' },
];

/** Headers a legitimate SPA write carries, for a test to break one of. */
async function guardHeaders(port: number): Promise<Record<string, string>> {
  return {
    origin: `http://${DEFAULT_DASHBOARD_HOST}:${port}`,
    'content-type': 'application/json',
    [WRITE_TOKEN_HEADER]: await bootstrapToken(port),
  };
}

describe('write guard', () => {
  for (const route of WRITE_ROUTES) {
    describe(route.name, () => {
      it('403s a post from a foreign origin', async () => {
        const port = await start(makeState(new FakePlanStore()));
        const headers = { ...(await guardHeaders(port)), origin: 'https://evil.example' };
        const res = await callRaw(port, route.method, route.path, route.payload, headers);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'foreign_origin' });
      });

      it('403s a post with no token', async () => {
        const port = await start(makeState(new FakePlanStore()));
        const { [WRITE_TOKEN_HEADER]: _token, ...headers } = await guardHeaders(port);
        const res = await callRaw(port, route.method, route.path, route.payload, headers);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'token_required' });
      });

      it('403s a post carrying another boot’s token', async () => {
        const port = await start(makeState(new FakePlanStore()));
        const headers = { ...(await guardHeaders(port)), [WRITE_TOKEN_HEADER]: 'f'.repeat(64) };
        const res = await callRaw(port, route.method, route.path, route.payload, headers);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'stale_token' });
      });

      it('403s a post with no Origin header at all', async () => {
        const port = await start(makeState(new FakePlanStore()));
        const { origin: _origin, ...headers } = await guardHeaders(port);
        const res = await callRaw(port, route.method, route.path, route.payload, headers);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'origin_required' });
      });

      it('415s the content type a cross-site form post would send', async () => {
        const port = await start(makeState(new FakePlanStore()));
        const headers = {
          ...(await guardHeaders(port)),
          'content-type': 'application/x-www-form-urlencoded',
        };
        const res = await callRaw(port, route.method, route.path, route.payload, headers);
        expect(res.status).toBe(415);
        expect(res.body).toMatchObject({ error: 'unsupported_media_type' });
      });
    });
  }

  it('403s a request whose Host is a rebound domain, not a loopback name', async () => {
    // Origin and Host AGREE here — that is what DNS rebinding buys an attacker.
    // Only the loopback-literal rule refuses it.
    const port = await start(makeState(new FakePlanStore()));
    const headers = {
      ...(await guardHeaders(port)),
      host: 'rebound.example',
      origin: 'http://rebound.example',
    };
    const res = await callRaw(port, 'POST', '/api/plan/programs', { name: 'P' }, headers);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'foreign_host' });
  });

  it('refuses a foreign-origin write before it can reach the store', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    const headers = { ...(await guardHeaders(port)), origin: 'https://evil.example' };
    await callRaw(port, 'POST', '/api/plan/programs', { name: 'Stolen' }, headers);
    expect(store.programs.size).toBe(0);
  });

  it('runs the whole plan-builder flow under the guard', async () => {
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    const created = await call(port, 'POST', '/api/plan/programs', { name: 'Guarded' });
    expect(created.status).toBe(201);
    const tree = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    const template = firstTemplate(tree);
    expect(
      (
        await call(port, 'POST', `/api/plan/templates/${template.id}/exercises`, {
          exerciseId: 'cable-row',
        })
      ).status,
    ).toBe(201);
    const withExercise = (await call(port, 'GET', '/api/plan-tree')).body as PlanTreeBody;
    const plannedId = firstTemplate(withExercise).exercises[0].id;
    expect(
      (await call(port, 'PATCH', `/api/plan/exercises/${plannedId}`, { targetSets: 4 })).status,
    ).toBe(200);
    expect((await call(port, 'DELETE', `/api/plan/exercises/${plannedId}`)).status).toBe(200);
    expect(store.plannedExercises.size).toBe(0);
  });
});

describe('GET /api/bootstrap', () => {
  it('hands the SPA the same token the writes require', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = await callRaw(port, 'GET', '/api/bootstrap');
    expect(res.status).toBe(200);
    const token = (res.body as { token: string }).token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const headers = { ...(await guardHeaders(port)), [WRITE_TOKEN_HEADER]: token };
    const write = await callRaw(port, 'POST', '/api/plan/programs', { name: 'P' }, headers);
    expect(write.status).toBe(201);
  });

  it('403s when the browser says the fetch is cross-site', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const res = await callRaw(port, 'GET', '/api/bootstrap', undefined, {
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
  });

  it('never leaks the token into another GET payload', async () => {
    const port = await start(makeState(new FakePlanStore()));
    const token = await bootstrapToken(port);
    for (const path of [
      '/api/health',
      '/api/snapshot',
      '/api/history',
      '/api/session-plan',
      '/api/exercises',
      '/api/plan-tree',
    ]) {
      const res = await callRaw(port, 'GET', path);
      expect(JSON.stringify(res.body)).not.toContain(token);
    }
  });

  it('never writes the token to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const port = await start(makeState(new FakePlanStore()));
      const token = await bootstrapToken(port);
      await call(port, 'POST', '/api/plan/programs', { name: 'P' });
      await callRaw(
        port,
        'POST',
        '/api/plan/programs',
        { name: 'P' },
        { origin: 'https://evil.example' },
      );
      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
      expect(logged).not.toContain(token);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// ── The action layer (VW-502) ─────────────────────────────────────────────
//
// `POST /api/actions/:name` behind the same write guard as everything else,
// plus the audit rows the six plan routes now leave behind. The layer's own
// logic is unit-tested in `actions/__tests__/execute.test.ts`; these are the
// wiring facts that only a real socket can prove.

/** In-memory `ui_actions`, enough for the route tests. */
class FakeActionRows {
  readonly rows = new Map<string, Record<string, unknown>>();

  claimUiAction = (input: Record<string, unknown>): Promise<unknown> => {
    const id = input.actionId as string;
    const existing = this.rows.get(id);
    if (existing !== undefined) return Promise.resolve({ kind: 'taken', existing });
    this.rows.set(id, { ...input, resultStatus: 'pending' });
    return Promise.resolve({ kind: 'claimed' });
  };

  completeUiAction = (input: Record<string, unknown>): Promise<unknown> => {
    const id = input.actionId as string;
    const row = { ...this.rows.get(id), ...input };
    this.rows.set(id, row);
    return Promise.resolve(row);
  };
}

/** A captured tool the action route can run, counting its calls. */
function actionTools(counter: { runs: number }): Map<string, unknown> {
  return new Map([
    [
      'profile.log_bodyweight',
      {
        paramsShape: { weightLbs: zNumber() },
        handler: () => {
          counter.runs += 1;
          return { content: [{ type: 'text', text: JSON.stringify({ logged: true }) }] };
        },
      },
    ],
  ]);
}

function zNumber(): unknown {
  return z.number();
}

/** A state whose store also carries the audit methods and the captured tools. */
function actionState(
  store: FakePlanStore,
  audit: FakeActionRows,
  tools?: Map<string, unknown>,
): DashboardServerState {
  const state = makeState(store);
  const mutable = state as unknown as {
    store: Record<string, unknown>;
    actionTools?: unknown;
  };
  mutable.store.claimUiAction = audit.claimUiAction;
  mutable.store.completeUiAction = audit.completeUiAction;
  if (tools !== undefined) mutable.actionTools = tools;
  return state;
}

describe('POST /api/actions/:name', () => {
  it('runs an allowlisted action and records it', async () => {
    const counter = { runs: 0 };
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools(counter)));
    const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-1',
      input: { weightLbs: 180 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tier: 'W1', replayed: false });
    expect(counter.runs).toBe(1);
    expect(audit.rows.get('act-1')).toMatchObject({ actor: 'user', surface: 'wall' });
  });

  it('is behind the same write guard as every other write', async () => {
    const counter = { runs: 0 };
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools(counter)),
    );
    const headers = { ...(await guardHeaders(port)), origin: 'https://evil.example' };
    const res = await callRaw(
      port,
      'POST',
      '/api/actions/profile.log_bodyweight',
      { actionId: 'act-1', input: { weightLbs: 180 } },
      headers,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'foreign_origin' });
    expect(counter.runs).toBe(0);
  });

  it('403s a name that is not on the allowlist', async () => {
    const counter = { runs: 0 };
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools(counter)),
    );
    for (const name of ['device.set_weight', 'goal.retire', 'nonsense']) {
      const res = await call(port, 'POST', `/api/actions/${name}`, {
        actionId: `act-${name}`,
        input: {},
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'action_not_allowed' });
    }
    expect(counter.runs).toBe(0);
  });

  it('400s a submission with no action id', async () => {
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools({ runs: 0 })),
    );
    const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      input: { weightLbs: 180 },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_input' });
  });

  it('replays a repeated submit and runs the handler once', async () => {
    const counter = { runs: 0 };
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools(counter)),
    );
    const body = { actionId: 'act-1', input: { weightLbs: 180 } };
    await call(port, 'POST', '/api/actions/profile.log_bodyweight', body);
    const second = await call(port, 'POST', '/api/actions/profile.log_bodyweight', body);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ replayed: true });
    expect(counter.runs).toBe(1);
  });

  it('409s a reused id carrying a different body', async () => {
    const counter = { runs: 0 };
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools(counter)),
    );
    await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-1',
      input: { weightLbs: 180 },
    });
    const second = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-1',
      input: { weightLbs: 999 },
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'action_id_reused' });
    expect(counter.runs).toBe(1);
  });

  it('records a human tap as `user`, and refuses a body claiming otherwise', async () => {
    // The audit trail's actor column has to mean something. A request here came
    // from a browser on this machine, so it IS a human tap; the coach and the
    // tick call the layer in-process and stamp their own actor there.
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools({ runs: 0 })));
    for (const actor of ['coach', 'tick']) {
      const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
        actionId: `act-${actor}`,
        actor,
        input: { weightLbs: 180 },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_input' });
    }
    expect(audit.rows.size).toBe(0);
  });

  it('refuses a surface no browser can be', async () => {
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools({ runs: 0 })),
    );
    for (const surface of ['telegram', 'voice', 'nonsense']) {
      const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
        actionId: `act-${surface}`,
        surface,
        input: { weightLbs: 180 },
      });
      expect(res.status).toBe(400);
    }
  });

  it('keeps the wall/phone distinction, which only the client knows', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools({ runs: 0 })));
    await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-phone',
      surface: 'phone',
      input: { weightLbs: 180 },
    });
    expect(audit.rows.get('act-phone')).toMatchObject({ surface: 'phone', actor: 'user' });
  });

  it('tells two walls apart on one surface (VW-521)', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools({ runs: 0 })));
    for (const deviceId of ['wall-garage', 'wall-spare-room']) {
      await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
        actionId: `act-${deviceId}`,
        surface: 'wall',
        deviceId,
        input: { weightLbs: 180 },
      });
    }
    expect(audit.rows.get('act-wall-garage')).toMatchObject({
      surface: 'wall',
      deviceId: 'wall-garage',
    });
    expect(audit.rows.get('act-wall-spare-room')).toMatchObject({
      surface: 'wall',
      deviceId: 'wall-spare-room',
    });
  });

  it('accepts an action that names no display, and records none', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools({ runs: 0 })));
    const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-1',
      input: { weightLbs: 180 },
    });
    expect(res.status).toBe(200);
    expect(audit.rows.get('act-1')).not.toHaveProperty('deviceId');
  });

  it('400s a device id the audit trail could not usefully store', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit, actionTools({ runs: 0 })));
    for (const deviceId of ['x'.repeat(65), 'wall garage', '-leading-dash', '', 7, {}]) {
      const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
        actionId: `act-${String(deviceId).slice(0, 8)}`,
        deviceId,
        input: { weightLbs: 180 },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_input' });
    }
    expect(audit.rows.size).toBe(0);
  });

  it('405s anything but a POST', async () => {
    const port = await start(
      actionState(new FakePlanStore(), new FakeActionRows(), actionTools({ runs: 0 })),
    );
    for (const method of ['PATCH', 'DELETE']) {
      const res = await call(port, method, '/api/actions/profile.log_bodyweight', {
        actionId: 'act-1',
      });
      expect(res.status).toBe(405);
    }
  });

  it('501s when the server captured no handlers', async () => {
    const port = await start(actionState(new FakePlanStore(), new FakeActionRows()));
    const res = await call(port, 'POST', '/api/actions/profile.log_bodyweight', {
      actionId: 'act-1',
      input: { weightLbs: 180 },
    });
    expect(res.status).toBe(501);
  });
});

describe('the plan routes through the action layer', () => {
  it('leaves an audit row naming the actor and the surface', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit));
    const res = await call(port, 'POST', '/api/plan/programs', {
      name: 'Audited',
      actionId: 'act-plan-1',
    });
    expect(res.status).toBe(201);
    expect(audit.rows.get('act-plan-1')).toMatchObject({
      actionName: 'plan.program.create',
      actor: 'user',
      surface: 'wall',
      resultStatus: 'ok',
    });
  });

  it('keeps its original response shape, not the action envelope', async () => {
    const port = await start(actionState(new FakePlanStore(), new FakeActionRows()));
    const res = await call(port, 'POST', '/api/plan/programs', {
      name: 'Shape',
      actionId: 'act-plan-1',
    });
    // The SPA reads this body directly; an envelope here would break it.
    expect(res.body).not.toHaveProperty('ok');
    expect(res.body).not.toHaveProperty('replayed');
    expect(res.body).toHaveProperty('program');
  });

  it('writes once when the same submit arrives twice', async () => {
    const store = new FakePlanStore();
    const port = await start(actionState(store, new FakeActionRows()));
    const body = { name: 'Once', actionId: 'act-plan-1' };
    await call(port, 'POST', '/api/plan/programs', body);
    await call(port, 'POST', '/api/plan/programs', body);
    expect(store.programs.size).toBe(1);
  });

  it('records a refusal with the plan API’s own code', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit));
    const res = await call(port, 'POST', '/api/plan/programs', { actionId: 'act-bad' });
    expect(res.status).toBe(400);
    expect(audit.rows.get('act-bad')).toMatchObject({
      resultStatus: 'error',
      resultCode: 'invalid_input',
    });
  });

  it('forces the actor and narrows the surface on the plan routes too', async () => {
    const audit = new FakeActionRows();
    const port = await start(actionState(new FakePlanStore(), audit));
    const refused = await call(port, 'POST', '/api/plan/programs', {
      name: 'P',
      actionId: 'act-bad-surface',
      surface: 'telegram',
    });
    expect(refused.status).toBe(400);
    await call(port, 'POST', '/api/plan/programs', {
      name: 'P',
      actionId: 'act-phone',
      surface: 'phone',
    });
    expect(audit.rows.get('act-phone')).toMatchObject({ actor: 'user', surface: 'phone' });
  });

  it('never lets the surface reach the plan payload', async () => {
    const store = new FakePlanStore();
    const port = await start(actionState(store, new FakeActionRows()));
    await call(port, 'POST', '/api/plan/programs', {
      name: 'Clean',
      actionId: 'act-1',
      surface: 'phone',
    });
    const program = [...store.programs.values()][0] as unknown as Record<string, unknown>;
    expect(program).not.toHaveProperty('surface');
  });

  it('records the display on the plan routes too, and keeps it out of the payload', async () => {
    const store = new FakePlanStore();
    const audit = new FakeActionRows();
    const port = await start(actionState(store, audit));
    const refused = await call(port, 'POST', '/api/plan/programs', {
      name: 'P',
      actionId: 'act-bad-device',
      deviceId: 'wall garage',
    });
    expect(refused.status).toBe(400);
    await call(port, 'POST', '/api/plan/programs', {
      name: 'Clean',
      actionId: 'act-garage',
      deviceId: 'wall-garage',
    });
    expect(audit.rows.get('act-garage')).toMatchObject({ deviceId: 'wall-garage' });
    const program = [...store.programs.values()][0] as unknown as Record<string, unknown>;
    expect(program).not.toHaveProperty('deviceId');
  });

  it('keeps the plan builder working on a store with no audit table', async () => {
    // A test fake or an older store: degrading to an unaudited write beats
    // refusing the builder outright.
    const store = new FakePlanStore();
    const port = await start(makeState(store));
    const res = await call(port, 'POST', '/api/plan/programs', { name: 'Unaudited' });
    expect(res.status).toBe(201);
    expect(store.programs.size).toBe(1);
  });

  it('never leaks the action id into the plan payload', async () => {
    const store = new FakePlanStore();
    const port = await start(actionState(store, new FakeActionRows()));
    await call(port, 'POST', '/api/plan/programs', { name: 'Clean', actionId: 'act-plan-1' });
    const program = [...store.programs.values()][0] as unknown as Record<string, unknown>;
    expect(program).not.toHaveProperty('actionId');
  });
});
