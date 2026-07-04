// Tests for the current-set panel and rest-timer panel HTML served at GET /.
//
// Strategy: spin up the real HTTP sidecar with a fake state and assert on the
// raw HTML body. jsdom smoke-test is skipped — the inline script uses browser
// APIs (fetch, setInterval) that are awkward to wire in jsdom without a
// full browser environment. Text assertions on the body are sufficient to
// confirm panel structure and poll wiring.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { DASHBOARD_HTML } from '../dashboard-html.js';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import type { StoredSession } from '../../store/types.js';

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

function makeFakeState(
  slots: Record<
    string,
    {
      device?: DeviceSnapshot;
      session?: ActiveSession;
      activeSet?: ActiveSet;
    }
  > = { primary: {} },
): DashboardServerState {
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
  return {
    slots: slotMap,
    store: {
      listSessions: () => Promise.resolve([] as StoredSession[]),
      getSetsForSession: () => Promise.resolve([]),
    },
  };
}

async function startWithFake(state: DashboardServerState): Promise<DashboardServerHandle> {
  const handle = await startDashboardServer({ port: 0, state });
  liveHandles.push(handle);
  return handle;
}

function fetchPath(
  host: string,
  port: number,
  path: string,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
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

// ── DASHBOARD_HTML module ────────────────────────────────────────────────────

describe('DASHBOARD_HTML constant', () => {
  it('contains the correct <title>', () => {
    expect(DASHBOARD_HTML).toContain('<title>Voltras MCP Dashboard</title>');
  });

  it('contains the current-set section', () => {
    expect(DASHBOARD_HTML).toContain('id="current-set"');
  });

  it('contains the rest-timer section', () => {
    expect(DASHBOARD_HTML).toContain('id="rest-timer"');
  });

  it('contains the snapshot poll fetch call', () => {
    expect(DASHBOARD_HTML).toContain("fetch('/api/snapshot')");
  });

  it('contains the 500 ms polling interval', () => {
    expect(DASHBOARD_HTML).toContain('500');
    expect(DASHBOARD_HTML).toContain('setInterval');
  });

  it('has a reasonable byte size (> 1 KB and < 50 KB)', () => {
    const bytes = Buffer.byteLength(DASHBOARD_HTML, 'utf8');
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(50 * 1024);
  });

  it('includes the rep-bars list element', () => {
    expect(DASHBOARD_HTML).toContain('id="rep-bars-list"');
  });

  it('includes key metric element IDs', () => {
    expect(DASHBOARD_HTML).toContain('id="cs-weight"');
    expect(DASHBOARD_HTML).toContain('id="cs-mode"');
    expect(DASHBOARD_HTML).toContain('id="cs-reps"');
    expect(DASHBOARD_HTML).toContain('id="cs-peak-vel"');
  });

  it('includes the rest-timer display element', () => {
    expect(DASHBOARD_HTML).toContain('id="rest-timer-display"');
  });
});

// ── GET / via real HTTP ──────────────────────────────────────────────────────

describe('GET / — HTTP response', () => {
  it('returns 200 + text/html content-type', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('body includes the page title', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain('<title>Voltras MCP Dashboard</title>');
  });

  it('body includes the current-set section', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain('id="current-set"');
  });

  it('body includes the rest-timer section', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain('id="rest-timer"');
  });

  it('body size is reasonable (> 1 KB, < 50 KB)', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    const bytes = Buffer.byteLength(res.body, 'utf8');
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(50 * 1024);
  });

  it('body includes the snapshot poll fetch call', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain("fetch('/api/snapshot')");
  });

  it('body includes setInterval for polling', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain('setInterval');
  });

  it('body references 500 ms poll interval', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/');
    expect(res.body).toContain('500');
  });
});
