// The days client against the real action layer (VW-847 S3): captured handlers on a throwaway
// in-memory store, with the fetch stub answering from `executeAction`. This is the only place
// the server's replay of a stored outcome is modelled, which is what an id-reuse bug hides in.
//
// Mock adapter, synthetic rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureActionHandlers, type CapturedTools } from '../../actions/capture-handlers.js';
import { executeAction } from '../../actions/execute.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { forgetWriteToken } from '../spa/api-client.js';
import { postMarkKind } from '../spa/days/days-client.js';
import {
  createAttemptIds,
  createPreviewGate,
  daysErrorOf,
  followUpOf,
  type Selection,
} from '../spa/days/days-model.js';

const savedEnv = { ...process.env };
let state: ServerState;
let tools: CapturedTools;
let seq = 0;
let failNext = false;

beforeEach(async () => {
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  tools = captureActionHandlers(state);
  forgetWriteToken();
  failNext = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/bootstrap') return Response.json({ token: 'tok' });
    if (failNext) {
      failNext = false;
      throw new TypeError('fetch failed');
    }
    const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
    const outcome = await executeAction(
      {
        name: 'session.mark_kind',
        actionId: sent.actionId as string,
        actor: 'user',
        surface: 'wall',
        input: sent.input,
        ...(typeof sent.flowStep === 'string' ? { flowStep: sent.flowStep } : {}),
      },
      { store: state.store, tools, now: () => new Date('2026-09-16T12:00:00.000Z') },
    );
    return new Response(JSON.stringify(outcome.body), { status: outcome.status });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  forgetWriteToken();
  await state.store.close();
  process.env = { ...savedEnv };
});

async function seed(id: string, day: string): Promise<void> {
  const at = `${day}T12:00:00.000Z`;
  await state.store.putSession({ id, startedAt: at, endedAt: at });
}

const range: Selection = { scope: 'range', from: '2026-09-10', to: '2026-09-11', kind: 'training' };

function flow() {
  return {
    flowId: 'days-1',
    gate: createPreviewGate(),
    ids: createAttemptIds(() => `act-${String((seq += 1))}`),
  };
}

describe('the days client through the action layer', () => {
  beforeEach(async () => {
    seq = 0;
    await seed('s1', '2026-09-10');
    await seed('s2', '2026-09-11');
  });

  it('re-previews after a mismatch with the new count, then confirms', async () => {
    const f = flow();
    const first = await postMarkKind({ selection: range, phase: 'preview', ...f });
    expect(first.newlyClassified).toHaveLength(2);
    await seed('s3', '2026-09-11');

    const err = await postMarkKind({ selection: range, phase: 'mark', ...f }).catch(
      (e: unknown) => e,
    );
    expect(followUpOf(daysErrorOf(err))).toBe('preview');
    expect(f.gate.canConfirm(range)).toBe(false);

    const again = await postMarkKind({ selection: range, phase: 'preview', ...f });
    expect(again.newlyClassified).toHaveLength(3);
    await postMarkKind({ selection: range, phase: 'mark', ...f });
    const kinds = await Promise.all(
      ['s1', 's2', 's3'].map(async (id) => (await state.store.getSession(id))?.kind),
    );
    expect(kinds).toEqual(['training', 'training', 'training']);
  });

  it('reaches a fresh preview and a matching confirm on Retry after an error row', async () => {
    const f = flow();
    await postMarkKind({ selection: range, phase: 'preview', ...f });
    await seed('s3', '2026-09-10');
    await postMarkKind({ selection: range, phase: 'mark', ...f }).catch(() => undefined);
    await postMarkKind({ selection: range, phase: 'preview', ...f });

    const done = await postMarkKind({ selection: range, phase: 'mark', ...f });
    expect(done.dryRun).toBe(false);
    const errors = (await state.store.listUiActions()).filter((r) => r.resultStatus === 'error');
    expect(errors).toHaveLength(1);
  });

  it('replays nothing when Retry follows a dropped connection', async () => {
    const f = flow();
    failNext = true;
    await postMarkKind({ selection: range, phase: 'preview', ...f }).catch(() => undefined);
    const preview = await postMarkKind({ selection: range, phase: 'preview', ...f });
    expect(preview.dryRun).toBe(true);
    expect(await state.store.listUiActions()).toHaveLength(1);
  });
});
