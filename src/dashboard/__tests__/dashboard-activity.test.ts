// `GET /api/activity` over a real socket and an in-memory store (VW-893): the
// filters, the keyset paging, the actor labels, the limit clamp, and the summary
// and session id a wall tap's row now carries. Every value is synthetic.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { z } from 'zod';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { WRITE_TOKEN_HEADER } from '../write-guard.js';
import { ACTIVITY_MAX_LIMIT, type ActivityPage } from '../activity.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import type { ClaimUiActionInput } from '../../store/types.js';

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

function send(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Result> {
  const raw = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method, headers },
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
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

async function get(port: number, path: string): Promise<Result> {
  return send(port, 'GET', path);
}

async function post(port: number, path: string, payload: unknown): Promise<Result> {
  const token = ((await get(port, '/api/bootstrap')).body as { token: string }).token;
  return send(port, 'POST', path, payload, {
    origin: `http://${DEFAULT_DASHBOARD_HOST}:${port}`,
    'content-type': 'application/json',
    [WRITE_TOKEN_HEADER]: token,
  });
}

async function page(port: number, query: string): Promise<ActivityPage> {
  const res = await get(port, `/api/activity${query}`);
  expect(res.status).toBe(200);
  return res.body as ActivityPage;
}

function liveSlots(sessionId?: string): DashboardServerState['slots'] {
  return new Map([
    [
      'primary',
      {
        live: {
          snapshotDevice: () => ({ connected: false }) as never,
          snapshotSession: () =>
            sessionId === undefined
              ? undefined
              : { sessionId, startedAt: '2026-08-01T09:00:00.000Z', setIds: [], status: 'active' },
          snapshotSet: () => undefined,
        },
      },
    ],
  ]);
}

async function start(
  store: unknown,
  extra: Partial<DashboardServerState> = {},
  sessionId?: string,
): Promise<number> {
  const state = {
    slots: liveSlots(sessionId),
    store: store as DashboardServerState['store'],
    ...extra,
  } satisfies DashboardServerState;
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

function freshStore(): SessionStore {
  const store = openTestStore();
  stores.push(store);
  return store;
}

type Seed = Partial<ClaimUiActionInput> & { actionId: string; createdAt: string };

async function seed(store: SessionStore, row: Seed, status: 'ok' | 'error' = 'ok'): Promise<void> {
  await store.claimUiAction({
    actionName: 'goal.weekly_review',
    actor: 'user',
    surface: 'wall',
    inputHash: 'h',
    ...row,
  });
  await store.completeUiAction({
    actionId: row.actionId,
    resultStatus: status,
    ...(status === 'error' ? { resultCode: 'TOOL_ERROR' } : {}),
    result: { stored: true },
    completedAt: row.createdAt,
  });
}

function minute(n: number): string {
  return new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();
}

async function seedMixed(store: SessionStore): Promise<void> {
  await seed(store, { actionId: 'a1', createdAt: minute(1), actor: 'user', sessionId: 's1' });
  await seed(store, {
    actionId: 'a2',
    createdAt: minute(2),
    actor: 'coach',
    surface: 'mcp',
    sessionId: 's1',
  });
  await seed(store, { actionId: 'a3', createdAt: minute(3), actor: 'tick', flowId: 'f1' });
  await seed(store, { actionId: 'a4', createdAt: minute(4), actor: 'coach' }, 'error');
  await seed(store, { actionId: 'a5', createdAt: minute(5), actor: 'user', sessionId: 's2' });
}

function ids(body: ActivityPage): string[] {
  return body.rows.map((row) => row.id);
}

describe('GET /api/activity filters', () => {
  it('serves every row newest first with no filter', async () => {
    const store = freshStore();
    await seedMixed(store);
    const port = await start(store);

    const body = await page(port, '');

    expect(ids(body)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1']);
    expect(body.nextCursor).toBeNull();
  });

  it('narrows by session, flow, status and time window', async () => {
    const store = freshStore();
    await seedMixed(store);
    const port = await start(store);

    expect(ids(await page(port, '?sessionId=s1'))).toEqual(['a2', 'a1']);
    expect(ids(await page(port, '?flowId=f1'))).toEqual(['a3']);
    expect(ids(await page(port, '?status=error'))).toEqual(['a4']);
    const window = `?since=${minute(2)}&until=${minute(4)}`;
    expect(ids(await page(port, window))).toEqual(['a4', 'a3', 'a2']);
  });

  it('labels each actor and filters by the label', async () => {
    const store = freshStore();
    await seedMixed(store);
    const port = await start(store);

    const labels = (await page(port, '')).rows.map((row) => [row.id, row.actor]);
    const agents = await page(port, '?actor=agent');

    expect(labels).toEqual([
      ['a5', 'person'],
      ['a4', 'agent'],
      ['a3', 'rule'],
      ['a2', 'agent'],
      ['a1', 'person'],
    ]);
    expect(ids(agents)).toEqual(['a4', 'a2']);
  });

  it.each([
    ['actor', '?actor=coach'],
    ['status', '?status=done'],
    ['since', '?since=not-a-date'],
    ['until', '?until=later'],
    ['cursor', '?cursor=bm90LWEtY3Vyc29y'],
  ])('refuses a bad %s with 400', async (_name, query) => {
    const port = await start(freshStore());

    const res = await get(port, `/api/activity${query}`);

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_input');
  });

  it('answers 501 when the store has no feed', async () => {
    const port = await start({ listSessions: () => Promise.resolve([]) });

    const res = await get(port, '/api/activity');

    expect(res.status).toBe(501);
  });
});

describe('GET /api/activity paging', () => {
  it('walks every row once across pages, ties broken by id', async () => {
    const store = freshStore();
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) {
      await seed(store, { actionId: id, createdAt: minute(id === 'b5' ? 9 : 7) });
    }
    const port = await start(store);

    const seen: string[] = [];
    let cursor: string | null = '';
    let pages = 0;
    while (cursor !== null) {
      const query: string = cursor === '' ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const body = await page(port, query);
      seen.push(...ids(body));
      cursor = body.nextCursor;
      pages += 1;
    }

    expect(seen).toEqual(['b5', 'b4', 'b3', 'b2', 'b1']);
    expect(pages).toBe(3);
  });

  it('clamps a large limit to the maximum', async () => {
    const store = freshStore();
    for (let i = 0; i <= ACTIVITY_MAX_LIMIT; i += 1) {
      await seed(store, { actionId: `c${String(i).padStart(3, '0')}`, createdAt: minute(1) });
    }
    const port = await start(store);

    const body = await page(port, '?limit=5000');

    expect(body.rows).toHaveLength(ACTIVITY_MAX_LIMIT);
    expect(body.nextCursor).not.toBeNull();
  });
});

describe('wall taps in the feed', () => {
  function bodyweightTool(): Map<string, unknown> {
    return new Map([
      [
        'profile.log_bodyweight',
        {
          paramsShape: { bodyweightLbs: z.number() },
          handler: () =>
            Promise.resolve({
              content: [{ type: 'text', text: JSON.stringify({ logged: true }) }],
            }),
        },
      ],
    ]);
  }

  it('records the summary and the open session on an action row', async () => {
    const store = freshStore();
    const port = await start(store, { actionTools: bodyweightTool() as never }, 'live-1');

    const posted = await post(port, '/api/actions/profile.log_bodyweight', {
      actionId: 'tap-1',
      input: { bodyweightLbs: 180 },
    });
    const [row] = (await page(port, '')).rows;

    expect(posted.status).toBe(200);
    expect(row).toMatchObject({
      id: 'tap-1',
      actor: 'person',
      surface: 'wall',
      tool: 'profile.log_bodyweight',
      summary: { bodyweightLbs: 180 },
      sessionId: 'live-1',
      outcome: 'ok',
    });
  });

  it('records the open session on a plan route row, and no summary for a name-only route', async () => {
    const store = freshStore();
    const port = await start(store, {}, 'live-2');

    const posted = await post(port, '/api/plan/programs', { actionId: 'plan-1', name: 'Block' });
    const [row] = (await page(port, '')).rows;

    expect(posted.status).toBe(201);
    expect(row).toMatchObject({
      id: 'plan-1',
      tool: 'plan.program.create',
      summary: null,
      sessionId: 'live-2',
    });
  });
});
