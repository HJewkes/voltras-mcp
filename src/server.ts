// Server entry point. Owns the MCP lifecycle:
//   1. loadConfig() and instantiate `McpServer` with `resources.subscribe`.
//   2. Register placeholder handlers for every tool name (R6/EC-16) so a
//      tool call arriving during the bootstrap window returns a structured
//      `STARTING` error rather than a missing-tool error.
//   3. Connect `StdioServerTransport` (R5 — only stdio in v1).
//   4. Run `bootstrapState(config)` — opens BLE adapter + SQLite store. May
//      take measurable time.
//   5. On success: replace each placeholder's callback with the real handler
//      via `RegisteredTool.update({ callback })` and register resources.
//   6. On failure: close the server (releases the transport — FIX #8) before
//      `process.exit(1)` so a request queued mid-teardown doesn't get a
//      `STARTING` reply just before the channel disappears.
//
// Approach choice: PLACEHOLDER-REPLACE. The MCP SDK's `RegisteredTool`
// exposes `.update({ callback })` (see `node_modules/@modelcontextprotocol
// /sdk/dist/esm/server/mcp.d.ts:278`), so the same `RegisteredTool`
// reference can be hot-swapped after bootstrap — no dispatch table needed.
//
// Wave 1 scope: this file ships the lifecycle skeleton plus the placeholder
// registrations. The real `register*` functions for tools and resources
// land in Wave 3; they will accept `(server, state)` and call `update()` on
// the returned `RegisteredTool` references. Until those land, `runServer`
// will throw out of `bootstrapState` (Task 09 finalizes it) — which is the
// expected Wave 1 state.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { configureLogger, log } from './logger.js';
import { bootstrapState } from './state/server-state.js';
import { wireEventBridge } from './state/event-bridge.js';
import { McpChannelPublisher } from './state/channel-publisher.js';
import { z } from 'zod';
import { errorResult, type ToolResult } from './tools/helpers.js';
import { registerDeviceTools } from './tools/device-tools.js';
import { registerSessionTools } from './tools/session-tools.js';
import { registerSetTools } from './tools/set-tools.js';
import { registerMetricsTools } from './tools/metrics-tools.js';
import { registerExerciseTools } from './tools/exercise-tools.js';
import { registerMockTools } from './tools/mock-tools.js';
import { registerTimerTools } from './tools/timer-tools.js';
import { registerServerTools } from './tools/server-tools.js';
import { registerDebugTools } from './tools/debug-tools.js';
import { registerSystemTools } from './tools/tts-tools.js';
import { registerVoiceTools } from './tools/voice-tools.js';
import { registerSlotTools } from './tools/slot-tools.js';
import { registerProgressionTools } from './tools/progression-tools.js';
import { registerIsometricTools } from './tools/isometric-tools.js';
import { registerPlanTools } from './tools/plan-tools.js';
import { registerDeviceResource } from './resources/device-resource.js';
import { registerSessionResource } from './resources/session-resource.js';
import { registerSetResource } from './resources/set-resource.js';
import {
  startDashboardServer,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DASHBOARD_HOST,
  type DashboardServerHandle,
} from './dashboard/server.js';

/** Canonical list of every tool name VMCP exposes (R9, R11). */
const CORE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.set_damper_level',
  'device.set_assist_mode',
  'device.set_band_max_force',
  'device.set_isokinetic_target_speed',
  'device.set_isokinetic_ecc_mode',
  'device.set_isokinetic_ecc_speed_limit',
  'device.set_isokinetic_ecc_const_weight',
  'device.set_isokinetic_ecc_overload_weight',
  'device.start_guided_load',
  'device.exit_guided_load',
  // <Bug-22> Rowing two-stage entry — replaces device.set_mode with mode=Rowing.
  'device.enter_row_mode',
  'device.start_row',
  // </Bug-22>
  'device.get_state',
  'device.send_raw',
  'bilateral.cascade',
  'slot.swap',
  'session.start',
  'session.end',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
  'metrics.compute',
  'exercise.search',
  'exercise.get',
  'timer.wait',
  'timer.start',
  'timer.cancel',
  'server.health',
  'debug.recent_frames',
  'debug.recent_events',
  'debug.push_test_channel',
  'system.speak',
  'system.listen_start',
  'system.listen_stop',
  'slot.identify',
  'slot.bind',
  'slot.bindings_list',
  'slot.unbind',
  'progression.get_for_exercise',
  'isometric.measure_max',
  'isometric.measure_imbalance',
  // Block-periodization plan CRUD (v3 schema). See src/tools/plan-tools.ts.
  'plan.program.create',
  'plan.program.list',
  'plan.program.get',
  'plan.program.archive',
  'plan.block.create',
  'plan.block.list_for_program',
  'plan.week.create',
  'plan.week.list_for_block',
  'plan.template.create',
  'plan.template.get',
  'plan.template.list_for_week',
  'plan.exercise.create',
  'plan.exercise.list_for_template',
  // Progression / session-link tools (compose the CRUD layer above).
  'plan.next_workout',
  'plan.complete_workout',
  'plan.attach_to_session',
  'plan.suggest_progression',
] as const;

/** Mock-only tools (R11), registered when `VOLTRA_ADAPTER=mock`. */
const MOCK_TOOL_NAMES = ['mock.configure', 'mock.inject_error'] as const;

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

/** Single shared `STARTING` response — produced once, returned by every placeholder. */
function startingResult(): ToolResult {
  return errorResult({
    code: 'STARTING',
    message: 'Server is initializing — try again in a moment.',
  });
}

/**
 * Register a `STARTING`-returning placeholder for every tool name. Returns
 * the `RegisteredTool` map so `runServer` can hot-swap the callback once
 * `bootstrapState` resolves.
 *
 * Each placeholder registers with a permissive `z.object({}).passthrough()`
 * paramsSchema. Without a paramsSchema, the SDK invokes the handler with
 * only `extra` (no `args`), which would silently drop every tool argument
 * once Wave 3 swaps in real handlers. The passthrough schema lets the SDK
 * forward raw args; each real handler's `wrapHandler(schema, fn)` does the
 * actual typed validation against its real zod schema.
 */
const PLACEHOLDER_SCHEMA = z.object({}).passthrough().shape;

function registerStartingPlaceholders(server: McpServer): Map<string, RegisteredTool> {
  const placeholders = new Map<string, RegisteredTool>();
  const callback = (): ToolResult => startingResult();
  for (const name of CORE_TOOL_NAMES) {
    placeholders.set(name, server.tool(name, PLACEHOLDER_SCHEMA, callback));
  }
  for (const name of MOCK_TOOL_NAMES) {
    placeholders.set(name, server.tool(name, PLACEHOLDER_SCHEMA, callback));
  }
  return placeholders;
}

/**
 * Run the MCP server. Called from `bin.ts`. On bootstrap failure, closes the
 * server (releases stdio transport — critic FIX #8) before exiting non-zero.
 */
export async function runServer(): Promise<void> {
  const config = loadConfig();
  configureLogger(config);

  const server = new McpServer(
    { name: 'voltras-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        // Experimental: declares support for `claude/channel` push events so
        // hosts that opt in (Claude Code with `--channels`) route our
        // notifications/claude/channel messages back to the model inline as
        // <channel> tags. Hosts without channel support silently ignore the
        // declaration. See state/channel-publisher.ts for delivery semantics.
        experimental: { 'claude/channel': {} },
      },
    },
  );

  // The channel publisher needs the McpServer handle, so it's constructed
  // here and passed into bootstrapState's result before tool registration.
  // `bootstrapState` initializes `state.channels` to a no-op default; we
  // overwrite it below once the live server exists.
  const channels = new McpChannelPublisher(server);

  const placeholders = registerStartingPlaceholders(server);

  // Resources must be registered BEFORE `server.connect()` because
  // `registerResource` extends server capabilities, which the SDK forbids
  // after transport connect. We pass a lazy slot-aware proxy that resolves
  // through `stateBox.value` at callback time — populated after bootstrap.
  // The proxy enumerates whatever slots exist at read time, so bilateral
  // flows that allocate `'left'`/`'right'` after bootstrap surface in the
  // resource list automatically.
  const stateBox: { value?: Awaited<ReturnType<typeof bootstrapState>> } = {};
  const lazyState = {
    liveForSlot: (slotId: string) => stateBox.value?.slots.get(slotId)?.live,
    slotIds: () => (stateBox.value ? [...stateBox.value.slots.keys()] : []),
  };
  registerDeviceResource(server, lazyState);
  registerSessionResource(server, lazyState);
  registerSetResource(server, lazyState);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  try {
    // Bootstrap may take measurable time (BLE init, SQLite open).
    const state = await bootstrapState(config);
    state.channels = channels;
    state.server = server;
    stateBox.value = state;
    // Wire the SDK event bridge for every slot currently in the slots map.
    // Listener handles persist across `setAdapter`, so subscribing here
    // (before the device.connect tool installs an adapter) is correct for
    // primary. New slots allocated via `createSlot` (device.connect with an
    // explicit slot) self-wire through `slot-manager.ts`, which imports
    // `wireBridgeForSlot` directly.
    wireEventBridge(state);
    // Mock-only tools never have real handlers in node mode — drop their
    // placeholders so `tools/list` reflects only the real surface (R11).
    // In mock mode the placeholders remain for Wave 3 to hot-swap.
    if (state.config.adapter !== 'mock') {
      for (const name of MOCK_TOOL_NAMES) {
        placeholders.get(name)?.remove();
        placeholders.delete(name);
      }
    }
    // Wave 3: hot-swap real handlers into the placeholders. (Resources were
    // pre-registered before connect; their callbacks now see the live state
    // via the `stateBox` set above.)
    registerDeviceTools(server, state, placeholders);
    registerSessionTools(server, state, placeholders);
    registerSetTools(server, state, placeholders);
    registerMetricsTools(server, state, placeholders);
    registerExerciseTools(server, state, placeholders);
    registerTimerTools(server, state, placeholders);
    registerServerTools(server, state, placeholders);
    registerDebugTools(server, state, placeholders);
    registerSystemTools(server, placeholders, undefined, state.voice);
    registerVoiceTools(server, state, placeholders);
    registerSlotTools(server, state, placeholders);
    registerProgressionTools(server, state, placeholders);
    registerIsometricTools(server, state, placeholders);
    registerPlanTools(server, state, placeholders);
    if (state.config.adapter === 'mock') {
      registerMockTools(server, state, placeholders);
    }

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
        log.warn('dashboard sidecar failed to start', err);
      }
    }

    // Register the shutdown hook regardless of whether the dashboard came
    // up — the process still needs to exit on SIGINT/SIGTERM and on stdin
    // EOF, even when the dashboard is disabled (`VMCP_DASHBOARD_PORT=off`)
    // or failed to bind. See VMCP-01.25 (F11): Claude Code abandons the
    // stdio pipe on reconnect rather than closing it cleanly, so we can't
    // rely on stdio teardown to propagate exit.
    installShutdownHook(dashboardHandle);

    // Single-line ready signal emitted once bootstrap is fully done and
    // the shutdown hook is armed. Used by the spawn-based lifecycle
    // tests to know when SIGTERM/stdin-close should produce a clean
    // exit. Cheap log; safe to leave on at info level.
    log.info('voltras-mcp ready');
  } catch (err) {
    log.error('bootstrap failed', err);
    await server.close();
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
function installShutdownHook(handle: DashboardServerHandle | undefined): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Hard timeout in case dashboard close hangs — VMCP-01.25 (F11).
    // The non-zero exit code distinguishes "we had to bail out" from
    // the normal clean-exit path.
    const hardTimeout = setTimeout(() => process.exit(1), 2000);
    hardTimeout.unref();
    const closePromise = handle
      ? handle.close().catch((err) => log.warn('dashboard sidecar close failed', err))
      : Promise.resolve();
    closePromise.finally(() => {
      process.exit(0);
    });
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
