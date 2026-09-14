// Route-level tests for `GET /api/muscle-recovery` (VW-332, B5 of the body-map plan).
//
// Runs the real `node:http` server against an in-memory store fake, so the
// trailing-window session query, the diet-phase join and the 501 shape are
// exercised end to end. The pure shaping is covered separately in
// `muscle-recovery-read-model.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
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

/** In-memory implementation of every store method the muscle-recovery route touches. */
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
  seed(id: string, sets: StoredSet[], dietPhase?: string): void {
    const startedAt = sets[0]?.startedAt ?? daysAgo(1);
    this.sessions.set(
      id,
      dietPhase === undefined ? { id, startedAt } : { id, startedAt, dietPhase },
    );
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

interface MuscleRecoveryBody {
  muscleMapVersion: string;
  muscles: {
    muscle: string;
    lastTrainedAt: string | null;
    daysSince: number | null;
    lastEntryDepression: { pct: number; confidence: number } | null;
    lastSessionMatchedPrior: boolean | null;
    reason: string | null;
  }[];
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

let nextSetId = 0;

function set(
  sessionId: string,
  exerciseId: string,
  startedAt: string,
  overrides: Partial<StoredSet> = {},
): StoredSet {
  nextSetId += 1;
  return {
    id: `set-${nextSetId}`,
    sessionId,
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId,
    weightLbs: 100,
    firmwareRepCount: 8,
    ...overrides,
  };
}

describe('GET /api/muscle-recovery', () => {
  it('returns every titan slug with its last-trained date and elapsed days', async () => {
    const store = new FakeStore();
    store.seed('sess-old', [set('sess-old', 'chest-press', daysAgo(9))]);
    store.seed('sess-new', [set('sess-new', 'chest-press', daysAgo(2), { firmwareRepCount: 10 })]);

    const port = await start(makeState(store));
    const res = await call(port, '/api/muscle-recovery');
    expect(res.status).toBe(200);

    const body = res.body as MuscleRecoveryBody;
    expect(body.muscles).toHaveLength(15);
    expect(body.muscles.find((m) => m.muscle === 'chest')).toMatchObject({
      daysSince: 2,
      lastSessionMatchedPrior: true,
      reason: null,
    });
    // The row's secondary triceps is never credited (target-only, B47).
    expect(body.muscles.find((m) => m.muscle === 'triceps')).toMatchObject({
      lastTrainedAt: null,
      daysSince: null,
      lastSessionMatchedPrior: null,
      reason: 'insufficient history',
    });
  });

  it('reports the null benchmark path with its reason', async () => {
    const store = new FakeStore();
    store.seed('sess-old', [set('sess-old', 'cable-row', daysAgo(9), { weightLbs: 90 })]);
    store.seed('sess-new', [set('sess-new', 'cable-row', daysAgo(1), { weightLbs: 120 })]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-recovery')).body as MuscleRecoveryBody;

    expect(body.muscles.find((m) => m.muscle === 'lats')).toMatchObject({
      lastSessionMatchedPrior: null,
      reason: 'no matched-load prior',
    });
  });

  it('joins each session’s diet phase before judging the pair like-vs-like', async () => {
    const store = new FakeStore();
    store.seed('sess-old', [set('sess-old', 'chest-press', daysAgo(9))], 'fat-loss');
    store.seed('sess-new', [set('sess-new', 'chest-press', daysAgo(2))], 'gain');

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-recovery')).body as MuscleRecoveryBody;

    expect(body.muscles.find((m) => m.muscle === 'chest')).toMatchObject({
      lastSessionMatchedPrior: null,
      reason: 'no comparable prior',
    });
  });

  it('excludes mock-adapter and guest sets', async () => {
    const store = new FakeStore();
    store.seed('sess-1', [
      set('sess-1', 'chest-press', daysAgo(2), { source: 'mock' }),
      set('sess-1', 'chest-press', daysAgo(1), { lifter: 'guest' }),
    ]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-recovery')).body as MuscleRecoveryBody;

    expect(body.muscles.find((m) => m.muscle === 'chest')).toMatchObject({
      lastTrainedAt: null,
      daysSince: null,
    });
  });

  it('does not see a session older than the trailing window', async () => {
    const store = new FakeStore();
    store.seed('sess-ancient', [set('sess-ancient', 'chest-press', daysAgo(70))]);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/muscle-recovery')).body as MuscleRecoveryBody;

    expect(body.muscles.find((m) => m.muscle === 'chest')?.lastTrainedAt).toBeNull();
  });

  it('501s when the wired store carries no session-read methods', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    expect((await call(port, '/api/muscle-recovery')).status).toBe(501);
  });
});
