// Request guard for the dashboard's non-GET routes (VW-500).
//
// ── What this defends against ─────────────────────────────────────────────
//
// The sidecar's only protection used to be the loopback bind, which stops a
// device on the LAN and stops nothing else: any page open in any browser on
// this machine could POST to the plan-write routes, because a cross-origin
// write does not need to read a response to have happened. These three guards
// close that, and each one is independently sufficient against a different
// attacker:
//
//   1. Origin must be the sidecar's own origin. A hostile page cannot forge
//      `Origin`; the browser sets it. The comparison is against the request's
//      OWN `Host` header, so it survives the EADDRINUSE ephemeral-port
//      fallback (VW-167) and the `127.0.0.1` / `localhost` alias without
//      threading the bound port down here. A missing `Origin` is REJECTED:
//      per the Fetch spec a browser always sends it on a non-GET request,
//      same-origin included, so requiring it costs the SPA nothing and cleanly
//      separates "a browser did this" from a non-browser caller, which sets
//      the header itself.
//   2. The `Host` header must itself be a loopback name. Origin-vs-Host alone
//      is defeated by DNS rebinding — a hostile domain resolving to 127.0.0.1
//      makes the two agree — so the host is checked against the loopback
//      literals as well.
//   3. `content-type` must be `application/json`. A cross-site `<form>` post
//      can only send the three CORS-simple content types, so it cannot reach a
//      handler even if the other two guards were somehow satisfied.
//
// On top of those, a per-boot token minted by {@link mintWriteToken} must
// arrive in {@link WRITE_TOKEN_HEADER}. Sending it as a CUSTOM header is the
// point: a custom header forces a CORS preflight on any cross-origin fetch,
// which this server never answers, so the write never leaves the browser.
//
// What this does NOT defend against, deliberately: another process running as
// this user. It can read the token the same way it can read the sqlite store
// directly. The boundary here is the browser, not the OS account.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Request header carrying the per-boot write token. */
export const WRITE_TOKEN_HEADER = 'x-vmcp-dashboard-token';

/** `<meta name>` the SPA reads its token from in the served `index.html`. */
export const WRITE_TOKEN_META_NAME = 'vmcp-write-token';

/**
 * Literal substituted at serve time in `spa/index.html`. It lives in the
 * source HTML so the vite build carries it into `dist/spa`, and it is never a
 * usable token: a build served without substitution fails the token check and
 * the SPA falls back to `GET /api/bootstrap`.
 */
export const WRITE_TOKEN_PLACEHOLDER = '__VMCP_WRITE_TOKEN__';

/** Host names that mean "this machine", with an optional `:port`. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A guard refusal: the HTTP status and the JSON body to send. */
export interface WriteGuardRejection {
  status: number;
  error: string;
  message: string;
}

/** The headers {@link checkWriteRequest} reads. Lower-cased, as `node:http` gives them. */
export interface WriteGuardHeaders {
  host?: string | undefined;
  origin?: string | undefined;
  contentType?: string | undefined;
  token?: string | undefined;
}

/** Mint a per-boot write token. 32 bytes of CSPRNG output, hex-encoded. */
export function mintWriteToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Check one non-GET request against every guard. Returns `null` when the
 * request may proceed, or the rejection to send.
 *
 * Ordered cheapest-and-most-structural first so a refusal names the outermost
 * thing that is wrong: a request from a rebound domain reads as `foreign_host`
 * rather than as a token problem.
 */
export function checkWriteRequest(
  headers: WriteGuardHeaders,
  expectedToken: string,
): WriteGuardRejection | null {
  return (
    checkHost(headers.host) ??
    checkOrigin(headers.origin, headers.host) ??
    checkContentType(headers.contentType) ??
    checkToken(headers.token, expectedToken)
  );
}

function checkHost(host: string | undefined): WriteGuardRejection | null {
  if (host !== undefined && isLoopbackHost(host)) return null;
  return {
    status: 403,
    error: 'foreign_host',
    message: 'the dashboard answers writes only on a loopback host',
  };
}

function checkOrigin(
  origin: string | undefined,
  host: string | undefined,
): WriteGuardRejection | null {
  if (origin === undefined || origin === '') {
    return {
      status: 403,
      error: 'origin_required',
      message: `a write must carry an Origin header naming the dashboard's own origin`,
    };
  }
  // Both sides lower-cased: a host name is case-insensitive, `parseOriginHost`
  // already normalises, and `isLoopbackHost` does too — comparing a raw `Host`
  // here would refuse an uppercase one that every other rule accepts.
  const originHost = parseOriginHost(origin);
  if (originHost !== null && originHost === host?.toLowerCase()) return null;
  return {
    status: 403,
    error: 'foreign_origin',
    message: 'a write must come from the dashboard itself, not another origin',
  };
}

function checkContentType(contentType: string | undefined): WriteGuardRejection | null {
  const essence = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (essence === 'application/json') return null;
  return {
    status: 415,
    error: 'unsupported_media_type',
    message: 'a write body must be application/json',
  };
}

function checkToken(token: string | undefined, expected: string): WriteGuardRejection | null {
  if (token === undefined || token === '') {
    return {
      status: 403,
      error: 'token_required',
      message: `a write must carry this server's boot token in ${WRITE_TOKEN_HEADER}`,
    };
  }
  if (equalsConstantTime(token, expected)) return null;
  // Named `stale_token` because the overwhelmingly likely cause is a wall tab
  // left open across a restart, and the SPA re-reads `/api/bootstrap` on it.
  return {
    status: 403,
    error: 'stale_token',
    message: 'the write token does not match this server boot',
  };
}

/** True for a `Host` header pointing at this machine, with or without a port. */
export function isLoopbackHost(host: string): boolean {
  const lowered = host.toLowerCase();
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(lowered);
  if (bracketed !== null) return LOOPBACK_HOSTS.has(bracketed[1]);
  const name = lowered.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}

/**
 * The `host` (name plus port) of an `Origin`, or `null` when it is not an
 * http(s) origin. `Origin: null` — a sandboxed iframe or a `file://` page —
 * parses as neither and is refused.
 */
function parseOriginHost(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.host.toLowerCase();
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A cross-origin page can trigger `GET /api/bootstrap` but cannot read its
 * body — the sidecar sends no CORS headers. `Sec-Fetch-Site` lets us refuse the
 * request outright when the browser tells us it is cross-site. Absent (a
 * non-browser client, or an old browser) means the header cannot be trusted
 * either way, so it passes and the opaque-response property carries it.
 */
export function bootstrapFetchSiteAllowed(secFetchSite: string | undefined): boolean {
  return secFetchSite === undefined || secFetchSite === 'same-origin' || secFetchSite === 'none';
}

/** Substitute the real token into the served `index.html`. */
export function injectWriteToken(html: string, token: string): string {
  return html.split(WRITE_TOKEN_PLACEHOLDER).join(token);
}
