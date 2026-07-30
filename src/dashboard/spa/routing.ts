/**
 * Hash routing for the dashboard SPA (VW-120).
 *
 * The sidecar serves the SPA from a single static `index.html` under `/app` with
 * no history-API fallback, so a path-based router would 404 on reload. Hash
 * routes need no server change at all and keep `/app` the only URL the operator
 * has to remember.
 *
 * Pure and side-effect free — `parseRoute` is a string → route function, so the
 * route table is unit-testable without a DOM.
 */

/** The live page — the default, and what the wall display shows. */
export interface LiveRoute {
  name: 'live';
}
/** The session-planning / builder page. */
export interface PlanRoute {
  name: 'plan';
}
/**
 * The session-completion screen. `sessionId` is `'latest'` when the URL names no
 * session — the server resolves that to the most recently started one.
 */
export interface SummaryRoute {
  name: 'summary';
  sessionId: string;
}

export type Route = LiveRoute | PlanRoute | SummaryRoute;

/** Sentinel the server accepts in place of a real session id. */
export const LATEST_SESSION = 'latest';

/**
 * Parse `window.location.hash` into a route. Anything unrecognised — including
 * the empty hash — is the live page, so a stale or hand-typed URL degrades to
 * the wall view rather than a blank screen.
 */
export function parseRoute(hash: string): Route {
  const normalized = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const [head, ...rest] = normalized.split('/');
  if (head === 'plan') return { name: 'plan' };
  if (head === 'summary') {
    const raw = rest[0];
    const sessionId = raw === undefined || raw === '' ? LATEST_SESSION : decodeURIComponent(raw);
    return { name: 'summary', sessionId };
  }
  return { name: 'live' };
}

/** The hash a route serializes to. Inverse of {@link parseRoute}. */
export function routeHash(route: Route): string {
  switch (route.name) {
    case 'plan':
      return '#/plan';
    case 'summary':
      return route.sessionId === LATEST_SESSION
        ? '#/summary'
        : `#/summary/${encodeURIComponent(route.sessionId)}`;
    case 'live':
      return '#/';
  }
}
