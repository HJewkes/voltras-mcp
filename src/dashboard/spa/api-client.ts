/**
 * The SPA's shared HTTP helper (VW-500).
 *
 * Reads are plain `fetch`. Writes carry the per-boot token every non-GET route
 * requires, which the SPA gets from the `<meta>` tag the server substitutes
 * into `index.html` at serve time — so the first write after a cold load needs
 * no extra round trip.
 *
 * ── Surviving a restart ───────────────────────────────────────────────────
 *
 * The wall leaves a tab open for days and polls every 2 s. Reads are not
 * guarded, so polling and the auto-refresh are untouched by any of this. A
 * write from a tab whose server has restarted meets a fresh token and is
 * refused with `stale_token`; {@link writeJson} then re-reads the token from
 * `GET /api/bootstrap` and retries ONCE. That makes a stale wall tab heal on
 * its next write instead of needing a human to reload it. A second failure is
 * a real error and surfaces as one.
 */

/** `<meta name>` the server substitutes the token into. Mirrors `write-guard.ts`. */
const TOKEN_META_NAME = 'vmcp-write-token';

/** Request header the server reads the token from. Mirrors `write-guard.ts`. */
const TOKEN_HEADER = 'x-vmcp-dashboard-token';

/** Never a real token: the literal an unsubstituted `index.html` still carries. */
const TOKEN_PLACEHOLDER = '__VMCP_WRITE_TOKEN__';

let cachedToken: string | null = null;

function tokenFromMeta(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector(`meta[name="${TOKEN_META_NAME}"]`);
  const value = meta?.getAttribute('content') ?? '';
  return value === '' || value === TOKEN_PLACEHOLDER ? null : value;
}

async function tokenFromBootstrap(): Promise<string | null> {
  const res = await fetch('/api/bootstrap', { cache: 'no-store' });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string };
  return typeof body.token === 'string' && body.token !== '' ? body.token : null;
}

/** The token for the next write, preferring the one already in hand. */
async function currentToken(): Promise<string | null> {
  cachedToken ??= tokenFromMeta();
  cachedToken ??= await tokenFromBootstrap();
  return cachedToken;
}

/** Drop the held token so the next write re-reads it from the server. */
export function forgetWriteToken(): void {
  cachedToken = null;
}

interface Failure {
  error: string;
  message: string;
  /** The whole parsed body, for callers that read more than `error` and `message`. */
  detail: Record<string, unknown> | null;
}

async function failureOf(res: Response): Promise<Failure> {
  const detail = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const error = detail?.error;
  const message = detail?.message;
  return {
    error: typeof error === 'string' ? error : `http_${res.status}`,
    message: typeof message === 'string' ? message : `HTTP ${res.status}`,
    detail,
  };
}

/** GET a JSON route. Throws on a non-2xx with the server's own message. */
export async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error((await failureOf(res)).message);
  return (await res.json()) as T;
}

/**
 * Thrown when the server cannot say whether a write took effect (VW-502). The
 * caller must re-read state and show the human what is actually stored. It must
 * NOT resubmit under a fresh id: the first attempt may well have landed.
 */
export class IndeterminateWriteError extends Error {
  readonly actionId: string;
  constructor(message: string, actionId: string) {
    super(message);
    this.name = 'IndeterminateWriteError';
    this.actionId = actionId;
  }
}

/**
 * Thrown when an allowlisted tool ran and refused (a non-ok outcome, HTTP 400). The tool's own
 * code survives here, where a bare `Error` would have reduced it to "HTTP 400". The action
 * route sends no `message`, so the message falls back to the code.
 */
export class ActionRefusedError extends Error {
  readonly code: string;
  readonly result: unknown;
  readonly status: number;
  readonly actionId: string;
  constructor(init: {
    code: string;
    message?: string;
    result: unknown;
    status: number;
    actionId: string;
  }) {
    super(init.message ?? init.code);
    this.name = 'ActionRefusedError';
    this.code = init.code;
    this.result = init.result;
    this.status = init.status;
    this.actionId = init.actionId;
  }
}

/** A tool refusal is `ok:false` with the tool's code in `error`; transport errors carry no `ok`. */
function refusalOf(res: Response, failure: Failure, actionId: string): ActionRefusedError | null {
  if (failure.detail?.ok !== false || typeof failure.detail.error !== 'string') return null;
  return new ActionRefusedError({
    code: failure.detail.error,
    ...(typeof failure.detail.message === 'string' ? { message: failure.detail.message } : {}),
    result: failure.detail.result,
    status: res.status,
    actionId,
  });
}

/**
 * Send a guarded write. Retries once on `stale_token`, which is what a tab
 * open across a server restart hits.
 *
 * ── Why the action id is minted here, once per call ──────────────────────
 *
 * The id identifies one SUBMIT, not one request. Both attempts below carry the
 * SAME id, so the stale-token retry cannot write twice: the server claims the
 * id on the first attempt and replays the stored result on the second. Minting
 * per request instead would turn every retry into a second write, which is the
 * exact bug the id exists to prevent.
 */
export async function writeJson<T>(
  method: string,
  url: string,
  body?: unknown,
  actionId?: string,
): Promise<T> {
  const payload = withActionId(body, actionId);
  let res = await sendWrite(method, url, payload);
  if (res.status === 403) {
    const failure = await res
      .clone()
      .json()
      .catch(() => null);
    if ((failure as { error?: string } | null)?.error === 'stale_token') {
      forgetWriteToken();
      res = await sendWrite(method, url, payload);
    }
  }
  if (!res.ok) {
    const failure = await failureOf(res);
    if (failure.error === 'indeterminate') {
      throw new IndeterminateWriteError(failure.message, actionIdOf(payload));
    }
    const refusal = refusalOf(res, failure, actionIdOf(payload));
    if (refusal !== null) throw refusal;
    throw new Error(failure.message);
  }
  return (await res.json()) as T;
}

/** One id per submit. A bodyless write still needs one, so it gets an envelope. */
function withActionId(body: unknown, actionId?: string): Record<string, unknown> {
  const base =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return { ...base, actionId: actionId ?? newActionId() };
}

function actionIdOf(payload: Record<string, unknown>): string {
  return typeof payload.actionId === 'string' ? payload.actionId : '';
}

function newActionId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function sendWrite(method: string, url: string, body: unknown): Promise<Response> {
  const token = await currentToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers[TOKEN_HEADER] = token;
  return fetch(url, {
    method,
    cache: 'no-store',
    headers,
    body: JSON.stringify(body),
  });
}

/** The action route's envelope on success; `result` is the tool's own result. */
export interface ActionResponse<T> {
  ok: true;
  action: string;
  tier?: string;
  actionId: string;
  replayed: boolean;
  result: T;
}

/**
 * Post one allowlisted action (VW-502). Same id discipline as {@link writeJson}, except that a
 * caller retrying unchanged input passes `meta.actionId` to reuse the id the server may already
 * have claimed; an edited input must omit it so a fresh id is minted (the same id with other
 * input is a 409). A tool refusal throws {@link ActionRefusedError}.
 */
export function postAction<T = unknown>(
  name: string,
  input: unknown,
  meta?: { actionId?: string; flowId?: string; flowStep?: string },
): Promise<ActionResponse<T>> {
  return writeJson<ActionResponse<T>>(
    'POST',
    `/api/actions/${encodeURIComponent(name)}`,
    {
      input,
      ...(meta?.flowId === undefined ? {} : { flowId: meta.flowId }),
      ...(meta?.flowStep === undefined ? {} : { flowStep: meta.flowStep }),
    },
    meta?.actionId,
  );
}
