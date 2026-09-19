// Route-level tests for `GET /api/muscle-plan` (VW-331, B4 of the body-map plan).
//
// Runs the real `node:http` server against an in-memory store fake, so the
// active-week walk, the calendar-week set query, and the 404/501 shapes are
// exercised end to end. The pure aggregation is covered separately in
// `muscle-plan-read-model.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { startOfCalendarWeekIso } from '../read-models/muscle-plan.js';
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

/** In-memory implementation of every store method the muscle-plan route touches. */
class FakeStore {
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
    [...this.programs.values()].filter(
      (p) => opts?.includeArchived === true || p.archivedAt === undefined,
    );

  putTrainingBlock = async (b: StoredTrainingBlock): Promise<void> => {
    this.blocks.set(b.id, b);
  };
  getTrainingBlocksForProgram = async (programId: string): Promise<StoredTrainingBlock[]> =>
    ordered([...this.blocks.values()].filter((b) => b.programId === programId));
  getTrainingBlock = async (id: string): Promise<StoredTrainingBlock | undefined> =>
    this.blocks.get(id);

  putTrainingWeek = async (w: StoredTrainingWeek): Promise<void> => {
    this.weeks.set(w.id, w);
  };
  getTrainingWeek = async (id: string): Promise<StoredTrainingWeek | undefined> =>
    this.weeks.get(id);
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
    from?: string;
    to?: string;
  }): Promise<StoredSession[]> =>
    [...this.sessions.values()]
      .filter(
        (s) =>
          (filter.from === undefined || s.startedAt >= filter.from) &&
          (filter.to === undefined || s.startedAt < filter.to),
      )
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
  { id: 'chest-press', name: 'Chest Press', muscleGroups: ['chest'] },
  { id: 'cable-row', name: 'Cable Row', muscleGroups: ['back'] },
];

function makeState(store: FakeStore): DashboardServerState {
  return {
    slots: new Map(),
    store,
    exercises: {
      getById: (id) => CATALOG.find((e) => e.id === id),
    },
  };
}

interface Result {
  status: number;
  body: unknown;
}

async function call(port: number, path: string): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' },
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
    req.end();
  });
}

async function start(state: DashboardServerState): Promise<number> {
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

interface MusclePlanBody {
  weekStart: string;
  weekIndex?: number;
  isDeload: boolean;
  muscleMapVersion: string;
  muscles: {
    muscle: string;
    plannedSetsThisWeek: number;
    doneSetsThisWeek: number;
    plannedRemaining: {
      workoutName: string;
      exerciseId: string;
      exerciseName: string;
      sets: number;
    }[];
  }[];
}

/** Seeds one program → block → week with 2 templates, the first already trained. */
async function seedTwoTemplateWeek(store: FakeStore): Promise<{ tplA: string; tplB: string }> {
  await store.putTrainingProgram({
    id: 'prog-1',
    name: 'Base Build',
    createdAt: '2026-07-01T00:00:00.000Z',
  });
  await store.putTrainingBlock({
    id: 'blk-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 1,
  });
  await store.putTrainingWeek({
    id: 'wk-1',
    blockId: 'blk-1',
    orderIndex: 0,
    isDeload: false,
    weekIndex: 1,
  });
  await store.putWorkoutTemplate({ id: 'tpl-a', weekId: 'wk-1', name: 'Upper A', orderIndex: 0 });
  await store.putWorkoutTemplate({ id: 'tpl-b', weekId: 'wk-1', name: 'Upper B', orderIndex: 1 });
  await store.putPlannedExercise({
    id: 'pe-a',
    workoutTemplateId: 'tpl-a',
    exerciseId: 'chest-press',
    orderIndex: 0,
    targetSets: 3,
  });
  await store.putPlannedExercise({
    id: 'pe-b',
    workoutTemplateId: 'tpl-b',
    exerciseId: 'chest-press',
    orderIndex: 0,
    targetSets: 4,
  });
  store.sessions.set('sess-1', { id: 'sess-1', startedAt: '2026-07-01T10:00:00.000Z' });
  await store.putProgramAssignment({
    id: 'asg-1',
    sessionId: 'sess-1',
    workoutTemplateId: 'tpl-a',
    assignedAt: '2026-07-01T10:05:00.000Z',
  });
  return { tplA: 'tpl-a', tplB: 'tpl-b' };
}

describe('GET /api/muscle-plan', () => {
  it('returns planned vs done sets and the remaining list for the active week', async () => {
    const store = new FakeStore();
    await seedTwoTemplateWeek(store);
    const weekStart = startOfCalendarWeekIso(new Date());
    store.sessions.set('sess-this-week', { id: 'sess-this-week', startedAt: weekStart });
    store.setsBySession.set('sess-this-week', [
      {
        id: 'set-1',
        sessionId: 'sess-this-week',
        startedAt: weekStart,
        endedAt: weekStart,
        partial: false,
        reps: [],
        exerciseId: 'chest-press',
        firmwareRepCount: 5,
      },
    ]);

    const port = await start(makeState(store));
    const res = await call(port, '/api/muscle-plan');
    expect(res.status).toBe(200);
    const body = res.body as MusclePlanBody;
    expect(body.weekIndex).toBe(1);
    expect(body.isDeload).toBe(false);
    expect(body.muscles).toHaveLength(15);

    const chest = body.muscles.find((m) => m.muscle === 'chest');
    expect(chest?.plannedSetsThisWeek).toBe(7);
    expect(chest?.doneSetsThisWeek).toBe(1);
    expect(chest?.plannedRemaining).toEqual([
      { workoutName: 'Upper B', exerciseId: 'chest-press', exerciseName: 'Chest Press', sets: 4 },
    ]);
  });

  it('404s when no training week is currently active', async () => {
    const store = new FakeStore();
    const port = await start(makeState(store));
    expect((await call(port, '/api/muscle-plan')).status).toBe(404);
    expect((await call(port, '/api/muscle-plan')).body).toEqual({ error: 'not_found' });
  });

  it('404s when every template in the program has already been trained', async () => {
    const store = new FakeStore();
    const { tplB } = await seedTwoTemplateWeek(store);
    store.sessions.set('sess-2', { id: 'sess-2', startedAt: '2026-07-02T10:00:00.000Z' });
    await store.putProgramAssignment({
      id: 'asg-2',
      sessionId: 'sess-2',
      workoutTemplateId: tplB,
      assignedAt: '2026-07-02T10:05:00.000Z',
    });
    const port = await start(makeState(store));
    expect((await call(port, '/api/muscle-plan')).status).toBe(404);
  });

  it('501s when the wired store carries no planning methods', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    expect((await call(port, '/api/muscle-plan')).status).toBe(501);
  });
});
