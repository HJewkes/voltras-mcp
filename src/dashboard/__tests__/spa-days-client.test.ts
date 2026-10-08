// The review-days client (VW-847 S3): only the network is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionRefusedError, forgetWriteToken } from '../spa/api-client.js';
import { fetchSessionReview, postMarkKind } from '../spa/days/days-client.js';
import {
  createAttemptIds,
  daysErrorOf,
  followUpOf,
  type Selection,
} from '../spa/days/days-model.js';

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

function fakeFetch(responses: { status: number; body: unknown }[]): Call[] {
  const calls: Call[] = [];
  const queue = [...responses];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted request to ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  return calls;
}

const token = { status: 200, body: { token: 'tok' } };
const range: Selection = { scope: 'range', from: '2026-09-01', to: '2026-09-02', kind: 'training' };

const ids = () => {
  let n = 0;
  return createAttemptIds(() => `id-${String(++n)}`);
};

beforeEach(() => forgetWriteToken());
afterEach(() => {
  vi.unstubAllGlobals();
  forgetWriteToken();
});

describe('fetchSessionReview', () => {
  it('reads the waiting days by default', async () => {
    const calls = fakeFetch([{ status: 200, body: { days: [], unreviewedDays: 0 } }]);
    await expect(fetchSessionReview()).resolves.toEqual({ days: [], unreviewedDays: 0 });
    expect(calls[0].url).toBe('/api/session-review?kind=unreviewed');
  });

  it('passes kind and limit through', async () => {
    const calls = fakeFetch([{ status: 200, body: { days: [], unreviewedDays: 0 } }]);
    await fetchSessionReview('any', 20);
    expect(calls[0].url).toBe('/api/session-review?kind=any&limit=20');
  });
});

describe('postMarkKind', () => {
  const envelope = { ok: true, result: { newlyClassified: ['a'] } };

  it('posts the range preview to the action route with its flow step', async () => {
    const calls = fakeFetch([token, { status: 200, body: envelope }]);
    await postMarkKind({
      selection: range,
      phase: 'preview',
      flowId: 'days-1',
      ids: ids(),
    });
    expect(calls[1].url).toBe('/api/actions/session.mark_kind');
    expect(calls[1].body).toMatchObject({
      input: { kind: 'training', from: '2026-09-01', to: '2026-09-02', dryRun: true },
      flowId: 'days-1',
      flowStep: 'range_preview',
      actionId: 'id-1',
    });
  });

  it('reuses the action id on Retry and mints a new one after an edit', async () => {
    const calls = fakeFetch([
      token,
      { status: 200, body: envelope },
      { status: 200, body: envelope },
      { status: 200, body: envelope },
    ]);
    const held = ids();
    const post = (selection: Selection) =>
      postMarkKind({ selection, phase: 'preview', flowId: 'days-1', ids: held });
    await post(range);
    await post(range);
    await post({ ...range, kind: 'test' });
    const used = calls.slice(1).map((c) => c.body?.actionId);
    expect(used).toEqual(['id-1', 'id-1', 'id-2']);
  });

  it('sends the previewed count on a range mark', async () => {
    const calls = fakeFetch([token, { status: 200, body: envelope }]);
    await postMarkKind({ selection: range, phase: 'mark', expected: 6, flowId: 'f', ids: ids() });
    expect(calls[1].body).toMatchObject({
      input: { expectSessions: 6 },
      flowStep: 'range_mark',
    });
  });

  it('turns a mismatch into a re-preview, not a confirm', async () => {
    fakeFetch([token, { status: 400, body: { ok: false, error: 'EXPECTED_SESSIONS_MISMATCH' } }]);
    const err = await postMarkKind({
      selection: range,
      phase: 'mark',
      expected: 6,
      flowId: 'f',
      ids: ids(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionRefusedError);
    expect(followUpOf(daysErrorOf(err))).toBe('preview');
  });

  it('turns NOT_FOUND into a refetch', async () => {
    fakeFetch([token, { status: 400, body: { ok: false, error: 'NOT_FOUND' } }]);
    const err = await postMarkKind({
      selection: { scope: 'day', day: '2026-09-01', kind: 'test', reclassify: false },
      phase: 'preview',
      flowId: 'f',
      ids: ids(),
    }).catch((e: unknown) => e);
    expect(followUpOf(daysErrorOf(err))).toBe('refetch');
  });
});
