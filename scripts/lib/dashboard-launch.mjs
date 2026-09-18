// Booting one no-hardware dashboard, shared by `npm run docs:captures`
// (scripts/capture-screens.mjs) and `npm run dashboard:preview`
// (scripts/dashboard-preview.mjs).
//
// Both want the same thing: a mock-adapter MCP server on a probed-free port,
// over a store that is never `~/.voltras/vmcp.sqlite`, held until someone stops
// it. The capture harness owned this code first; the preview command reuses it
// rather than growing a second copy that drifts (VW-416).
//
// ── Isolation ──────────────────────────────────────────────────────────────
// Every scenario gets its own `VMCP_DB_PATH` under a caller-owned temp
// directory, and a probed-free `VMCP_DASHBOARD_PORT`. The real store is never
// opened: the captures are published and the preview is a toy, and that file
// holds real training history. `VMCP_DASHBOARD_PORT=0` is NOT the way to get an
// ephemeral port — `resolveDashboardPort` (src/server.ts) reads `0` as "off"
// and the dashboard never binds at all.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as net from 'node:net';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN_PATH = path.join(REPO_ROOT, 'dist/bin.js');

/** How often a poll re-reads the sidecar. Well under the SPA's own 2s poll. */
export const POLL_MS = 250;

/** How long the dashboard sidecar gets to bind after the driver starts. */
export const DASHBOARD_BIND_TIMEOUT_MS = 60_000;

/**
 * Connection-level `fetch` retries per read. Three at {@link POLL_MS} apart
 * covers the intermittent reject a heavily loaded machine produces without
 * masking a sidecar that has actually gone away — a caller's own timeout still
 * expires on schedule.
 */
const TRANSIENT_FETCH_RETRIES = 3;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An OS-assigned free port, released immediately before we hand it to a child. */
export function probeFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function getJson(port, route) {
  // A connection-level failure is retried; an HTTP status is not. On a loaded
  // machine `fetch` to the sidecar intermittently rejects outright, and one of
  // those used to abort a six-minute run several scenarios in. A 500 is a real
  // answer from a server that is up, so retrying it would only hide it.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${route}`);
      if (!res.ok) throw new Error(`${route} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= TRANSIENT_FETCH_RETRIES || /^\S+ -> \d+$/.test(err.message)) throw err;
      await sleep(POLL_MS);
    }
  }
}

/** Minimal MCP handshake: the dashboard sidecar only binds once a client activates. */
export function handshake(child, clientName) {
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * The store one scenario runs over. Exported so a caller can SEED that file
 * before {@link startScenario} opens it — two processes must never hold one
 * `VMCP_DB_PATH` (see the repo's CLAUDE.md).
 */
export function scenarioDbPath(dbDir, name) {
  return path.join(dbDir, `${name}.sqlite`);
}

/**
 * A child's output with the MCP transport's own traffic dropped. A driver
 * forwards the server's stdout, which is JSON-RPC: echoing it verbatim buries
 * the driver's own progress lines under every `tools/list_changed` the
 * bootstrap sends.
 */
function withoutTransport(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('{"'))
    .join('\n');
}

/**
 * Start a scenario and return `{ port, stop, tail }`. `driver: null` boots the
 * server directly and holds whatever state the store already carries; a driver
 * is spawned detached so stopping it signals the whole group, including the MCP
 * server it owns as a grandchild.
 */
export async function startScenario(scenario, dbDir, options = {}) {
  const log = options.log ?? (() => {});
  const clientName = options.clientName ?? 'dashboard-launch';
  const port = options.port ?? (await probeFreePort());
  const controlPort = await probeFreePort();
  const dbPath = scenarioDbPath(dbDir, scenario.name);
  const substitute = (arg) =>
    arg.replace('{port}', String(port)).replace('{controlPort}', String(controlPort));
  const env = {
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VOLTRA_LOG_LEVEL: 'warn',
    VMCP_DASHBOARD_PORT: String(port),
    VMCP_DB_PATH: dbPath,
  };

  const child = scenario.driver
    ? spawn(process.execPath, [scenario.driver, ...scenario.args.map(substitute)], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    : spawn(process.execPath, [BIN_PATH], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });

  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      // A capture wants the tail only, to attach to a failure. A preview is
      // watched by a human while a driver works, so it asks for the running
      // commentary too.
      if (options.echo === true) process.stderr.write(withoutTransport(text));
    });
  }
  if (!scenario.driver) handshake(child, clientName);

  const deadline = Date.now() + DASHBOARD_BIND_TIMEOUT_MS;
  for (;;) {
    try {
      await getJson(port, '/api/snapshot');
      break;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `${scenario.name}: dashboard never bound on :${port} (${err.message})\n${tail}`,
        );
      }
      await sleep(POLL_MS);
    }
  }
  log(`${scenario.name}: dashboard on :${port}`);

  const stop = () => {
    try {
      if (scenario.driver) process.kill(-child.pid, 'SIGINT');
      else child.stdin.end();
    } catch {
      // already gone
    }
    child.kill('SIGKILL');
  };
  return { port, stop, tail: () => tail };
}
