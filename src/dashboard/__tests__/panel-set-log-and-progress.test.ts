// Tests for the set-log and session-progress panels in the dashboard HTML.
//
// Strategy: assert on the raw HTML string from DASHBOARD_HTML and on the
// HTTP body served at GET /. JS behaviour (client-side accumulation) cannot
// be exercised without a browser runtime — we verify that the required DOM
// anchors and state-variable symbols are present in the source.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { DASHBOARD_HTML } from '../dashboard-html.js';
import type { ActiveSession, DeviceSnapshot } from '../../state/live-state.js';
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
        snapshotSet: () => undefined,
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

function fetchRoot(
  host: string,
  port: number,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: '/', method: 'GET' }, (res) => {
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

// ── DASHBOARD_HTML static checks ─────────────────────────────────────────────

describe('DASHBOARD_HTML — set-log panel', () => {
  it('contains the set-log section', () => {
    expect(DASHBOARD_HTML).toContain('id="set-log"');
  });

  it('contains the set-log table element', () => {
    expect(DASHBOARD_HTML).toContain('id="set-log-table"');
  });

  it('contains the set-log tbody element', () => {
    expect(DASHBOARD_HTML).toContain('id="set-log-body"');
  });

  it('contains the set-log empty-state element', () => {
    expect(DASHBOARD_HTML).toContain('id="set-log-empty"');
  });

  it('contains the correct table column headers', () => {
    expect(DASHBOARD_HTML).toContain('<th>#</th>');
    expect(DASHBOARD_HTML).toContain('<th>Weight</th>');
    expect(DASHBOARD_HTML).toContain('<th>Mode</th>');
    expect(DASHBOARD_HTML).toContain('<th>Reps</th>');
    expect(DASHBOARD_HTML).toContain('<th>Peak vel</th>');
  });
});

describe('DASHBOARD_HTML — session-progress panel', () => {
  it('contains the session-progress section', () => {
    expect(DASHBOARD_HTML).toContain('id="session-progress"');
  });

  it('contains the session-progress active sub-element', () => {
    expect(DASHBOARD_HTML).toContain('id="session-progress-active"');
  });

  it('contains the session-progress empty-state element', () => {
    expect(DASHBOARD_HTML).toContain('id="session-progress-empty"');
  });

  it('contains all metric display elements', () => {
    expect(DASHBOARD_HTML).toContain('id="sp-exercise"');
    expect(DASHBOARD_HTML).toContain('id="sp-sets"');
    expect(DASHBOARD_HTML).toContain('id="sp-reps"');
    expect(DASHBOARD_HTML).toContain('id="sp-volume"');
  });

  it('contains the Total volume label text', () => {
    expect(DASHBOARD_HTML).toContain('Total volume');
  });
});

describe('DASHBOARD_HTML — client-side state symbols', () => {
  it('declares the setLog state variable', () => {
    expect(DASHBOARD_HTML).toContain('let setLog');
  });

  it('declares the lastSnapshotSessionId state variable', () => {
    expect(DASHBOARD_HTML).toContain('lastSnapshotSessionId');
  });

  it('declares the lastActiveSetSnapshot state variable', () => {
    expect(DASHBOARD_HTML).toContain('lastActiveSetSnapshot');
  });

  it('contains the updateSetLog function', () => {
    expect(DASHBOARD_HTML).toContain('function updateSetLog(');
  });

  it('contains the renderSetLog function', () => {
    expect(DASHBOARD_HTML).toContain('function renderSetLog(');
  });

  it('contains the renderSessionProgress function', () => {
    expect(DASHBOARD_HTML).toContain('function renderSessionProgress(');
  });

  it('calls updateSetLog from the poll loop', () => {
    expect(DASHBOARD_HTML).toContain('updateSetLog(snapshot)');
  });
});

// ── F1 regression: device snapshot saved alongside set snapshot ───────────────
//
// The set-log row must record weight/mode from the tick where the set was
// active, not from the close-tick where the set is already null. We verify
// this by checking that:
//   1. A `lastActiveDeviceSnapshot` state variable exists (paired snapshot).
//   2. The snapshot-save block writes BOTH snapshots at the same time.
//   3. The set-close block reads from `lastActiveDeviceSnapshot` (the saved
//      snapshot), not directly from `snapshot.devices` (the current tick).
//
// The JS runs client-side in a browser, so we assert on the raw HTML source
// rather than executing it — consistent with the strategy used throughout
// this test file.

describe('DASHBOARD_HTML — F1: device snapshot saved at same tick as set snapshot', () => {
  it('declares the lastActiveDeviceSnapshot state variable', () => {
    expect(DASHBOARD_HTML).toContain('let lastActiveDeviceSnapshot');
  });

  it('saves lastActiveDeviceSnapshot when an active set is present', () => {
    // The snapshot-save block must assign lastActiveDeviceSnapshot inside the
    // activeSet-truthy branch so both snapshots share the same poll tick.
    expect(DASHBOARD_HTML).toContain('lastActiveDeviceSnapshot = currentDevice');
  });

  it('clears lastActiveDeviceSnapshot when there is no active set', () => {
    expect(DASHBOARD_HTML).toContain('lastActiveDeviceSnapshot = null');
  });

  it('reads savedDevice from lastActiveDeviceSnapshot on set-close, not from current snapshot', () => {
    // The set-close branch must use the saved device, not snapshot.devices[0].device.
    expect(DASHBOARD_HTML).toContain('const savedDevice = lastActiveDeviceSnapshot');
  });

  it('uses savedDevice.weightLbs (not current-tick device) for the set-log weight', () => {
    expect(DASHBOARD_HTML).toContain('savedDevice && savedDevice.weightLbs != null');
  });

  it('uses savedDevice.trainingMode (not current-tick device) for the set-log mode', () => {
    expect(DASHBOARD_HTML).toContain('savedDevice && savedDevice.trainingMode != null');
  });
});

// ── F3: HTML-escape dynamic values inserted via innerHTML ─────────────────────

describe('DASHBOARD_HTML — F3: escapeHtml used for dynamic innerHTML values', () => {
  it('defines the escapeHtml helper function', () => {
    expect(DASHBOARD_HTML).toContain('function escapeHtml(');
  });

  it('escapeHtml handles the five HTML special characters', () => {
    // Verify the replacement map covers &, <, >, ", '
    expect(DASHBOARD_HTML).toContain('&amp;');
    expect(DASHBOARD_HTML).toContain('&lt;');
    expect(DASHBOARD_HTML).toContain('&gt;');
    expect(DASHBOARD_HTML).toContain('&quot;');
    expect(DASHBOARD_HTML).toContain('&#39;');
  });

  it('wraps fmtMode output with escapeHtml in renderSetLog', () => {
    expect(DASHBOARD_HTML).toContain('escapeHtml(fmtMode(entry.mode))');
  });

  it('wraps the rep label with escapeHtml in renderRepBars', () => {
    expect(DASHBOARD_HTML).toContain('escapeHtml(label)');
  });
});

describe('DASHBOARD_HTML — layout', () => {
  it('defines a two-column grid for the main element', () => {
    expect(DASHBOARD_HTML).toContain('grid-template-columns: 1fr 1fr');
  });

  it('defines two grid rows for the main element', () => {
    expect(DASHBOARD_HTML).toContain('grid-template-rows: auto auto');
  });

  it('collapses to single column below 700 px', () => {
    expect(DASHBOARD_HTML).toContain('max-width: 700px');
    expect(DASHBOARD_HTML).toContain('grid-template-columns: 1fr');
  });

  it('has a reasonable byte size (> 1 KB and < 50 KB)', () => {
    const bytes = Buffer.byteLength(DASHBOARD_HTML, 'utf8');
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(50 * 1024);
  });
});

// ── GET / via real HTTP ──────────────────────────────────────────────────────

describe('GET / — set-log and session-progress sections present', () => {
  it('body includes the set-log section', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchRoot(DEFAULT_DASHBOARD_HOST, handle.port);
    expect(res.body).toContain('id="set-log"');
  });

  it('body includes the session-progress section', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchRoot(DEFAULT_DASHBOARD_HOST, handle.port);
    expect(res.body).toContain('id="session-progress"');
  });

  it('body includes the Peak vel column header', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchRoot(DEFAULT_DASHBOARD_HOST, handle.port);
    expect(res.body).toContain('Peak vel');
  });

  it('body includes the Total volume label', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchRoot(DEFAULT_DASHBOARD_HOST, handle.port);
    expect(res.body).toContain('Total volume');
  });

  it('body size is under 50 KB', async () => {
    const handle = await startWithFake(makeFakeState());
    const res = await fetchRoot(DEFAULT_DASHBOARD_HOST, handle.port);
    const bytes = Buffer.byteLength(res.body, 'utf8');
    expect(bytes).toBeLessThan(50 * 1024);
  });
});
