// What `GET /api/activity` may serve (VW-893, G10 confidentiality). Every
// served row's keys equal `ACTIVITY_ROW_FIELDS`, the input hash and the stored
// result never leave the server, and a stored summary is cut back to
// `SUMMARY_FIELDS` on the way out. Every value is synthetic.

import { afterEach, describe, expect, it } from 'vitest';

import {
  startDashboardServer,
  DEFAULT_DASHBOARD_HOST,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { ACTIVITY_ROW_FIELDS, toActivityRow, type ActivityPage } from '../activity.js';
import { SUMMARY_FIELDS } from '../../actions/command-summary.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import type { StoredUiAction } from '../../store/types.js';

const PROBE = 'probe-value-must-not-be-served';
const HASH = 'input-hash-must-not-be-served';

const handles: DashboardServerHandle[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
  while (stores.length > 0) await stores.pop()?.close();
});

async function seededStore(): Promise<SessionStore> {
  const store = openTestStore();
  stores.push(store);
  await store.claimUiAction({
    actionId: 'full',
    actionName: 'profile.log_bodyweight',
    actor: 'coach',
    surface: 'mcp',
    deviceId: 'client-1',
    flowId: 'flow-1',
    flowStep: 'step-1',
    reason: 'a reason',
    summaryJson: JSON.stringify({ bodyweightLbs: 180, __probe: PROBE, raw: [1, 2] }),
    sessionId: 'session-1',
    inputHash: HASH,
    createdAt: '2026-08-01T10:00:00.000Z',
  });
  await store.completeUiAction({
    actionId: 'full',
    resultStatus: 'error',
    resultCode: 'TOOL_ERROR',
    result: { secret: PROBE },
    completedAt: '2026-08-01T10:00:01.000Z',
  });
  await store.claimUiAction({
    actionId: 'bare',
    actionName: 'device.connect',
    actor: 'user',
    surface: 'wall',
    inputHash: HASH,
    createdAt: '2026-08-01T09:00:00.000Z',
  });
  return store;
}

async function servedText(store: SessionStore): Promise<string> {
  const state = {
    slots: new Map(),
    store: store as unknown as DashboardServerState['store'],
  } satisfies DashboardServerState;
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  const res = await fetch(`http://${DEFAULT_DASHBOARD_HOST}:${handle.port}/api/activity`);
  expect(res.status).toBe(200);
  return res.text();
}

describe('activity row allowlist', () => {
  it('serves exactly the allowlisted keys on every row', async () => {
    const text = await servedText(await seededStore());
    const body = JSON.parse(text) as ActivityPage;

    expect(Object.keys(body).sort()).toEqual(['nextCursor', 'rows']);
    expect(body.rows).toHaveLength(2);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...ACTIVITY_ROW_FIELDS].sort());
    }
  });

  it('never serves the input hash, the stored result or a non-allowlisted summary field', async () => {
    const text = await servedText(await seededStore());
    const [full] = (JSON.parse(text) as ActivityPage).rows;

    expect(text).not.toContain(HASH);
    expect(text).not.toContain(PROBE);
    for (const key of ['inputHash', 'input_hash', 'result', 'result_json', 'resultJson']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(full.summary).toEqual({ bodyweightLbs: 180 });
    for (const key of Object.keys(full.summary ?? {})) {
      expect(SUMMARY_FIELDS).toContain(key);
    }
  });

  it('builds a row from named fields only, whatever else the stored row carries', () => {
    const stored = {
      actionId: 'x',
      actionName: 'goal.weekly_review',
      actor: 'tick',
      surface: 'wall',
      inputHash: HASH,
      resultStatus: 'ok',
      result: { secret: PROBE },
      createdAt: '2026-08-01T10:00:00.000Z',
      unexpected: PROBE,
    } as StoredUiAction;

    const row = toActivityRow(stored);

    expect(Object.keys(row).sort()).toEqual([...ACTIVITY_ROW_FIELDS].sort());
    expect(JSON.stringify(row)).not.toContain(PROBE);
    expect(JSON.stringify(row)).not.toContain(HASH);
  });
});
