// `GET /api/session-review` over a real socket and an in-memory store (VW-899):
// which days the default serves, their order, the day a late session lands on,
// agreement with the goals page's count, and the 400s. Every value is synthetic.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type { SessionReviewPage } from '../session-review-api.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import type { SessionKind } from '../../store/session-kind.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const handles: DashboardServerHandle[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
  while (stores.length > 0) await stores.pop()?.close();
});

interface Result {
  status: number;
  body: unknown;
}

function get(port: number, path: string): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function start(store: unknown): Promise<number> {
  const state = {
    slots: new Map(),
    store: store as DashboardServerState['store'],
  } satisfies DashboardServerState;
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

async function review(port: number, query = ''): Promise<SessionReviewPage> {
  const res = await get(port, `/api/session-review${query}`);
  expect(res.status).toBe(200);
  return res.body as SessionReviewPage;
}

interface SessionSeed {
  id: string;
  startedAt: string;
  endedAt: string;
  kind?: SessionKind;
}

async function seedSession(store: SessionStore, seed: SessionSeed): Promise<void> {
  const { id, startedAt, endedAt } = seed;
  await store.putSession({ id, startedAt, endedAt, exerciseId: 'row' });
  await store.putSet({
    id: `${id}-set`,
    sessionId: id,
    userId: LOCAL_USER_ID,
    startedAt,
    endedAt,
    partial: false,
    weightLbs: 120,
    exerciseId: 'row',
    reps: [],
  });
  if (seed.kind !== undefined) await store.setSessionKind([id], seed.kind);
}

/**
 * Four days: an unreviewed one, a mixed one (one training, one unmarked), a
 * training one, a test one. Oldest to newest, so the order is the route's own.
 */
async function seededStore(): Promise<SessionStore> {
  const store = openTestStore();
  stores.push(store);
  const seeds: SessionSeed[] = [
    { id: 'a', startedAt: '2026-09-01T15:00:00.000Z', endedAt: '2026-09-01T16:00:00.000Z' },
    {
      id: 'b1',
      startedAt: '2026-09-03T15:00:00.000Z',
      endedAt: '2026-09-03T16:00:00.000Z',
      kind: 'training',
    },
    { id: 'b2', startedAt: '2026-09-03T17:00:00.000Z', endedAt: '2026-09-03T17:30:00.000Z' },
    {
      id: 'c',
      startedAt: '2026-09-05T15:00:00.000Z',
      endedAt: '2026-09-05T16:00:00.000Z',
      kind: 'training',
    },
    {
      id: 'd',
      startedAt: '2026-09-07T15:00:00.000Z',
      endedAt: '2026-09-07T16:00:00.000Z',
      kind: 'test',
    },
  ];
  for (const seed of seeds) await seedSession(store, seed);
  return store;
}

describe('GET /api/session-review', () => {
  it('serves only the unreviewed and mixed days by default, newest first', async () => {
    const port = await start(await seededStore());

    const page = await review(port);

    expect(page.days.map((day) => [day.day, day.kind])).toEqual([
      ['2026-09-03', 'mixed'],
      ['2026-09-01', 'unreviewed'],
    ]);
    expect(page.days[0]?.sessionIds.sort()).toEqual(['b1', 'b2']);
    expect(page.unreviewedDays).toBe(2);
  });

  it('serves every day for kind=any', async () => {
    const port = await start(await seededStore());

    const page = await review(port, '?kind=any');

    expect(page.days.map((day) => [day.day, day.kind])).toEqual([
      ['2026-09-07', 'test'],
      ['2026-09-05', 'training'],
      ['2026-09-03', 'mixed'],
      ['2026-09-01', 'unreviewed'],
    ]);
    expect(page.unreviewedDays).toBe(2);
  });

  it('reports the same waiting count as the goals page on the same store', async () => {
    const port = await start(await seededStore());

    const goals = await get(port, '/api/goals');
    const page = await review(port, '?limit=1');

    expect(goals.status).toBe(200);
    const { review: goalsReview } = goals.body as { review: { unreviewedDays: number } };
    expect(page.unreviewedDays).toBe(goalsReview.unreviewedDays);
    expect(page.days).toHaveLength(1);
  });

  it('puts a session that ran past midnight on the day it ended', async () => {
    const store = openTestStore();
    stores.push(store);
    await seedSession(store, {
      id: 'late',
      startedAt: '2026-09-14T23:30:00.000Z',
      endedAt: '2026-09-15T00:40:00.000Z',
    });
    const port = await start(store);

    const page = await review(port);

    expect(page.days.map((day) => day.day)).toEqual(['2026-09-15']);
  });

  it.each([
    ['?kind=training'],
    ['?kind='],
    ['?limit=0'],
    ['?limit=-3'],
    ['?limit=2.5'],
    ['?limit=ten'],
    ['?limit='],
  ])('answers 400 for %s', async (query) => {
    const port = await start(await seededStore());

    const res = await get(port, `/api/session-review${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_input' });
  });

  it('clamps a limit above the maximum rather than refusing it', async () => {
    const port = await start(await seededStore());

    const page = await review(port, '?kind=any&limit=5000');

    expect(page.days).toHaveLength(4);
  });

  it('answers 501 when the store cannot list review rows', async () => {
    const port = await start({ listSessions: () => Promise.resolve([]) });

    const res = await get(port, '/api/session-review');

    expect(res.status).toBe(501);
  });
});
