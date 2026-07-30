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
  isAddressInUse,
  dashboardPortInUseMessage,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import type { StoredSession, StoredSet } from '../../store/types.js';
import { LiveSignalHub } from '../../state/live-signal.js';

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

  it('stamps a monotonically increasing rev on each snapshot (VMCP-03.04)', async () => {
    const handle = await startWithFake(makeFakeState({ primary: {} }));
    const first = JSON.parse(
      (await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot')).body,
    ) as { rev: number };
    const second = JSON.parse(
      (await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot')).body,
    ) as { rev: number };
    expect(typeof first.rev).toBe('number');
    expect(second.rev).toBeGreaterThan(first.rev);
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

  it('carries each slot’s OWN active set on its device entry (VW-71 per-slot sets)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-B',
      startedAt: '2026-05-09T12:00:00.000Z',
      setIds: [],
      status: 'active',
    };
    const leftSet: ActiveSet = {
      setId: 'set-L',
      sessionId: 'sess-B',
      startedAt: '2026-05-09T12:00:05.000Z',
      reps: [],
      status: 'active',
    };
    const rightSet: ActiveSet = { ...leftSet, setId: 'set-R' };
    const handle = await startWithFake(
      makeFakeState({
        left: { device: { connected: true }, session, activeSet: leftSet },
        right: { device: { connected: true }, activeSet: rightSet },
      }),
    );
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    const body = JSON.parse(res.body) as {
      devices: Array<{
        slotId: string;
        sets?: { active: ActiveSet | null; completed: ActiveSet[] };
      }>;
    };
    const bySlot = Object.fromEntries(body.devices.map((d) => [d.slotId, d]));
    // Each slot reports its OWN active set — not the first-slot-wins top-level `sets`.
    expect(bySlot.left?.sets?.active?.setId).toBe('set-L');
    expect(bySlot.right?.sets?.active?.setId).toBe('set-R');
    expect(bySlot.left?.sets?.completed).toEqual([]);
  });

  it('reports sets.active=null on a slot with no active set (VW-71)', async () => {
    const handle = await startWithFake(makeFakeState({ left: { device: { connected: true } } }));
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/snapshot');
    const body = JSON.parse(res.body) as {
      devices: Array<{ slotId: string; sets?: { active: ActiveSet | null } }>;
    };
    expect(body.devices[0]?.sets?.active).toBeNull();
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
              restSec: 120,
            },
          ]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { plan: Record<string, unknown> | null };
    expect(body.plan).toEqual({
      sets: 3,
      repsLow: 8,
      repsHigh: 10,
      weightLbs: 62,
      rpe: 8,
      restSec: 120,
      // The full ordered planned list (VW-49). No exercise catalog here, so names fall
      // back to the raw exercise ids — a real identifier, never invented.
      exercises: [
        { name: 'squat', order: 0, sets: 3, active: false },
        {
          name: 'bench',
          order: 1,
          sets: 3,
          repsLow: 8,
          repsHigh: 10,
          weightLbs: 62,
          active: true,
        },
      ],
    });
  });

  it('names the ordered planned list from the catalog and flags the active one (VW-49)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-L',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'bench',
      exerciseName: 'Bench Press',
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
            { id: 'a1', sessionId: 'sess-L', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        // Deliberately out of order — the server must sort by orderIndex.
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe2',
              workoutTemplateId: 't1',
              exerciseId: 'bench',
              orderIndex: 1,
              targetSets: 3,
            },
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'squat',
              orderIndex: 0,
              targetSets: 4,
            },
            { id: 'pe3', workoutTemplateId: 't1', exerciseId: 'row', orderIndex: 2, targetSets: 3 },
          ]),
      },
      exercises: {
        getById: (id: string) =>
          ({
            squat: { name: 'Back Squat', muscleGroups: [] },
            bench: { name: 'Bench Press', muscleGroups: [] },
          })[id],
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as {
      plan: { exercises: Array<{ name: string; order: number; active: boolean }> };
    };
    // Ordered by orderIndex; active flag on 'bench'; unknown 'row' falls back to its id.
    expect(body.plan.exercises).toEqual([
      { name: 'Back Squat', order: 0, sets: 4, active: false },
      { name: 'Bench Press', order: 1, sets: 3, active: true },
      { name: 'row', order: 2, sets: 3, active: false },
    ]);
  });

  it('surfaces the exercise-default target tempo when a byExercise override matches (VW-41)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-T',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'cable_hip_thrust',
      exerciseName: 'Cable Hip Thrust',
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
            { id: 'a1', sessionId: 'sess-T', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'cable_hip_thrust',
              orderIndex: 0,
              targetSets: 3,
            },
          ]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as { plan: { tempo?: number[] } };
    // [ecc, pauseBottom, con, pauseTop] — the cable_hip_thrust override.
    expect(body.plan.tempo).toEqual([2, 1, 1, 2]);
  });

  it('surfaces the movement-pattern default tempo from the exercise catalog (VW-41)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-M',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'barbell-bench-press',
      exerciseName: 'Bench Press',
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
            { id: 'a1', sessionId: 'sess-M', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'barbell-bench-press',
              orderIndex: 0,
              targetSets: 3,
            },
          ]),
      },
      // The catalog knows the pattern but has no byExercise override → pattern fallback.
      exercises: { getById: () => ({ muscleGroups: ['chest'], movementPattern: 'push' }) },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as { plan: { tempo?: number[] } };
    expect(body.plan.tempo).toEqual([3, 0, 1, 0]);
  });

  it('omits tempo from the prescription when no default resolves (VW-41)', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-N',
      startedAt: '2026-05-09T12:00:00.000Z',
      exerciseId: 'unknown_movement',
      exerciseName: 'Unknown',
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
            { id: 'a1', sessionId: 'sess-N', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'unknown_movement',
              orderIndex: 0,
              targetSets: 3,
            },
          ]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as { plan: { tempo?: number[] } };
    expect(body.plan.tempo).toBeUndefined();
  });

  it('omits rest from the prescription when the plan sets no rest target', async () => {
    const session: ActiveSession = {
      sessionId: 'sess-R',
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
            { id: 'a1', sessionId: 'sess-R', workoutTemplateId: 't1', assignedAt: '' },
          ]),
        getPlannedExercisesForTemplate: () =>
          Promise.resolve([
            {
              id: 'pe1',
              workoutTemplateId: 't1',
              exerciseId: 'bench',
              orderIndex: 0,
              targetSets: 4,
            },
          ]),
      },
    };
    const handle = await startWithFake(state);
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
    const body = JSON.parse(res.body) as { plan: Record<string, unknown> };
    expect(body.plan).toEqual({
      sets: 4,
      exercises: [{ name: 'bench', order: 0, sets: 4, active: true }],
    });
    expect(body.plan.restSec).toBeUndefined();
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

/**
 * Open a streaming GET and invoke `onChunk` with the accumulated body every
 * time bytes arrive. Resolves with a `close()` that aborts the request. Used to
 * drive the long-lived `/api/stream` SSE endpoint (which never `end()`s).
 */
function openStream(
  host: string,
  port: number,
  path: string,
  onChunk: (body: string) => void,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = httpRequest({ host, port, path, method: 'GET' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        onChunk(body);
      });
      resolve({
        close: () => {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Poll until `predicate` is true or the deadline elapses (SSE arrives async). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /api/stream (SSE)', () => {
  it('responds with text/event-stream headers, a retry hint, and a priming heartbeat', async () => {
    const hub = new LiveSignalHub();
    const handle = await startWithFake({ ...makeFakeState(), liveSignals: hub });
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    try {
      await waitFor(() => body.includes('event: hb'));
      expect(body).toContain('retry: 3000');
      expect(body).toContain('event: hb');
      expect(body).toContain('data: {"t":');
    } finally {
      stream.close();
    }
  });

  it('streams phase / phaseflip / rep / set events emitted on the hub', async () => {
    const hub = new LiveSignalHub();
    const handle = await startWithFake({ ...makeFakeState(), liveSignals: hub });
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    try {
      // Wait for the subscription to be live (priming hb received) before emitting.
      await waitFor(() => body.includes('event: hb'));
      hub.emit({
        type: 'set',
        data: { slot: 'primary', kind: 'started', setId: 'set-1', sessionId: 'sess-1' },
      });
      hub.emit({
        type: 'phaseflip',
        data: { slot: 'primary', t: 1000, from: 'con', to: 'hold', repIndex: 3 },
      });
      hub.emit({
        type: 'phase',
        data: {
          slot: 'primary',
          t: 1000,
          phase: 'con',
          phaseElapsedMs: 90,
          position: 312,
          velocity: 0.48,
          force: 74,
          repInProgress: 3,
        },
      });
      hub.emit({
        type: 'rep',
        data: { slot: 'primary', repIndex: 3, vCon: 0.41, rom: 0.52, peakVelocity: 0.63 },
      });

      await waitFor(() => body.includes('event: rep'));
      // VW-48 (Shape A): `slot` is a field ON the payload — `serveStream`
      // forwards it verbatim rather than merging it in — so a dual-aware client
      // can demux per-limb telemetry off a single SSE connection, with the
      // field typed at its `JSON.parse` boundary.
      expect(body).toContain('event: set\ndata: {"slot":"primary","kind":"started"');
      expect(body).toContain(
        'event: phaseflip\ndata: {"slot":"primary","t":1000,"from":"con","to":"hold"',
      );
      expect(body).toContain('event: phase\ndata: {"slot":"primary","t":1000,"phase":"con"');
      expect(body).toContain('event: rep\ndata: {"slot":"primary","repIndex":3');
    } finally {
      stream.close();
    }
  });

  it('tags events from two different slots distinctly so a dual session can demux (VW-48)', async () => {
    const hub = new LiveSignalHub();
    const handle = await startWithFake({ ...makeFakeState(), liveSignals: hub });
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    try {
      await waitFor(() => body.includes('event: hb'));
      hub.emit({
        type: 'phase',
        data: {
          slot: 'left',
          t: 1000,
          phase: 'con',
          phaseElapsedMs: 90,
          position: 100,
          velocity: 0.2,
          force: 50,
          repInProgress: 1,
        },
      });
      hub.emit({
        type: 'phase',
        data: {
          slot: 'right',
          t: 1000,
          phase: 'ecc',
          phaseElapsedMs: 45,
          position: 200,
          velocity: 0.3,
          force: 60,
          repInProgress: 2,
        },
      });

      await waitFor(() => body.includes('"slot":"right"'));
      expect(body).toContain('event: phase\ndata: {"slot":"left","t":1000,"phase":"con"');
      expect(body).toContain('event: phase\ndata: {"slot":"right","t":1000,"phase":"ecc"');
    } finally {
      stream.close();
    }
  });

  it('pushes a rev-stamped snapshot event on each set-lifecycle boundary (VMCP-03.04)', async () => {
    const hub = new LiveSignalHub();
    const handle = await startWithFake({ ...makeFakeState(), liveSignals: hub });
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    try {
      await waitFor(() => body.includes('event: hb'));
      hub.emit({
        type: 'set',
        data: { slot: 'primary', kind: 'ended', setId: 'set-1', sessionId: 'sess-1' },
      });
      // Wait for the snapshot that FOLLOWS the set echo — a snapshot is also
      // pushed on connect (VW-70 late-join catch-up), so gate on the set-triggered
      // one specifically rather than any snapshot event.
      await waitFor(() => {
        const setIdx = body.indexOf('event: set\ndata: {"slot":"primary","kind":"ended"');
        return setIdx !== -1 && body.indexOf('event: snapshot', setIdx) !== -1;
      });
      // the set echo AND the structural snapshot (with its ordering rev) both go out
      expect(body).toContain('event: set\ndata: {"slot":"primary","kind":"ended"');
      const afterSet = body.slice(
        body.indexOf('event: set\ndata: {"slot":"primary","kind":"ended"'),
      );
      expect(afterSet).toMatch(/event: snapshot\ndata: \{.*"rev":\d+/);
      expect(body).toContain('"devices":');
    } finally {
      stream.close();
    }
  });

  it('unsubscribes from the hub when the client disconnects', async () => {
    const hub = new LiveSignalHub();
    const handle = await startWithFake({ ...makeFakeState(), liveSignals: hub });
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    await waitFor(() => body.includes('event: hb'));
    expect(hub.subscriberCount).toBe(1);
    stream.close();
    await waitFor(() => hub.subscriberCount === 0);
    expect(hub.subscriberCount).toBe(0);
  });

  it('serves a valid heartbeat + connect-snapshot stream when no hub is wired', async () => {
    const handle = await startWithFake(makeFakeState());
    let body = '';
    const stream = await openStream(DEFAULT_DASHBOARD_HOST, handle.port, '/api/stream', (b) => {
      body = b;
    });
    try {
      await waitFor(() => body.includes('event: hb'));
      expect(body).toContain('event: hb');
      // VW-70: the connect-time snapshot is built from state (not the hub), so a
      // late-joining client catches up even when no live-signal hub is wired.
      await waitFor(() => body.includes('event: snapshot'));
      expect(body).toMatch(/event: snapshot\ndata: \{.*"completed":\[\]/);
    } finally {
      stream.close();
    }
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

  it('surfaces a port collision as an identifiable EADDRINUSE rejection', async () => {
    // The loud-error path in server.ts keys off isAddressInUse(err); prove the
    // rejection a real collision produces is classified as such end-to-end.
    const first = await startWithFake(makeFakeState(), 0);
    const err = await startDashboardServer({ port: first.port, state: makeFakeState() }).then(
      () => {
        throw new Error('expected collision to reject');
      },
      (e: unknown) => e,
    );
    expect(isAddressInUse(err)).toBe(true);
  });
});

describe('loud port-conflict reporting (VW-68)', () => {
  it('isAddressInUse classifies only EADDRINUSE errors', () => {
    expect(isAddressInUse({ code: 'EADDRINUSE' })).toBe(true);
    expect(isAddressInUse(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(isAddressInUse({ code: 'EACCES' })).toBe(false);
    expect(isAddressInUse(new Error('plain'))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
    expect(isAddressInUse('EADDRINUSE')).toBe(false);
  });

  it('the port-in-use message names the port and warns the dashboard is another server', () => {
    const msg = dashboardPortInUseMessage(DEFAULT_DASHBOARD_PORT, DEFAULT_DASHBOARD_HOST);
    expect(msg).toContain(String(DEFAULT_DASHBOARD_PORT));
    expect(msg).toContain(DEFAULT_DASHBOARD_HOST);
    expect(msg).toContain('another voltras-mcp');
    expect(msg).toMatch(/NO dashboard/);
  });
});
