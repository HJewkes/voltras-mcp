// @vitest-environment happy-dom
//
// The Review page on a store with no training session (VW-931). `latest` used to
// resolve through the training-only default kind filter, so a mock-mode session
// (always stored as `test`) and a fresh install both got a 404, which the page
// printed as a raw red "HTTP 404". Real store, real route, real page; every value
// is synthetic.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node 25 ships its own global `localStorage`, unusable without a file flag, and it
// shadows the DOM one; the store reads it at import, so this runs before any import.
vi.hoisted(() => {
  if (typeof globalThis.localStorage?.getItem === 'function') return;
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

const { SessionSummaryPage } = await import('../spa/planner/SessionSummaryPage.js');
const { dashboardStore } = await import('../spa/store.js');

const handles: DashboardServerHandle[] = [];
const stores: SessionStore[] = [];
let root: Root | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  dashboardStore.getState().applyPlanner({ sessionSummary: null, plannerError: null });
  while (handles.length > 0) await handles.pop()?.close();
  while (stores.length > 0) await stores.pop()?.close();
});

interface Reply {
  status: number;
  text: string;
}

function get(port: number, path: string): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
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

function freshStore(): SessionStore {
  const store = openTestStore();
  stores.push(store);
  return store;
}

/** Mounts the page with the SPA's relative fetches answered by the real server. */
async function mountSummary(port: number): Promise<HTMLElement> {
  vi.stubGlobal('fetch', async (url: string) => {
    const reply = await get(port, url);
    return new Response(reply.text, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SessionSummaryPage, { sessionId: 'latest' }));
  });
  await vi.waitFor(() => expect(container.textContent).not.toContain('Loading session summary'));
  return container;
}

describe('the latest session summary on a store with no training session (VW-931)', () => {
  it('serves a test-kind session, which is how every mock-mode session is stored', async () => {
    const store = freshStore();
    await store.putSession({
      id: 'mock-sess',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt: '2026-07-30T10:20:00.000Z',
      exerciseId: 'row',
    });
    await store.setSessionKind(['mock-sess'], 'test');

    const res = await get(await serve(store), '/api/session-summary/latest');

    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as { session: { id: string } }).session.id).toBe('mock-sess');
  });

  it('renders an empty state, not the HTTP status, on a fresh store', async () => {
    const container = await mountSummary(await serve(freshStore()));

    expect(container.textContent).toContain('No sessions yet');
    expect(container.textContent).not.toContain('HTTP 404');
  });
});
