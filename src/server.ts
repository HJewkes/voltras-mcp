// Server entry point. Owns the process lifecycle:
//   1. loadConfig() and build a `ClientConnection` (see client-connection.ts)
//      — an `McpServer` with `STARTING` placeholders for every tool name
//      (R6/EC-16) and resources pre-registered.
//   2. Connect `StdioServerTransport` (R5 — only stdio in v1).
//   3. Run `bootstrapState(config)` — opens BLE adapter + SQLite store. May
//      take measurable time.
//   4. On success: wire the process-wide state collaborators (channel
//      publisher, server handle, event bridge), then `connection.activate`
//      to swap placeholders for real handlers.
//   5. On failure: close the server (releases the transport — FIX #8) before
//      `process.exit(1)` so a request queued mid-teardown doesn't get a
//      `STARTING` reply just before the channel disappears.
//
// Approach choice: PLACEHOLDER-REPLACE. The MCP SDK's `RegisteredTool`
// exposes `.update({ callback })` (see `node_modules/@modelcontextprotocol
// /sdk/dist/esm/server/mcp.d.ts:278`), so the same `RegisteredTool`
// reference can be hot-swapped after bootstrap — no dispatch table needed.
//
// VMCP-01.60 split this file in two. Everything PER-CONNECTION moved to
// `client-connection.ts`; what stays here is what is genuinely
// PER-PROCESS: config, bootstrap, the event bridge, the dashboard sidecar,
// and the shutdown hook. The daemon (VMCP-01.62) keeps this file's job and
// creates N connections instead of one.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { configureLogger, log } from './logger.js';
import { bootstrapState, type ServerState } from './state/server-state.js';
import { wireEventBridge } from './state/event-bridge.js';
import { maybeCueTee } from './voice/cue-emitter.js';
import {
  createClientConnection,
  registerClient,
  type ClientConnection,
} from './client-connection.js';
import {
  startDashboardServer,
  isAddressInUse,
  dashboardPortInUseMessage,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_HOST,
  type DashboardServerHandle,
} from './dashboard/server.js';

/**
 * Resolve the dashboard sidecar port from `VMCP_DASHBOARD_PORT`. Returns
 * `null` when the user has explicitly disabled the sidecar (`'off'` or
 * `'0'`); returns the parsed port otherwise. Invalid / non-numeric values
 * fall back to {@link DEFAULT_DASHBOARD_PORT} so a typo doesn't silently
 * disable the dashboard.
 */
function resolveDashboardPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.VMCP_DASHBOARD_PORT;
  if (raw === undefined || raw === '') return DEFAULT_DASHBOARD_PORT;
  if (raw === 'off' || raw === '0') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DASHBOARD_PORT;
  return parsed;
}

/**
 * Attach the process-wide collaborators that need a live `McpServer` handle.
 *
 * These are the fields that are still SINGULAR across connections: one channel
 * publisher, one server handle, one event bridge. With more than one connection
 * the last caller would win, which is why the daemon (VMCP-01.62) must not call
 * this per connection — fanning these out is VMCP-01.63.
 */
function wireProcessState(state: ServerState, connection: ClientConnection): void {
  // When cues are enabled (and we're on macOS, where `say` exists), tee the
  // channel stream through the deterministic cue emitter. It shares the same
  // voice-listener ref as `system.speak` so spoken cues duck the STT mic.
  // Passthrough is byte-identical otherwise.
  state.channels = maybeCueTee(connection.channels, {
    enabled: state.config.cues === 'on' && process.platform === 'darwin',
    voiceListenerRef: state.voice,
    midSetEnabled: state.config.cuesMidSet === 'on',
  });
  state.server = connection.server;
  // Wire the SDK event bridge for every slot currently in the slots map.
  // Listener handles persist across `setAdapter`, so subscribing here (before
  // the device.connect tool installs an adapter) is correct for primary. New
  // slots allocated via `createSlot` (device.connect with an explicit slot)
  // self-wire through `slot-manager.ts`, which imports `wireBridgeForSlot`
  // directly.
  wireEventBridge(state);
}

/**
 * Run the MCP server. Called from `bin.ts`. On bootstrap failure, closes the
 * server (releases stdio transport — critic FIX #8) before exiting non-zero.
 */
export async function runServer(): Promise<void> {
  const config = loadConfig();
  configureLogger(config);

  const connection = createClientConnection();

  const transport = new StdioServerTransport();
  await connection.server.connect(transport);

  try {
    // Bootstrap may take measurable time (BLE init, SQLite open).
    const state = await bootstrapState(config);
    registerClient(state, connection);
    wireProcessState(state, connection);
    // Hot-swap real handlers into this connection's placeholders. (Resources
    // were pre-registered before connect; their callbacks now resolve against
    // the live state.)
    connection.activate(state);

    // Bring up the local dashboard HTTP sidecar (loopback only). Disabled
    // when `VMCP_DASHBOARD_PORT=off` (or `=0`). Bind failure is logged
    // but not fatal — the MCP server itself stays up so a stuck dashboard
    // port (e.g., a leftover process) doesn't block all tool use.
    const dashboardPort = resolveDashboardPort();
    let dashboardHandle: DashboardServerHandle | undefined;
    if (dashboardPort !== null) {
      try {
        dashboardHandle = await startDashboardServer({ port: dashboardPort, state });
        log.info(
          `dashboard sidecar listening at http://${DEFAULT_DASHBOARD_HOST}:${dashboardHandle.port}`,
        );
      } catch (err) {
        // A port conflict is not routine warn noise: another voltras-mcp
        // instance already owns the dashboard port, so this session gets no
        // dashboard while the operator may be staring at the other server's.
        // Escalate to a loud, unmistakable error (VW-68). The MCP process
        // itself still stays up — the bind is deliberately non-fatal so a
        // stuck port never blocks all tool use.
        if (isAddressInUse(err)) {
          log.error(dashboardPortInUseMessage(dashboardPort, DEFAULT_DASHBOARD_HOST));
        } else {
          log.warn('dashboard sidecar failed to start', err);
        }
      }
    }

    // Register the shutdown hook regardless of whether the dashboard came
    // up — the process still needs to exit on SIGINT/SIGTERM and on stdin
    // EOF, even when the dashboard is disabled (`VMCP_DASHBOARD_PORT=off`)
    // or failed to bind. See VMCP-01.25 (F11): Claude Code abandons the
    // stdio pipe on reconnect rather than closing it cleanly, so we can't
    // rely on stdio teardown to propagate exit.
    installShutdownHook(dashboardHandle, () => connection.close(state));

    // Single-line ready signal emitted once bootstrap is fully done and
    // the shutdown hook is armed. Used by the spawn-based lifecycle
    // tests to know when SIGTERM/stdin-close should produce a clean
    // exit. Cheap log; safe to leave on at info level.
    log.info('voltras-mcp ready');
  } catch (err) {
    log.error('bootstrap failed', err);
    await connection.server.close();
    process.exit(1);
  }
}

/**
 * Install signal + stdin handlers that close the dashboard sidecar (if
 * present) and exit the process. The MCP server's stdio transport does NOT
 * reliably terminate the process when the parent (e.g., Claude Code on
 * reconnect) abandons the pipe rather than closing it, so we must drive
 * the exit ourselves. The `shuttingDown` guard makes double-signal /
 * signal-plus-stdin-close idempotent.
 */
/**
 * Bound on the shutdown sequence.
 *
 * Raised from 2s (VMCP-01.61): the connection close now surrenders the device —
 * finalize the set (BLE `endSet` + a store write) then unload (another BLE
 * write) — for up to two slots. Two seconds is under that budget, so the old
 * bound would routinely cut the surrender off and lose the very set it exists
 * to persist. Still bounded, because a wedged radio must not keep the process
 * alive (VMCP-01.25 / F11).
 */
export const SHUTDOWN_HARD_TIMEOUT_MS = 6000;

/**
 * Run the shutdown sequence: tear the connection down, close the dashboard,
 * then exit.
 *
 * The connection close is AWAITED, not fire-and-forget. It surrenders the
 * device when this client was driving it (finalize the set so it is persisted,
 * then drop the load — see `device-surrender.ts`), and that is real async BLE
 * and store work. Voiding it would mean the process exits first and the
 * surrender silently never happens, which is indistinguishable from working in
 * any test that awaits `close()` directly.
 *
 * Both closes run concurrently under one bounded window: a wedged radio must
 * not hold the process open, so {@link SHUTDOWN_HARD_TIMEOUT_MS} still forces a
 * non-zero exit. That bound means a very slow surrender can be cut off with the
 * cable still loaded — accepted, because the alternative is a server that will
 * not die (VMCP-01.25 / F11).
 *
 * Exported for tests; `installShutdownHook` is the production caller.
 */
export function runShutdown(
  handle: DashboardServerHandle | undefined,
  closeConnection: () => Promise<void>,
  exit: (code: number) => void,
): void {
  const hardTimeout = setTimeout(() => exit(1), SHUTDOWN_HARD_TIMEOUT_MS);
  hardTimeout.unref();
  const closes: Array<Promise<unknown>> = [
    closeConnection().catch((err) => log.warn('connection close failed', err)),
  ];
  if (handle) {
    closes.push(handle.close().catch((err) => log.warn('dashboard sidecar close failed', err)));
  }
  void Promise.all(closes).finally(() => {
    clearTimeout(hardTimeout);
    exit(0);
  });
}

function installShutdownHook(
  handle: DashboardServerHandle | undefined,
  closeConnection: () => Promise<void>,
): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    runShutdown(handle, closeConnection, (code) => process.exit(code));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Claude Code may abandon the stdio pipe rather than closing it
  // cleanly; the 'end' / 'close' events on stdin fire when the parent
  // does close the write side, and let us exit promptly in that path
  // too. See VMCP-01.25 (F11).
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
}
