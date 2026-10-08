// The review-days client (VW-847 S3): only the network is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionRefusedError, forgetWriteToken } from '../spa/api-client.js';
import { fetchSessionReview, NoFreshPreviewError, postMarkKind } from '../spa/days/days-client.js';
import {
  createAttemptIds,
  createPreviewGate,
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
  const lists = {
    newlyClassified: ['a', 'b'],
    reclassified: [],
    skippedAlreadyMarked: ['c'],
    alreadyThisKind: ['d'],
  };
  const envelope = { ok: true, result: lists };
  const refusal = (error: string) => ({ status: 400, body: { ok: false, error } });
  const base = () => ({ flowId: 'days-1', ids: ids(), gate: createPreviewGate() });

  it('posts the range preview to the action route with its flow step', async () => {
    const calls = fakeFetch([token, { status: 200, body: envelope }]);
    await postMarkKind({ selection: range, phase: 'preview', ...base() });
    expect(calls[1].url).toBe('/api/actions/session.mark_kind');
    expect(calls[1].body).toMatchObject({
      input: { kind: 'training', from: '2026-09-01', to: '2026-09-02', dryRun: true },
      flowId: 'days-1',
      flowStep: 'range_preview',
      actionId: 'id-1',
    });
  });

  it('sends the gate preview four-list sum on a range mark', async () => {
    const calls = fakeFetch([
      token,
      { status: 200, body: envelope },
      { status: 200, body: envelope },
    ]);
    const b = base();
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    await postMarkKind({ selection: range, phase: 'mark', ...b });
    expect(calls[2].body).toMatchObject({ input: { expectSessions: 4 }, flowStep: 'range_mark' });
  });

  it('refuses to confirm without a fresh preview, posting nothing', async () => {
    const calls = fakeFetch([]);
    await expect(postMarkKind({ selection: range, phase: 'mark', ...base() })).rejects.toThrow(
      NoFreshPreviewError,
    );
    expect(calls).toHaveLength(0);
  });

  it('mints a new preview id for a repeat preview after a success', async () => {
    const calls = fakeFetch([
      token,
      { status: 200, body: envelope },
      { status: 200, body: envelope },
    ]);
    const b = base();
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    expect(calls.slice(1).map((c) => c.body?.actionId)).toEqual(['id-1', 'id-2']);
  });

  it('keeps the id on Retry after a transport failure', async () => {
    const calls = fakeFetch([
      token,
      { status: 502, body: { error: 'bad_gateway' } },
      { status: 200, body: envelope },
    ]);
    const b = base();
    await expect(postMarkKind({ selection: range, phase: 'preview', ...b })).rejects.toThrow();
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    expect(calls.slice(1).map((c) => c.body?.actionId)).toEqual(['id-1', 'id-1']);
  });

  it('mints a new id after an edit', async () => {
    const calls = fakeFetch([
      token,
      { status: 200, body: envelope },
      { status: 200, body: envelope },
    ]);
    const b = base();
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    await postMarkKind({ selection: { ...range, kind: 'test' }, phase: 'preview', ...b });
    expect(calls.slice(1).map((c) => c.body?.actionId)).toEqual(['id-1', 'id-2']);
  });

  it('turns a mismatch into a re-preview: gate cleared, no confirm possible', async () => {
    fakeFetch([token, { status: 200, body: envelope }, refusal('EXPECTED_SESSIONS_MISMATCH')]);
    const b = base();
    await postMarkKind({ selection: range, phase: 'preview', ...b });
    const err = await postMarkKind({ selection: range, phase: 'mark', ...b }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ActionRefusedError);
    expect(followUpOf(daysErrorOf(err))).toBe('preview');
    expect(b.gate.canConfirm(range)).toBe(false);
    await expect(postMarkKind({ selection: range, phase: 'mark', ...b })).rejects.toThrow(
      NoFreshPreviewError,
    );
  });

  it('turns NOT_FOUND into a refetch', async () => {
    fakeFetch([token, refusal('NOT_FOUND')]);
    const err = await postMarkKind({
      selection: { scope: 'day', day: '2026-09-01', kind: 'test', reclassify: false },
      phase: 'preview',
      ...base(),
    }).catch((e: unknown) => e);
    expect(followUpOf(daysErrorOf(err))).toBe('refetch');
  });
});
