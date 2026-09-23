// The SPA's write-token plumbing (VW-500).
//
// The case that matters is the wall: a tab left open across a server restart
// holds a token from the previous boot. Its next write is refused, and the
// helper has to recover WITHOUT a human reloading the page, because nobody is
// standing at the wall to do it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetWriteToken,
  IndeterminateWriteError,
  postAction,
  readJson,
  writeJson,
} from '../spa/api-client.js';

const TOKEN_HEADER = 'x-vmcp-dashboard-token';

interface Call {
  url: string;
  method: string;
  token: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** Records every request and answers from a queue of scripted responses. */
function fakeFetch(responses: { status: number; body: unknown }[]): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      token: headers[TOKEN_HEADER],
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted request to ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => {
  forgetWriteToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetWriteToken();
});

describe('writeJson', () => {
  it('reads the token from /api/bootstrap and sends it on the write', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 201, body: { ok: true } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await expect(writeJson('POST', '/api/plan/programs', { name: 'P' })).resolves.toEqual({
      ok: true,
    });
    expect(calls.map((c) => c.url)).toEqual(['/api/bootstrap', '/api/plan/programs']);
    expect(calls[1].token).toBe('tok-1');
  });

  it('holds the token, so a second write costs no extra round trip', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 201, body: {} },
      { status: 201, body: {} },
    ]);
    vi.stubGlobal('fetch', fetch);
    await writeJson('POST', '/api/plan/programs', { name: 'P' });
    await writeJson('POST', '/api/plan/programs', { name: 'Q' });
    expect(calls.filter((c) => c.url === '/api/bootstrap')).toHaveLength(1);
  });

  it('re-reads the token and retries once when the server restarted under it', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-old' } },
      { status: 403, body: { error: 'stale_token', message: 'no' } },
      { status: 200, body: { token: 'tok-new' } },
      { status: 201, body: { ok: true } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await expect(writeJson('POST', '/api/plan/programs', { name: 'P' })).resolves.toEqual({
      ok: true,
    });
    expect(calls.map((c) => c.token)).toEqual([undefined, 'tok-old', undefined, 'tok-new']);
  });

  it('does not retry a refusal that a new token cannot fix', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 403, body: { error: 'foreign_origin', message: 'wrong origin' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await expect(writeJson('POST', '/api/plan/programs', {})).rejects.toThrow('wrong origin');
    expect(calls).toHaveLength(2);
  });

  it('surfaces the server message when the retry fails too', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-old' } },
      { status: 403, body: { error: 'stale_token', message: 'stale' } },
      { status: 200, body: { token: 'tok-new' } },
      { status: 403, body: { error: 'stale_token', message: 'still stale' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await expect(writeJson('POST', '/api/plan/programs', {})).rejects.toThrow('still stale');
  });
});

describe('readJson', () => {
  it('sends no token, so the wall poll is unaffected by any of this', async () => {
    const { calls, fetch } = fakeFetch([{ status: 200, body: { programs: [] } }]);
    vi.stubGlobal('fetch', fetch);
    await readJson('/api/plan-tree');
    expect(calls).toEqual([
      { url: '/api/plan-tree', method: 'GET', token: undefined, body: undefined },
    ]);
  });
});

describe('the action id', () => {
  it('rides along on every write, as a fresh id per submit', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 201, body: {} },
      { status: 201, body: {} },
    ]);
    vi.stubGlobal('fetch', fetch);
    await writeJson('POST', '/api/plan/programs', { name: 'A' });
    await writeJson('POST', '/api/plan/programs', { name: 'B' });
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes[0].body).toMatchObject({ name: 'A' });
    expect(typeof writes[0].body?.actionId).toBe('string');
    // Two SUBMITS are two actions, so two ids.
    expect(writes[0].body?.actionId).not.toBe(writes[1].body?.actionId);
  });

  it('reuses ONE id across the stale-token retry, so a restart cannot double-write', async () => {
    // The bug this exists to prevent: minting per REQUEST would make the retry
    // a second write. The server replays instead.
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-old' } },
      { status: 403, body: { error: 'stale_token', message: 'no' } },
      { status: 200, body: { token: 'tok-new' } },
      { status: 201, body: {} },
    ]);
    vi.stubGlobal('fetch', fetch);
    await writeJson('POST', '/api/plan/programs', { name: 'A' });
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0].body?.actionId).toBe(writes[1].body?.actionId);
  });

  it('gives a bodyless write an envelope, because it still needs an id', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 200, body: {} },
    ]);
    vi.stubGlobal('fetch', fetch);
    await writeJson('DELETE', '/api/plan/exercises/pe-1');
    const write = calls.find((c) => c.method === 'DELETE');
    expect(typeof write?.body?.actionId).toBe('string');
  });
});

describe('an indeterminate write', () => {
  it('throws its own error type rather than a plain failure', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 409, body: { error: 'indeterminate', message: 'outcome unknown' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await expect(writeJson('POST', '/api/plan/programs', { name: 'A' })).rejects.toBeInstanceOf(
      IndeterminateWriteError,
    );
  });

  it('is NOT retried, because the first attempt may have landed', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 409, body: { error: 'indeterminate', message: 'outcome unknown' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await writeJson('POST', '/api/plan/programs', { name: 'A' }).catch(() => undefined);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('carries the action id, so a caller can say which submit is unresolved', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 409, body: { error: 'indeterminate', message: 'outcome unknown' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    let error: IndeterminateWriteError | undefined;
    try {
      await writeJson('POST', '/api/plan/programs', { name: 'A' });
    } catch (err) {
      error = err as IndeterminateWriteError;
    }
    const sent = calls.find((c) => c.method === 'POST');
    expect(error?.actionId).toBe(sent?.body?.actionId);
  });
});

describe('postAction', () => {
  it('posts to the action route with the input nested under `input`', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { token: 'tok-1' } },
      { status: 200, body: { ok: true } },
    ]);
    vi.stubGlobal('fetch', fetch);
    await postAction('profile.log_bodyweight', { weightLbs: 180 }, { flowId: 'sunday-1' });
    const write = calls.find((c) => c.method === 'POST');
    expect(write?.url).toBe('/api/actions/profile.log_bodyweight');
    expect(write?.body).toMatchObject({ input: { weightLbs: 180 }, flowId: 'sunday-1' });
    expect(typeof write?.body?.actionId).toBe('string');
  });
});
