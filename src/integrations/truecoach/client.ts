// Read-only HTTP client for TrueCoach's internal client API.
//
// CONTRACT, and the reviewer should hold this file to it: exactly ONE POST
// ever leaves this module — the OAuth password grant — and every other request
// is a GET. There is no write path here, no PUT/PATCH/DELETE, and no code that
// composes a request body outside `requestToken`. Nothing runs on a timer:
// every request in this file happens because a `truecoach.import_week` call is
// on the stack.
//
// TrueCoach publishes no API. The endpoints, headers and pagination shape come
// from three independent OSS clients (see the research note §1/§4), and the
// vendor's terms make an automated read a policy question, not just a
// technical one — the position we are taking is documented in the README and
// in the tool description, not decided here.
//
// The on-disk response cache holds the RAW compound document, unmapped. That
// is deliberate: mapping is pure, so a cached document lets the parser be
// re-run and re-tested offline without another request against the account.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { TrueCoachConfig } from '../../config.js';
import { log } from '../../logger.js';
import { SecretRedactor } from './redact.js';
import type { RawWorkoutsPage } from './types.js';

const execFileAsync = promisify(execFile);

const API_BASE = 'https://app.truecoach.co/proxy/api';
const TOKEN_PATH = '/oauth/token';

/** Paced, not throttled: TrueCoach's rate limit is undocumented, so keep one import well under any plausible one. */
const MIN_REQUEST_INTERVAL_MS = 500;
/** Hard ceiling per tool call, so a pagination bug cannot loop against a live account. */
const MAX_REQUESTS_PER_CALL = 60;
/** One backoff, then fail. A retry loop against an account we do not own is the wrong failure mode. */
const BACKOFF_MS = 2_000;
/** Cached documents older than this are re-fetched; `refresh: true` bypasses the cache entirely. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
/** Fallback token lifetime when the grant response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1_000;
const PER_PAGE = 50;
const SECRET_FILE_MODE = 0o600;

export class TrueCoachError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TrueCoachError';
  }
}

export interface FetchedPages {
  readonly clientId: string;
  readonly pages: RawWorkoutsPage[];
  /** True when every page was served from the on-disk cache and no request was made. */
  readonly cacheHit: boolean;
}

export interface TrueCoachClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface CachedToken {
  accessToken: string;
  userId: string;
  expiresAt: number;
}

/** The env names the tool reports when credentials are missing. */
export const TRUECOACH_ENV_NAMES = [
  'VMCP_TRUECOACH_USERNAME',
  'VMCP_TRUECOACH_PASSWORD',
  'VMCP_TRUECOACH_PASSWORD_CMD',
] as const;

/** True when enough credentials are present to attempt a grant. */
export function isTrueCoachConfigured(config: TrueCoachConfig): boolean {
  const hasPassword = config.password !== undefined || config.passwordCommand !== undefined;
  return config.username !== undefined && hasPassword;
}

export class TrueCoachClient {
  readonly #config: TrueCoachConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #redactor = new SecretRedactor();
  #token: CachedToken | undefined;
  #requestCount = 0;
  #lastRequestAt = 0;

  constructor(config: TrueCoachConfig, deps: TrueCoachClientDeps = {}) {
    this.#config = config;
    this.#fetch = deps.fetchImpl ?? globalThis.fetch;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#redactor.add(config.password);
  }

  /**
   * Every page of the client's workouts. Serves from the on-disk cache when
   * page 1 is fresh and every page it declares is also cached, which is what
   * makes a re-run after a mapping fix cost nothing.
   */
  async fetchWorkoutPages(opts: { readonly refresh: boolean }): Promise<FetchedPages> {
    // The token file carries the `user_id` from the last grant, so a cache-only
    // run works without `VMCP_TRUECOACH_CLIENT_ID` once one live import has run.
    const clientId = this.#config.clientId ?? this.#readTokenFile()?.userId;
    const cachedFirst = opts.refresh ? undefined : this.#readCache(clientId, 1);
    if (cachedFirst !== undefined && clientId !== undefined) {
      const complete = this.#readCachedRest(clientId, cachedFirst);
      if (complete !== undefined) return { clientId, pages: complete, cacheHit: true };
    }
    return await this.#fetchLive(opts.refresh);
  }

  async #fetchLive(refresh: boolean): Promise<FetchedPages> {
    const token = await this.#authenticate();
    const clientId = this.#config.clientId ?? emptyToUndefined(token.userId);
    if (clientId === undefined) {
      throw new TrueCoachError(
        'TRUECOACH_NO_CLIENT_ID',
        'The grant response carried no user_id. Set VMCP_TRUECOACH_CLIENT_ID to the client id.',
      );
    }
    const pages: RawWorkoutsPage[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const document = refresh ? undefined : this.#readCache(clientId, page);
      const fetched = document ?? (await this.#getPage(clientId, page, token));
      if (document === undefined) this.#writeCache(clientId, page, fetched);
      pages.push(fetched);
      totalPages = Math.max(1, fetched.meta?.total_pages ?? 1);
      page += 1;
    }
    return { clientId, pages, cacheHit: false };
  }

  /** Pages 2..N from cache, or `undefined` when any of them is missing or stale. */
  #readCachedRest(clientId: string, first: RawWorkoutsPage): RawWorkoutsPage[] | undefined {
    const totalPages = Math.max(1, first.meta?.total_pages ?? 1);
    const pages = [first];
    for (let page = 2; page <= totalPages; page += 1) {
      const cached = this.#readCache(clientId, page);
      if (cached === undefined) return undefined;
      pages.push(cached);
    }
    return pages;
  }

  async #getPage(clientId: string, page: number, token: CachedToken): Promise<RawWorkoutsPage> {
    const query = new URLSearchParams({
      order: 'asc',
      page: String(page),
      per_page: String(PER_PAGE),
    });
    const url = `${API_BASE}/clients/${encodeURIComponent(clientId)}/workouts?${query.toString()}`;
    const body = await this.#getJson(url, token);
    return (body ?? {}) as RawWorkoutsPage;
  }

  /**
   * One GET, with a single 2-second backoff on 429/5xx and none on 401.
   *
   * A 401 means the credentials or the token are wrong, and retrying wrong
   * credentials is how an account gets locked — it fails immediately and asks
   * for `refresh`, which drops the cached token.
   */
  async #getJson(url: string, token: CachedToken): Promise<unknown> {
    const headers = {
      Authorization: `Bearer ${token.accessToken}`,
      Role: 'Client',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    };
    const first = await this.#request(url, { method: 'GET', headers });
    if (first.status === 401) {
      throw new TrueCoachError(
        'TRUECOACH_UNAUTHORIZED',
        'TrueCoach rejected the access token (401). Re-run with refresh: true to discard the cached token.',
      );
    }
    if (first.ok) return await this.#json(first);
    if (first.status !== 429 && first.status < 500) throw statusError(first.status, url);
    await this.#sleep(BACKOFF_MS);
    const second = await this.#request(url, { method: 'GET', headers });
    if (!second.ok) throw statusError(second.status, url);
    return await this.#json(second);
  }

  /** Enforces the request budget and the minimum inter-request gap. */
  async #request(url: string, init: RequestInit): Promise<Response> {
    if (this.#requestCount >= MAX_REQUESTS_PER_CALL) {
      throw new TrueCoachError(
        'TRUECOACH_REQUEST_BUDGET',
        `Refusing to exceed ${MAX_REQUESTS_PER_CALL} TrueCoach requests in one call.`,
      );
    }
    const wait = MIN_REQUEST_INTERVAL_MS - (this.#now() - this.#lastRequestAt);
    if (this.#lastRequestAt !== 0 && wait > 0) await this.#sleep(wait);
    this.#requestCount += 1;
    this.#lastRequestAt = this.#now();
    try {
      return await this.#fetch(url, init);
    } catch (err) {
      throw this.#redactor.error(err, 'TRUECOACH_NETWORK');
    }
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      throw this.#redactor.error(err, 'TRUECOACH_BAD_RESPONSE');
    }
  }

  /** In-memory token, else the on-disk one, else the single POST. */
  async #authenticate(): Promise<CachedToken> {
    if (this.#token !== undefined && this.#token.expiresAt > this.#now()) {
      this.#redactor.add(this.#token.accessToken);
      return this.#token;
    }
    const stored = this.#readTokenFile();
    const token = stored ?? (await this.#requestToken());
    this.#token = token;
    this.#redactor.add(token.accessToken);
    if (stored === undefined) this.#writeTokenFile(token);
    return token;
  }

  /**
   * The one POST. A non-2xx here is terminal and never retried: a wrong
   * password must not be replayed, and an MFA-protected account fails the
   * grant the same way every time, so a retry loop would only add attempts to
   * the account's record.
   */
  async #requestToken(): Promise<CachedToken> {
    const password = await this.#resolvePassword();
    this.#redactor.add(password);
    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.#config.username ?? '',
      password,
    });
    const response = await this.#request(`${API_BASE}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!response.ok) throw grantError(response.status);
    return this.#toToken(await this.#json(response));
  }

  #toToken(body: unknown): CachedToken {
    const record = (body ?? {}) as Record<string, unknown>;
    const accessToken = typeof record.access_token === 'string' ? record.access_token : undefined;
    if (accessToken === undefined) {
      throw new TrueCoachError(
        'TRUECOACH_BAD_RESPONSE',
        'The TrueCoach grant response carried no access_token.',
      );
    }
    const ttl = typeof record.expires_in === 'number' ? record.expires_in * 1_000 : undefined;
    return {
      accessToken,
      userId: String(record.user_id ?? ''),
      expiresAt: this.#now() + (ttl ?? DEFAULT_TOKEN_TTL_MS),
    };
  }

  /** `VMCP_TRUECOACH_PASSWORD_CMD` wins when both are set, so a keychain lookup beats a stale env var. */
  async #resolvePassword(): Promise<string> {
    const command = this.#config.passwordCommand;
    if (command === undefined) return this.#config.password ?? '';
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      return stdout.trim();
    } catch (err) {
      throw this.#redactor.error(err, 'TRUECOACH_PASSWORD_CMD_FAILED');
    }
  }

  #readTokenFile(): CachedToken | undefined {
    const parsed = readJsonFile(this.#config.tokenPath);
    if (parsed === undefined) return undefined;
    const record = parsed as Partial<CachedToken>;
    const fresh =
      typeof record.accessToken === 'string' &&
      typeof record.expiresAt === 'number' &&
      record.expiresAt > this.#now();
    return fresh ? { ...(record as CachedToken) } : undefined;
  }

  #writeTokenFile(token: CachedToken): void {
    writeSecretFile(this.#config.tokenPath, JSON.stringify(token), this.#redactor);
  }

  #readCache(clientId: string | undefined, page: number): RawWorkoutsPage | undefined {
    if (clientId === undefined) return undefined;
    const parsed = readJsonFile(this.#cachePath(clientId, page)) as
      | { fetchedAt?: number; document?: RawWorkoutsPage }
      | undefined;
    if (parsed?.document === undefined || typeof parsed.fetchedAt !== 'number') return undefined;
    return this.#now() - parsed.fetchedAt > CACHE_TTL_MS ? undefined : parsed.document;
  }

  #writeCache(clientId: string, page: number, document: RawWorkoutsPage): void {
    const payload = JSON.stringify({ fetchedAt: this.#now(), document });
    writeSecretFile(this.#cachePath(clientId, page), payload, this.#redactor);
  }

  #cachePath(clientId: string, page: number): string {
    return join(this.#config.cacheDir, `${safeSegment(clientId)}-page-${page}.json`);
  }
}

function emptyToUndefined(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/** File names are derived from a server-supplied id; keep them inside the cache directory. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    // Absent, unreadable or corrupt all mean the same thing to every caller:
    // there is no usable cached value, go and fetch one.
    return undefined;
  }
}

/**
 * Write mode 0600. A cache miss is cheap and a token re-grant is cheap, so a
 * write failure is logged (redacted) and swallowed rather than failing an
 * import that has already done its network work.
 */
function writeSecretFile(path: string, contents: string, redactor: SecretRedactor): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents, { encoding: 'utf8', mode: SECRET_FILE_MODE });
  } catch (err) {
    log.warn('truecoach: could not write', path, redactor.text(String(err)));
  }
}

function statusError(status: number, url: string): TrueCoachError {
  const path = url.split('?')[0] ?? url;
  return new TrueCoachError(
    'TRUECOACH_HTTP_ERROR',
    `TrueCoach returned HTTP ${status} for ${path}.`,
  );
}

function grantError(status: number): TrueCoachError {
  const hint =
    status === 401 || status === 403
      ? ' Check the username and password; the password grant also fails this way on an MFA- or SSO-protected account, which this integration cannot complete.'
      : '';
  return new TrueCoachError(
    'TRUECOACH_AUTH_FAILED',
    `TrueCoach rejected the password grant with HTTP ${status}.${hint}`,
  );
}
