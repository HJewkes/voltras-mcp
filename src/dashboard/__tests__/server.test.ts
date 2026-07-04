// Unit tests for the dashboard HTTP sidecar.
//
// We exercise the real `node:http` server against `127.0.0.1` with
// `port: 0` (auto-assignment). Every test creates its own server and
// closes it in a finally block; the `afterEach` belt-and-suspenders also
// closes any leaked handle so a test crash doesn't hang the suite.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import type { StoredSession, StoredSet } from '../../store/types.js';

// Track every handle a test acquires so `afterEach` can close stragglers.
const liveHandles: DashboardServerHandle[] = [];

afterEach(async () => {
  while (liveHandles.length > 0) {
    const handle = liveHandles.pop();
    try {
      await handle?.close();
    } catch {
      // best-effort cleanup
    }
  }
});

async function startWithFake(
  state: DashboardServerState,
  port = 0,
): Promise<DashboardServerHandle> {
  const handle = await startDashboardServer({ port, state });
  liveHandles.push(handle);
  return handle;
}

interface FakeSlotConfig {
  device?: DeviceSnapshot;
  session?: ActiveSession;
  activeSet?: ActiveSet;
}

function makeFakeState(
  slots: Record<string, FakeSlotConfig> = { primary: {} },
  listSessions: (filter: {
    sort: 'startedAt:desc' | 'startedAt:asc';
    limit: number;
    offset: number;
    exerciseId?: string;
  }) => Promise<StoredSession[]> = () => Promise.resolve([]),
  getSetsForSession: (sessionId: string) => Promise<StoredSet[]> = () => Promise.resolve([]),
): DashboardServerState & {
  store: { listSessions: ReturnType<typeof vi.fn>; getSetsForSession: ReturnType<typeof vi.fn> };
} {
  const slotMap = new Map<
    string,
    DashboardServerState['slots'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  for (const [slotId, cfg] of Object.entries(slots)) {
    slotMap.set(slotId, {
      live: {
        snapshotDevice: () => cfg.device ?? { connected: false },
        snapshotSession: () => cfg.session,
        snapshotSet: () => cfg.activeSet,
      },
    });
  }
  const listMock = vi.fn(listSessions);
  const setsMock = vi.fn(getSetsForSession);
  return {
    slots: slotMap,
    store: { listSessions: listMock, getSetsForSession: setsMock },
  };
}

interface FetchResult {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

function fetchPath(host: string, port: number, path: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startDashboardServer', () => {
  it('returns a handle bound to the requested port', async () => {
    const handle = await startWithFake(makeFakeState());
    expect(handle.port).toBeGreaterThan(0);
    await handle.close();
  });

  it('close() resolves and is idempotent', async () => {
    const handle = await startWithFake(makeFakeState());
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('exposes default port + host constants', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(7723);
    expect(DEFAULT_DASHBOARD_HOST).toBe('127.0.0.1');
  });
});

describe('GET /', () => {
  it('returns 200 + text/html + dashboard title', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>Voltras MCP Dashboard</title>');
    expect(res.body).toContain('id="current-set"');
  });
});

describe('GET /api/health', () => {
  it('returns ok=true, a version string, and uptime in ms', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.body) as { ok: boolean; version: string; uptimeMs: number };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/snapshot', () => {
  it('returns { session, devices, sets } with all three keys', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-A',
      startedAt: '2026-05-09T12:00:00.000Z',
      setIds: [],
      status: 'active',
    };
    const activeSet: ActiveSet = {
      setId: 'set-A',
      sessionId: 'sess-A',
      startedAt: '2026-05-09T12:00:05.000Z',
      reps: [],
      status: 'active',
    };
    const device: DeviceSnapshot = {
      connected: true,
      deviceId: 'V-097082',
      weightLbs: 50,
      damperLevel: 4,
    };
    const handle = await startWithFake(
      makeFakeState({
        primary: { device, session, activeSet },
      }),
    );
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      session: ActiveSession | null;
      devices: Array<{ slotId: string; device: DeviceSnapshot }>;
      sets: { active: ActiveSet | null };
    };
    expect(body.session?.sessionId).toBe('sess-A');
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.slotId).toBe('primary');
    expect(body.devices[0]?.device.deviceId).toBe('V-097082');
    expect(body.sets.active?.setId).toBe('set-A');
  });

  it('returns session=null + sets.active=null when no session is active', async () => {
    const handle = await startWithFake(makeFakeState({ primary: {} }));
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      session: ActiveSession | null;
      devices: Array<{ slotId: string; device: DeviceSnapshot }>;
      sets: { active: ActiveSet | null };
    };
    expect(body.session).toBeNull();
    expect(body.sets.active).toBeNull();
    expect(body.devices).toHaveLength(1);
  });

  it('joins the active exercise to its catalog muscle groups (activeExercise)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-M',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'cable-chest-press',
      exerciseName: 'Cable Chest Press',
      setIds: [],
      status: 'active',
    };
    const base = makeFakeState({ primary: { session } });
    const handle = await startWithFake({
      ...base,
      exercises: {
        getById: (id: string) =>
          id === 'cable-chest-press'
            ? { muscleGroups: ['chest'], secondaryMuscleGroups: ['shoulders', 'triceps'] }
            : undefined,
      },
    });
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    const body = JSON.parse(res.body) as {
      activeExercise: { primaryMuscles: string[]; secondaryMuscles: string[] } | null;
    };
    expect(body.activeExercise).toEqual({
      primaryMuscles: ['chest'],
      secondaryMuscles: ['shoulders', 'triceps'],
    });
  });

  it('reports activeExercise=null when no session / no catalog is wired', async () => {
    const handle = await startWithFake(makeFakeState({ primary: {} }));
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    const body = JSON.parse(res.body) as { activeExercise: unknown };
    expect(body.activeExercise).toBeNull();
  });

  it('lists every slot in devices[]', async () => {
    const handle = await startWithFake(
      makeFakeState({
        primary: { device: { connected: true, deviceId: 'V-097082' } },
        secondary: { device: { connected: false, deviceId: 'V-212006' } },
      }),
    );
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    const body = JSON.parse(res.body) as {
      devices: Array<{ slotId: string; device: DeviceSnapshot }>;
    };
    expect(body.devices.map((d) => d.slotId).sort()).toEqual(['primary', 'secondary']);
  });
});

describe('GET /api/history', () => {
  function makeStored(id: string): StoredSession {
    return {
      id,
      startedAt: `2026-05-09T${id.padStart(2, '0')}:00:00.000Z`,
    };
  }

  it('forwards limit + sort=startedAt:desc to listSessions and returns the result', async () => {
    const stored = [makeStored('1'), makeStored('2')];
    const state = makeFakeState({ primary: {} }, () => Promise.resolve(stored));
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/history?limit=5');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { sessions: StoredSession[] };
    expect(body.sessions).toEqual(stored);
    expect(state.store.listSessions).toHaveBeenCalledWith({
      sort: 'startedAt:desc',
      limit: 5,
      offset: 0,
    });
  });

  it('clamps limit to 100 (HISTORY_MAX_LIMIT)', async () => {
    const state = makeFakeState({ primary: {} });
    const handle = await startWithFake(state);
    await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/history?limit=200');
    const callArgs = state.store.listSessions.mock.calls[0]?.[0] as { limit: number };
    expect(callArgs.limit).toBe(HISTORY_MAX_LIMIT);
  });

  it('computes a per-exercise e1RM trend with PR flags from history', async () => {
    const makeSet = (sessionId: string, weightLbs: number, reps: number): StoredSet => ({
      id: `${sessionId}-set`,
      sessionId,
      startedAt: '',
      endedAt: '',
      partial: false,
      trainingMode: 'weight',
      weightLbs,
      reps: Array.from({ length: reps }, () => ({}) as StoredSet['reps'][number]),
    });
    const sessions: StoredSession[] = [
      { id: 's1', startedAt: '2026-05-01T00:00:00.000Z', exerciseId: 'bench' },
      { id: 's2', startedAt: '2026-05-08T00:00:00.000Z', exerciseId: 'bench' },
    ];
    const setsById: Record<string, StoredSet[]> = {
      s1: [makeSet('s1', 100, 5)],
      s2: [makeSet('s2', 110, 5)], // heavier → higher e1RM → PR
    };
    const state = makeFakeState(
      { primary: {} },
      () => Promise.resolve(sessions),
      (id) => Promise.resolve(setsById[id] ?? []),
    );
    const handle = await startWithFake(state);
    const res = await fetchPath(
      DEFAULT_DASHBOARD_HOST,
      handle.port,
      '/api/exercise-trend?exerciseId=bench',
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      points: { date: string; e1rm: number; isPR: boolean }[];
    };
    expect(body.points).toHaveLength(2);
    expect(body.points[0]?.isPR).toBe(true); // first session establishes the baseline PR
    expect(body.points[1]?.e1rm).toBeGreaterThan(body.points[0]?.e1rm ?? 0);
    expect(body.points[1]?.isPR).toBe(true); // improved on the baseline
    expect(state.store.listSessions).toHaveBeenCalledWith({
      sort: 'startedAt:asc',
      limit: HISTORY_DEFAULT_LIMIT,
      offset: 0,
      exerciseId: 'bench',
    });
  });

  it('serves the first unassigned workout with catalog muscle groups', async () => {
    const base = makeFakeState({ primary: {} });
    const state: DashboardServerState = {
      slots: base.slots,
      store: {
        ...base.store,
        listTrainingPrograms: () => Promise.resolve([{ id: 'p1', name: 'Prog', createdAt: '' }]),
        getTrainingBlocksForProgram: () =>
          Promise.resolve([
            { id: 'b1', programId: 'p1', orderIndex: 0, name: 'Block A', weeksCount: 4 },
          ]),
        getTrainingWeeksForBlock: () =>
          Promise.resolve([{ id: 'w1', blockId: 'b1', orderIndex: 0, name: 'Week 1' }]),
        getWorkoutTemplatesForWeek: () =>
          Promise.resolve([{ id: 't1', weekId: 'w1', name: 'Day A', orderIndex: 0 }]),
        getAssignmentsForTemplate: () => Promise.resolve([]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'bench',
              orderIndex: 0,
              targetSets: 3,
            },
          ]),
      },
      exercises: { getById: () => ({ muscleGroups: ['chest', 'triceps'] }) },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/next-workout');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      workout: { name: string; totalSets: number; muscleGroups: Array<{ group: string }> } | null;
    };
    expect(body.workout?.name).toBe('Day A');
    expect(body.workout?.totalSets).toBe(3);
    expect(body.workout?.muscleGroups.map((m) => m.group)).toEqual(['chest', 'triceps']);
  });

  it('returns workout=null when the store exposes no plan methods', async () => {
    const handle = await startWithFake(makeFakeState({ primary: {} }));
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/next-workout');
    const body = JSON.parse(res.body) as { workout: unknown };
    expect(body.workout).toBeNull();
  });

  it('serves the active exercise prescription from an attached template', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-P',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'bench',
      exerciseName: 'Bench',
      setIds: [],
      status: 'active',
    };
    const base = makeFakeState({ primary: { session } });
    const state: DashboardServerState = {
      slots: base.slots,
      store: {
        ...base.store,
        getAssignmentsForSession: () =>
          Promise.resolve([
            { id: 'a1', sessionId: 'sess-P', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'squat',
              orderIndex: 0,
              targetSets: 3,
            },
            {
              id: 'pe2',
              workoutTemplateId: 't1',
              exerciseId: 'bench',
              orderIndex: 1,
              targetSets: 3,
              targetRepsLow: 8,
              targetRepsHigh: 10,
              targetWeightLbs: 62,
              targetRpe: 8,
            },
          ]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { plan: Record<string, number> | null };
    expect(body.plan).toEqual({ repsLow: 8, repsHigh: 10, weightLbs: 62, rpe: 8 });
  });

  it('returns plan=null when no template is attached to the active session', async () => {
    const session: ActiveSession = {
      sessionId: 's',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'bench',
      setIds: [],
      status: 'active',
    };
    const base = makeFakeState({ primary: { session } });
    const state: DashboardServerState = {
      slots: base.slots,
      store: {
        ...base.store,
        getAssignmentsForSession: () => Promise.resolve([]),
        getPlannedExercisesForTemplate: () => Promise.resolve([]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as { plan: unknown };
    expect(body.plan).toBeNull();
  });

  it('uses the default limit when ?limit is absent', async () => {
    const state = makeFakeState({ primary: {} });
    const handle = await startWithFake(state);
    await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/history');
    const callArgs = state.store.listSessions.mock.calls[0]?.[0] as { limit: number };
    expect(callArgs.limit).toBe(HISTORY_DEFAULT_LIMIT);
  });

  it('falls back to the default limit on a malformed ?limit', async () => {
    const state = makeFakeState({ primary: {} });
    const handle = await startWithFake(state);
    await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/history?limit=garbage');
    const callArgs = state.store.listSessions.mock.calls[0]?.[0] as { limit: number };
    expect(callArgs.limit).toBe(HISTORY_DEFAULT_LIMIT);
  });
});

describe('routing', () => {
  it('returns 404 + JSON { error: "not_found" } for unknown paths', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it('returns 405 for non-GET methods', async () => {
    const handle = await startWithFake(makeFakeState());
    const result = await new Promise<FetchResult>((resolve, reject) => {
      const req = httpRequest(
        {
          host: DEFAULT_DASHBOARD_HOST,
          port: handle.port,
          path: '/',
          method: 'POST',
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(result.status).toBe(405);
  });
});

describe('port auto-assignment + collision', () => {
  it('port: 0 yields a non-zero bound port', async () => {
    const handle = await startWithFake(makeFakeState(), 0);
    expect(handle.port).toBeGreaterThan(0);
  });

  it('rejects when a second start attempt collides on the same port', async () => {
    const first = await startWithFake(makeFakeState(), 0);
    await expect(
      startDashboardServer({ port: first.port, state: makeFakeState() }),
    ).rejects.toThrow();
  });
});
