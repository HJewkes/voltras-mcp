// Route-level tests for `GET /api/muscle-week` (VW-329, B2 of the body-map plan).
//
// Runs the real `node:http` server against an in-memory store fake, so the
// `?weekStart=` selection, the trailing-window set query and the 400/501 shapes
// are exercised end to end. The pure aggregation is covered separately in
// `muscle-week-read-model.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { startOfCalendarWeekIso } from '../read-models/muscle-set-scope.js';
import type { StoredSession, StoredSet } from '../../store/types.js';

const handles: DashboardServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    await handles
      .pop()
      ?.close()
      .catch(() => undefined);
  }
});

/** In-memory implementation of every store method the muscle-week route touches. */
class FakeStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly setsBySession = new Map<string, StoredSet[]>();

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

  /** Records one session holding `sets`, dated at the first of them. */
  seed(id: string, sets: StoredSet[]): void {
    this.sessions.set(id, { id, startedAt: sets[0]?.startedAt ?? '2026-07-06T00:00:00.000Z' });
    this.setsBySession.set(id, sets);
  }
}

const CATALOG = [
  {
    id: 'chest-press',
    name: 'Chest Press',
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['triceps'],
  },
  { id: 'cable-row', name: 'Cable Row', muscleGroups: ['back'] },
];

function makeState(store: FakeStore): DashboardServerState {
  return {
    slots: new Map(),
    store,
    exercises: { getById: (id) => CATALOG.find((e) => e.id === id) },
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

interface MuscleWeekBody {
  weekStart: string;
  muscleMapVersion: string;
  landmarkBasis: string;
  muscles: {
    muscle: string;
    sets: number;
    status: string;
    landmarks: { mev: number; mav: number; mrv: number };
    lastTrainedAt: string | null;
  }[];
}

let nextSetId = 0;

function set(exerciseId: string, startedAt: string, overrides: Partial<StoredSet> = {}): StoredSet {
  nextSetId += 1;
  return {
    id: `set-${nextSetId}`,
    sessionId: 'sess',
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId,
    firmwareRepCount: 8,
    ...overrides,
  };
}

const PAST_MONDAY = '2026-07-06T00:00:00.000Z';

describe('GET /api/muscle-week', () => {
  it('returns every titan slug with sets, status and landmarks for the requested week', async () => {
    const store = new FakeStore();
    store.seed('sess-1', [
      set('chest-press', '2026-07-07T10:00:00.000Z'),
      set('chest-press', '2026-07-07T11:00:00.000Z'),
      set('cable-row', '2026-07-09T10:00:00.000Z'),
    ]);

    const port = await start(makeState(store));
    const res = await call(port, '/api/muscle-week?weekStart=2026-07-08');
    expect(res.status).toBe(200);

    const body = res.body as MuscleWeekBody;
    expect(body.weekStart).toBe(PAST_MONDAY);
    expect(body.landmarkBasis).toBe('population-default');
    expect(body.muscles).toHaveLength(15);

    const chest = body.muscles.find((m) => m.muscle === 'chest');
    expect(chest).toMatchObject({
      sets: 2,
      status: 'under',
      landmarks: { mev: 8, mav: 14, mrv: 20 },
      lastTrainedAt: '2026-07-07T11:00:00.000Z',
    });
    // `back` maps to both lats and upper_back; the row's secondary triceps does not count.
    expect(body.muscles.find((m) => m.muscle === 'lats')?.sets).toBe(1);
    expect(body.muscles.find((m) => m.muscle === 'upper_back')?.sets).toBe(1);
    expect(body.muscles.find((m) => m.muscle === 'triceps')?.sets).toBe(0);
  });

  it('defaults to the current week when no weekStart is given', async () => {
    const store = new FakeStore();
    const thisMonday = startOfCalendarWeekIso(new Date());
    store.seed('sess-now', [set('chest-press', thisMonday)]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-week')).body as MuscleWeekBody;

    expect(body.weekStart).toBe(thisMonday);
    expect(body.muscles.find((m) => m.muscle === 'chest')?.sets).toBe(1);
  });

  it('reports lastTrainedAt from before the requested week, without counting those sets', async () => {
    const store = new FakeStore();
    store.seed('sess-old', [set('cable-row', '2026-06-24T10:00:00.000Z')]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-week?weekStart=2026-07-08')).body as MuscleWeekBody;

    expect(body.muscles.find((m) => m.muscle === 'lats')).toMatchObject({
      sets: 0,
      lastTrainedAt: '2026-06-24T10:00:00.000Z',
    });
  });

  it('excludes mock-adapter and guest sets', async () => {
    const store = new FakeStore();
    store.seed('sess-1', [
      set('chest-press', '2026-07-07T10:00:00.000Z', { source: 'mock' }),
      set('chest-press', '2026-07-07T11:00:00.000Z', { lifter: 'guest' }),
    ]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-week?weekStart=2026-07-08')).body as MuscleWeekBody;

    expect(body.muscles.find((m) => m.muscle === 'chest')).toMatchObject({
      sets: 0,
      lastTrainedAt: null,
    });
  });

  it('400s on an unparseable weekStart', async () => {
    const port = await start(makeState(new FakeStore()));
    const res = await call(port, '/api/muscle-week?weekStart=last-tuesday');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_input' });
  });

  it('501s when the wired store carries no session-read methods', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    expect((await call(port, '/api/muscle-week')).status).toBe(501);
  });
});
