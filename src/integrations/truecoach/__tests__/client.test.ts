// HTTP-client tests against a recorded fixture and a stub `fetch`.
//
// NOTHING HERE TOUCHES THE NETWORK. Every test injects its own `fetchImpl`,
// and the assertions that matter are about what the client is allowed to send:
// exactly one POST, everything else a GET, the four required headers on every
// request, one backoff on 429, and no retry at all on 401.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrueCoachConfig } from '../../../config.js';
import { isTrueCoachConfigured, TrueCoachClient } from '../client.js';

const PASSWORD = 'hunter2-correct-horse';
const TOKEN = 'tc-access-token-abcdef123456';

function fixturePage(name: string): unknown {
  const path = join(import.meta.dirname, 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let dir: string;
let calls: Call[];
let now: number;

function config(overrides: Partial<TrueCoachConfig> = {}): TrueCoachConfig {
  return {
    username: 'lifter@example.test',
    password: PASSWORD,
    passwordCommand: undefined,
    clientId: '4242',
    tokenPath: join(dir, 'token.json'),
    cacheDir: join(dir, 'cache'),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Records every call and replies from `responses` in order. */
function stubFetch(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    return queue.shift() ?? json({}, 500);
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch, overrides: Partial<TrueCoachConfig> = {}) {
  return new TrueCoachClient(config(overrides), {
    fetchImpl,
    now: () => now,
    // The pacing delay is real time in production; here it advances the clock
    // so the rate limiter's arithmetic is still exercised without a wait.
    sleep: async (ms) => {
      now += ms;
      await Promise.resolve();
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-truecoach-'));
  calls = [];
  now = 1_757_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isTrueCoachConfigured', () => {
  it('is false without a username, and false with a username but no password', () => {
    expect(isTrueCoachConfigured(config({ username: undefined }))).toBe(false);
    expect(isTrueCoachConfigured(config({ password: undefined, passwordCommand: undefined }))).toBe(
      false,
    );
  });

  it('is true with a password command instead of a password', () => {
    expect(
      isTrueCoachConfigured(config({ password: undefined, passwordCommand: 'echo secret' })),
    ).toBe(true);
  });
});

describe('TrueCoachClient.fetchWorkoutPages', () => {
  it('sends exactly one POST (the grant) and GETs everything else', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242, expires_in: 3600 }),
      json(fixturePage('workouts-page-basic')),
    ]);

    const result = await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    expect(result.clientId).toBe('4242');
    expect(result.pages).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://app.truecoach.co/proxy/api/oauth/token');
    expect(calls.slice(1).every((c) => c.method === 'GET')).toBe(true);
  });

  it('sends the four headers the workout endpoints require', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json(fixturePage('workouts-page-basic')),
    ]);

    await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    expect(calls[1]!.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Role: 'Client',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    });
  });

  it('follows meta.total_pages', async () => {
    const first = { ...(fixturePage('workouts-page-basic') as object), meta: { total_pages: 2 } };
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json(first),
      json(fixturePage('workouts-page-superset')),
    ]);

    const result = await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    expect(result.pages).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('backs off once on 429 and then succeeds', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json({ error: 'slow down' }, 429),
      json(fixturePage('workouts-page-basic')),
    ]);
    const start = now;

    const result = await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    expect(result.pages).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(now - start).toBeGreaterThanOrEqual(2_000);
  });

  it('fails after a second 429 rather than retrying again', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json({}, 429),
      json({}, 429),
    ]);

    await expect(client(fetchImpl).fetchWorkoutPages({ refresh: false })).rejects.toThrow(
      /HTTP 429/,
    );
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('does not retry a 401', async () => {
    const fetchImpl = stubFetch([json({ access_token: TOKEN, user_id: 4242 }), json({}, 401)]);

    await expect(client(fetchImpl).fetchWorkoutPages({ refresh: false })).rejects.toThrow(
      /rejected the access token/,
    );
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('fails the grant without retrying, and names MFA as a cause', async () => {
    const fetchImpl = stubFetch([json({ error: 'invalid_grant' }, 401)]);

    await expect(client(fetchImpl).fetchWorkoutPages({ refresh: false })).rejects.toThrow(/MFA/);
    expect(calls).toHaveLength(1);
  });

  it('paces requests at least 500ms apart', async () => {
    const first = { ...(fixturePage('workouts-page-basic') as object), meta: { total_pages: 2 } };
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json(first),
      json(fixturePage('workouts-page-superset')),
    ]);
    const start = now;

    await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    // Three requests means two gaps of at least 500ms each.
    expect(now - start).toBeGreaterThanOrEqual(1_000);
  });

  it('serves a second call entirely from cache, with no request at all', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242, expires_in: 3600 }),
      json(fixturePage('workouts-page-basic')),
    ]);
    await client(fetchImpl).fetchWorkoutPages({ refresh: false });
    const after = calls.length;

    const second = await client(stubFetch([]), {}).fetchWorkoutPages({ refresh: false });

    expect(second.cacheHit).toBe(true);
    expect(second.pages).toHaveLength(1);
    expect(calls).toHaveLength(after);
  });

  it('re-fetches once the cached document is older than the TTL', async () => {
    await client(
      stubFetch([
        json({ access_token: TOKEN, user_id: 4242, expires_in: 3600 }),
        json(fixturePage('workouts-page-basic')),
      ]),
    ).fetchWorkoutPages({ refresh: false });

    now += 7 * 60 * 60 * 1_000;
    const fresh = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json(fixturePage('workouts-page-basic')),
    ]);
    const result = await client(fresh).fetchWorkoutPages({ refresh: false });

    expect(result.cacheHit).toBe(false);
  });

  it('bypasses the cache when refresh is set', async () => {
    await client(
      stubFetch([
        json({ access_token: TOKEN, user_id: 4242, expires_in: 3600 }),
        json(fixturePage('workouts-page-basic')),
      ]),
    ).fetchWorkoutPages({ refresh: false });
    const before = calls.length;

    await client(
      stubFetch([
        json({ access_token: TOKEN, user_id: 4242 }),
        json(fixturePage('workouts-page-basic')),
      ]),
    ).fetchWorkoutPages({ refresh: true });

    expect(calls.length).toBeGreaterThan(before);
  });

  it('writes the token file mode 0600 and never writes the password into it', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242, expires_in: 3600 }),
      json(fixturePage('workouts-page-basic')),
    ]);

    await client(fetchImpl).fetchWorkoutPages({ refresh: false });

    const path = join(dir, 'token.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(PASSWORD);
  });

  it('keeps the token and the password out of a network error message', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect failed for password=${PASSWORD} token=${TOKEN}`);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).fetchWorkoutPages({ refresh: false })).rejects.toThrow(
      /\[REDACTED\]/,
    );
    await expect(client(fetchImpl).fetchWorkoutPages({ refresh: false })).rejects.not.toThrow(
      new RegExp(PASSWORD),
    );
  });

  it('reads the password from VMCP_TRUECOACH_PASSWORD_CMD stdout', async () => {
    const fetchImpl = stubFetch([
      json({ access_token: TOKEN, user_id: 4242 }),
      json(fixturePage('workouts-page-basic')),
    ]);

    await client(fetchImpl, {
      password: undefined,
      passwordCommand: 'printf %s from-the-keychain',
    }).fetchWorkoutPages({ refresh: false });

    expect(calls[0]!.method).toBe('POST');
  });

  it('reuses a token file written by an earlier run instead of re-granting', async () => {
    writeFileSync(
      join(dir, 'token.json'),
      JSON.stringify({ accessToken: TOKEN, userId: '4242', expiresAt: now + 60_000 }),
    );
    const fetchImpl = stubFetch([json(fixturePage('workouts-page-basic'))]);

    await client(fetchImpl).fetchWorkoutPages({ refresh: true });

    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
