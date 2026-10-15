// @vitest-environment happy-dom
//
// The Review page when there is no session at all (VW-931): a fresh install, or
// Live's auto-navigate after `session.end` on a store with nothing to show. The
// route answers 404, which the page used to print as a raw red "HTTP 404".
// `SessionSummaryPage` mounted with `react-dom/client`, `fetch` stubbed to the
// route's 404. The route half is `session-summary-latest-route.test.ts`.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  dashboardStore.getState().applyPlanner({ sessionSummary: null, plannerError: null });
});

/** Mounts the summary page with every read answered as the route answers a missing session. */
async function mountWithNoSession(sessionId: string): Promise<HTMLElement> {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SessionSummaryPage, { sessionId }));
  });
  await vi.waitFor(() => expect(container.textContent).not.toContain('Loading session summary'));
  return container;
}

describe('the summary page with no session to show (VW-931)', () => {
  it('renders an empty state, not the HTTP status, for the latest session', async () => {
    const container = await mountWithNoSession('latest');

    expect(container.textContent).toContain('No sessions yet');
    expect(container.textContent).not.toContain('HTTP 404');
  });
});
