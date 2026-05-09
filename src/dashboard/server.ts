// HTTP sidecar that exposes voltras-mcp live state to a local browser
// dashboard. Pure `node:http` — no framework, no extra dependencies.
//
// ── Loopback only ─────────────────────────────────────────────────────────
//
// The server binds to `127.0.0.1` (default), NOT `0.0.0.0`. This is a
// deliberate security posture: the MCP process itself is a single-user
// stdio process, and the dashboard exposes session-scoped data plus a
// session-history listing. Allowing connections from anywhere on the LAN
// would surface that data to other devices on the same network without
// any auth check.
//
// If a future caller wants to reach the dashboard from a phone or another
// machine on their LAN, they should add an opt-in `host` override AND a
// bearer-token check. CORS headers are intentionally absent today for the
// same reason — once cross-origin reads are allowed, the loopback bind is
// the only thing keeping the dashboard private.
//
// ── Lifecycle ─────────────────────────────────────────────────────────────
//
// `startDashboardServer({ port, state })` returns a `DashboardServerHandle`
// once the underlying `http.Server` has emitted `listening`. Failures
// (port-in-use, EACCES) reject the returned promise rather than throwing
// asynchronously through an `error` event listener nobody catches. The
// handle's `close()` releases the port; idempotent so `runServer`'s
// shutdown hook can call it without tracking whether `start` succeeded.
//
// ── Endpoints ─────────────────────────────────────────────────────────────
//
//   GET /                — placeholder HTML (panels are added in follow-up
//                          loop tasks).
//   GET /api/snapshot    — { session, devices, sets } JSON. Live view of
//                          the active session, every slot's device snapshot,
//                          and the active set if any.
//   GET /api/health      — { ok, version, uptimeMs } JSON.
//   GET /api/history     — { sessions: StoredSession[] } JSON. `?limit=N`
//                          query parameter, capped at 100.
//   GET /<anything else> — 404 JSON `{ error: 'not_found' }`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_HTML } from './dashboard-html.js';
import { log } from '../logger.js';
import type { DeviceSnapshot, ActiveSession, ActiveSet } from '../state/live-state.js';
import type { StoredSession } from '../store/types.js';

/** Default loopback port. Configurable via `VMCP_DASHBOARD_PORT`. */
export const DEFAULT_DASHBOARD_PORT = 7723;
/** Default bind address — loopback only. See module header for rationale. */
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
/** Hard cap on `?limit=` for `/api/history`. Anything larger is clamped. */
export const HISTORY_MAX_LIMIT = 100;
/** Default `?limit=` for `/api/history` when the query parameter is absent. */
export const HISTORY_DEFAULT_LIMIT = 20;

export interface DashboardServerOptions {
  /** TCP port. Pass `0` for auto-assignment. Defaults to {@link DEFAULT_DASHBOARD_PORT}. */
  port?: number;
  /** Bind address. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** Live server state. Snapshot/history endpoints read from this. */
  state: DashboardServerState;
}

/**
 * Narrow slice of `ServerState` the dashboard actually needs. Defining this
 * locally (rather than `Pick<ServerState, ...>`) keeps the test fakes simple
 * — they don't have to fabricate a full ServerState shape.
 */
export interface DashboardServerState {
  slots: ReadonlyMap<
    string,
    {
      live: {
        snapshotDevice(): DeviceSnapshot;
        snapshotSession(): ActiveSession | undefined;
        snapshotSet(): ActiveSet | undefined;
      };
    }
  >;
  store: {
    listSessions(filter: {
      sort: 'startedAt:desc' | 'startedAt:asc';
      limit: number;
      offset: number;
    }): Promise<StoredSession[]>;
  };
}

export interface DashboardServerHandle {
  /** The port the server actually bound to (resolved from `port: 0`). */
  readonly port: number;
  /** Stop accepting connections and free the port. Idempotent. */
  close(): Promise<void>;
}

interface DeviceEntry {
  slotId: string;
  device: DeviceSnapshot;
}

interface SnapshotResponse {
  session: ActiveSession | null;
  devices: DeviceEntry[];
  sets: { active: ActiveSet | null };
}


/**
 * Start the dashboard HTTP sidecar. Resolves once the server is listening on
 * the resolved port; rejects on bind failure (port-in-use, EACCES, etc.).
 */
export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServerHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const host = opts.host ?? DEFAULT_DASHBOARD_HOST;
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    handleRequest(req, res, opts.state, startedAt).catch((err) => {
      log.warn('dashboard: handler threw', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        res.end();
      }
    });
  });

  return new Promise<DashboardServerHandle>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onListenError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve(makeHandle(server, boundPort));
    };
    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function makeHandle(server: Server, port: number): DashboardServerHandle {
  let closed = false;
  return {
    port,
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Force-close any keep-alive connections so a hung browser tab
        // doesn't keep the listener alive past process shutdown. Tests
        // also rely on this to avoid leaking handles.
        server.closeAllConnections?.();
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: DashboardServerState,
  startedAt: number,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const rawUrl = req.url ?? '/';
  // The first arg to URL must be a full URL — synth a base because
  // IncomingMessage.url is a path-only string.
  const url = new URL(rawUrl, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/') {
    sendHtml(res, 200, DASHBOARD_HTML);
    return;
  }
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: VMCP_VERSION,
      uptimeMs: Date.now() - startedAt,
    });
    return;
  }
  if (pathname === '/api/snapshot') {
    sendJson(res, 200, buildSnapshot(state));
    return;
  }
  if (pathname === '/api/history') {
    const sessions = await fetchHistory(state, url);
    sendJson(res, 200, { sessions });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

function buildSnapshot(state: DashboardServerState): SnapshotResponse {
  const devices: DeviceEntry[] = [];
  let session: ActiveSession | undefined;
  let activeSet: ActiveSet | undefined;
  for (const [slotId, slot] of state.slots) {
    devices.push({ slotId, device: slot.live.snapshotDevice() });
    // First slot wins for session/set — single-session contract today; if
    // a future slot has its own active session/set, the snapshot still
    // reports the primary one (devices[] always carries every slot).
    if (session === undefined) {
      session = slot.live.snapshotSession();
    }
    if (activeSet === undefined) {
      activeSet = slot.live.snapshotSet();
    }
  }
  return {
    session: session ?? null,
    devices,
    sets: { active: activeSet ?? null },
  };
}

async function fetchHistory(
  state: DashboardServerState,
  url: URL,
): Promise<readonly StoredSession[]> {
  const limit = parseLimit(url.searchParams.get('limit'));
  return state.store.listSessions({
    sort: 'startedAt:desc',
    limit,
    offset: 0,
  });
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return HISTORY_DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return HISTORY_DEFAULT_LIMIT;
  if (parsed > HISTORY_MAX_LIMIT) return HISTORY_MAX_LIMIT;
  return parsed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

interface PackageJsonShape {
  name?: string;
  version?: string;
}

/**
 * Walk up from this module to find voltras-mcp's `package.json` and return
 * its `version`. Mirrors the lookup in `tools/server-tools.ts` — duplicated
 * intentionally so the dashboard module has no dependency on the tool layer.
 */
function readVoltrasMcpVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'package.json');
      try {
        const body = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(body) as PackageJsonShape;
        if (parsed.name === 'voltras-mcp' && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // not a manifest — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

const VMCP_VERSION = readVoltrasMcpVersion();
