// `GET /api/session-summary/latest` on a store with no training session (VW-931).
// `latest` used to resolve through the training-only default kind filter, so a
// mock-mode session (always stored as `test`) got a 404. A store with no session
// at all answers 200 null rather than a 404 the browser logs (VW-948). Real
// store, real route over a real socket; every value is synthetic. The page half
// is `spa-session-summary-empty-dom.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
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

async function serve(store: SessionStore): Promise<number> {
  const state = {
    slots: new Map(),
    store: store as unknown as DashboardServerState['store'],
  } satisfies DashboardServerState;
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

describe('the latest session summary on a store with no training session (VW-931)', () => {
  it('serves a test-kind session, which is how every mock-mode session is stored', async () => {
    const store = openTestStore();
    stores.push(store);
    await store.putSession({
      id: 'mock-sess',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt: '2026-07-30T10:20:00.000Z',
      exerciseId: 'row',
    });
    await store.setSessionKind(['mock-sess'], 'test');

    const res = await get(await serve(store), '/api/session-summary/latest');

    expect(res.status).toBe(200);
    expect((res.body as { session: { id: string } }).session.id).toBe('mock-sess');
  });

  it('answers 200 null on a store with no session at all (VW-948)', async () => {
    const store = openTestStore();
    stores.push(store);

    const res = await get(await serve(store), '/api/session-summary/latest');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('still 404s an explicit session id that does not exist', async () => {
    const store = openTestStore();
    stores.push(store);

    const res = await get(await serve(store), '/api/session-summary/no-such-session');

    expect(res.status).toBe(404);
  });
});
