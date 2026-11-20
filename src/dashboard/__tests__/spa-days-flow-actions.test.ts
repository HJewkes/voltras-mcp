// The `#/days` range flow against the real action handlers (VW-847 S4), server side. The page's
// own client (`postMarkKind` with its preview gate and attempt ids) posts to a fetch stub that
// answers from `executeAction` with the boot-captured handlers on a throwaway store, so a
// mismatch, a second refusal, a dropped connection and the Retry that follows run against the
// real guard. The copy each step would put on screen comes from the model functions the page
// renders with; `spa-days-page.test.ts` drives the same sequence through the DOM.
//
// Runs in the node environment: the store needs `node:sqlite`, which a DOM bundle cannot load.
//
// Mock adapter, synthetic rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureActionHandlers, type CapturedTools } from '../../actions/capture-handlers.js';
import { executeAction } from '../../actions/execute.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { readSessionReview } from '../session-review-api.js';
import { forgetWriteToken } from '../spa/api-client.js';
import { postMarkKind } from '../spa/days/days-client.js';
import {
  createAttemptIds,
  createPreviewGate,
  daysErrorOf,
  errorCopy,
  previewLines,
  type Selection,
} from '../spa/days/days-model.js';

interface SentPost {
  actionId: string;
  flowId?: string;
  flowStep?: string;
  input: Record<string, unknown>;
}

const savedEnv = { ...process.env };
let state: ServerState;
let tools: CapturedTools;
let posts: SentPost[];
let failNext = false;
let clockMs = 0;
let seq = 0;

async function seed(id: string, day: string): Promise<void> {
  const at = `${day}T12:00:00.000Z`;
  await state.store.putSession({ id, startedAt: at, endedAt: at });
}

async function serveAction(init: RequestInit | undefined): Promise<Response> {
  const sent = JSON.parse(init?.body as string) as SentPost;
  posts.push(sent);
  if (failNext) {
    failNext = false;
    throw new TypeError('fetch failed');
  }
  const outcome = await executeAction(
    {
      name: 'session.mark_kind',
      actionId: sent.actionId,
      actor: 'user',
      surface: 'wall',
      input: sent.input,
      ...(sent.flowId === undefined ? {} : { flowId: sent.flowId }),
      ...(sent.flowStep === undefined ? {} : { flowStep: sent.flowStep }),
    },
    { store: state.store, tools, now: () => new Date((clockMs += 1000)) },
  );
  return new Response(JSON.stringify(outcome.body), { status: outcome.status });
}

beforeEach(async () => {
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  tools = captureActionHandlers(state);
  forgetWriteToken();
  posts = [];
  failNext = false;
  seq = 0;
  clockMs = Date.parse('2026-09-16T12:00:00.000Z');
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/bootstrap') return Response.json({ token: 'tok' });
    return serveAction(init);
  });
  await seed('s1', '2026-09-10');
  await seed('s2', '2026-09-11');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  forgetWriteToken();
  await state.store.close();
  process.env = { ...savedEnv };
});

const range: Selection = { scope: 'range', from: '2026-09-10', to: '2026-09-11', kind: 'training' };

describe('the #/days range flow against the real action handlers', () => {
  it('runs a mismatch, a second refusal, a dropped confirm and its Retry to one saved mark', async () => {
    const f = {
      flowId: 'days-1',
      gate: createPreviewGate(),
      ids: createAttemptIds(() => `act-${String((seq += 1))}`),
    };
    const preview = async () =>
      previewLines(await postMarkKind({ selection: range, phase: 'preview', ...f }));
    const refusalCopy = async () =>
      errorCopy(
        daysErrorOf(
          await postMarkKind({ selection: range, phase: 'mark', ...f }).catch((e: unknown) => e),
        ),
      );

    expect(await preview()).toContain('Mark 2 sessions on 2 days as training');

    await seed('s3', '2026-09-11');
    expect(await refusalCopy()).toContain('The range changed since the preview');
    expect(await preview()).toContain('Mark 3 sessions on 2 days as training');

    await seed('s4', '2026-09-10');
    expect(await refusalCopy()).toContain('The range changed since the preview');
    expect(await preview()).toContain('Mark 4 sessions on 2 days as training');

    failNext = true;
    expect(await refusalCopy()).toContain('Not saved: the dashboard server did not answer');
    const saved = await postMarkKind({ selection: range, phase: 'mark', ...f });

    const kinds = await Promise.all(
      ['s1', 's2', 's3', 's4'].map(async (id) => (await state.store.getSession(id))?.kind),
    );
    expect(kinds).toEqual(['training', 'training', 'training', 'training']);
    expect([saved.newlyClassified.length, saved.kind]).toEqual([4, 'training']);
    expect(await readSessionReview(state.store, { kind: 'unreviewed', limit: 60 })).toEqual(
      expect.objectContaining({ days: [], unreviewedDays: 0 }),
    );

    const rows = (await state.store.listUiActions()).reverse();
    expect(rows.map((r) => [r.flowStep, r.resultStatus])).toEqual([
      ['range_preview', 'ok'],
      ['range_mark', 'error'],
      ['range_preview', 'ok'],
      ['range_mark', 'error'],
      ['range_preview', 'ok'],
      ['range_mark', 'ok'],
    ]);
    expect(new Set(rows.map((r) => r.actionId)).size).toBe(rows.length);
    const [dropped, retried] = posts.filter((p) => p.flowStep === 'range_mark').slice(-2);
    expect(retried?.actionId).toBe(dropped?.actionId);
  });
});
