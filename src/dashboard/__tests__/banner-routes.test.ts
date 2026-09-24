// Route-level tests for `GET /api/banners` (VW-504). The route reads the real clock, so the
// fixture block is dated from today's Monday rather than a fixed date, and the store holds no
// sessions at all — every passed week of it is therefore unrecorded.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { dateBlock } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { BannerRecord } from '../read-models/banners.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const handles: DashboardServerHandle[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles
      .pop()
      ?.close()
      .catch(() => undefined);
  }
  while (stores.length > 0) await stores.pop()?.close();
});

/** The Monday `weeks` calendar weeks before this one, as a local 'YYYY-MM-DD' date. */
function mondayWeeksAgo(weeks: number): string {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7 * weeks);
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const day = String(monday.getDate()).padStart(2, '0');
  return `${monday.getFullYear()}-${month}-${day}`;
}

async function planStore(): Promise<SessionStore> {
  const store = openTestStore();
  stores.push(store);
  await store.putTrainingProgram({
    id: 'p1',
    name: 'Program',
    createdAt: new Date().toISOString(),
  });
  await store.putTrainingBlock({
    id: 'b1',
    programId: 'p1',
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 4,
  });
  await store.putTrainingWeek({ id: 'w1', blockId: 'b1', orderIndex: 0, isDeload: false });
  await dateBlock(store, 'b1', mondayWeeksAgo(3), 4);
  return store;
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

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
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

describe('GET /api/banners', () => {
  it('answers the highest-priority banner that holds', async () => {
    const port = await start(await planStore());

    const res = await get(port, '/api/banners');
    const { banner } = res.body as { banner: BannerRecord };

    expect(res.status).toBe(200);
    expect(banner).toMatchObject({
      kind: 'unrecorded_week',
      tone: 'attention',
      destination: '#/plan',
      dismissible: false,
    });
    expect(banner.title).toContain('3 planned weeks: nothing recorded');
  });

  it('answers null rather than failing when the store has no planning reads', async () => {
    const port = await start({ listSessions: async () => [] });

    const res = await get(port, '/api/banners');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ banner: null });
  });
});
