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
import { errorResult, type ToolResult } from './tools/helpers.js';

/** Canonical list of every tool name VMCP exposes (R9, R11). */
const CORE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.get_state',
  'session.start',
  'session.end',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'metrics.compute',
  'exercise.search',
  'exercise.get',
] as const;

/** Mock-only tools (R11), registered when `VOLTRA_ADAPTER=mock`. */
const MOCK_TOOL_NAMES = ['mock.configure', 'mock.inject_error'] as const;

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
 * `bootstrapState` resolves. Placeholder callbacks accept the `extra` arg
 * shape used by zero-schema MCP tools and ignore it.
 */
function registerStartingPlaceholders(server: McpServer): Map<string, RegisteredTool> {
  const placeholders = new Map<string, RegisteredTool>();
  const callback = (): ToolResult => startingResult();
  for (const name of CORE_TOOL_NAMES) {
    placeholders.set(name, server.tool(name, callback));
  }
  for (const name of MOCK_TOOL_NAMES) {
    placeholders.set(name, server.tool(name, callback));
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
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );

  registerStartingPlaceholders(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  try {
    // Bootstrap may take measurable time (BLE init, SQLite open).
    await bootstrapState(config);
    // Wave 3 wires the real handlers here via
    // `placeholder.update({ callback: realHandler })` for every entry in the
    // returned map, then registers `voltra://device/current`,
    // `voltra://session/active`, `voltra://set/active` resources.
  } catch (err) {
    log.error('bootstrap failed', err);
    await server.close();
    process.exit(1);
  }
}
