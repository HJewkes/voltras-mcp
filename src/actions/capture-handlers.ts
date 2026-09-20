// Capture the tool handlers the dashboard action layer runs (VW-502).
//
// ── Why a capture, and why at boot ────────────────────────────────────────
//
// The action layer's promise is that a wall tap and an MCP tool call cannot
// disagree, because they run the SAME handler. The handler you can reach
// through a live MCP connection is the wrong one twice over:
//
//   1. `applyLeaseGuard` replaces the callback of every WRITE-classified tool
//      with one that calls `state.lease.tryAcquire(self)`, closing over the
//      connection's own client id (`lease-guard.ts`). Every tool the action
//      allowlist names is WRITE-classified, so calling through a connection
//      would make a wall tap logging a bodyweight acquire the DEVICE lease
//      under some terminal session's identity. Wrong on both counts: a
//      store-only write must not take the device lease, and the acquisition
//      would be attributed to the wrong client.
//   2. Tools register PER CONNECTION. A capture taken during registration
//      would not exist until some MCP client attached, and would be replaced
//      by the next one. The wall has to work with zero clients attached.
//
// So the capture runs ONCE at process boot, straight after `bootstrapState`,
// and binds to the shared `ServerState` rather than to any connection.
//
// ── How it works ─────────────────────────────────────────────────────────
//
// Every tool module installs through the same two-method interface: it calls
// `placeholders.get(name)` and then `tool.update({ paramsSchema, callback })`.
// {@link captureActionHandlers} passes a RECORDER satisfying that interface, so
// each module hands over its real schema shape and its real handler without a
// single change to the module. The modules it is given all take their
// `_server` parameter unused — verified, and pinned by a test — so the stub
// below is never touched.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerGoalTools } from '../tools/goal-tools.js';
import { registerPlanScheduleTools } from '../tools/plan-schedule-tools.js';
import { registerProfileTools } from '../tools/profile-tools.js';
import { registerSessionTools } from '../tools/session-tools.js';
import type { ServerState } from '../state/server-state.js';
import type { ToolResult } from '../tools/helpers.js';

/** A captured tool: its own zod shape and its own unguarded handler. */
export interface CapturedTool {
  /** `install()` hands over `schema.shape`, not the schema. Rebuilt by the caller. */
  readonly paramsShape: Record<string, unknown>;
  readonly handler: (args: unknown, extra?: unknown) => Promise<ToolResult> | ToolResult;
}

/** Every tool name the capture found, to its schema and handler. */
export type CapturedTools = ReadonlyMap<string, CapturedTool>;

/**
 * The tool modules whose handlers the action layer may run. Deliberately a
 * short list: a module here is one whose tools the allowlist can name, so
 * adding one is the decision, not an accident of import order.
 */
const CAPTURED_MODULES = [
  registerProfileTools,
  registerGoalTools,
  registerPlanScheduleTools,
  registerSessionTools,
];

/**
 * Never touched. Every module in {@link CAPTURED_MODULES} takes its server
 * parameter as `_server` and does not read it; `capture-handlers.test.ts`
 * fails if one ever starts to, because the property access throws here.
 */
const NO_SERVER = new Proxy(
  {},
  {
    get(_target, property): never {
      throw new Error(
        `action capture: a tool module read McpServer.${String(property)}. The capture runs at ` +
          `boot with no connection, so a module that needs the server cannot be captured.`,
      );
    },
  },
) as McpServer;

/**
 * Run the capturable tool modules against a recorder and return what they
 * installed. Call once, after `bootstrapState` resolves and before any client
 * connects.
 */
export function captureActionHandlers(state: ServerState): CapturedTools {
  const captured = new Map<string, CapturedTool>();
  const recorder = {
    get(name: string) {
      return {
        update(updates: { paramsSchema?: unknown; callback?: unknown }): void {
          captured.set(name, {
            paramsShape: (updates.paramsSchema ?? {}) as Record<string, unknown>,
            handler: updates.callback as CapturedTool['handler'],
          });
        },
      };
    },
  };
  for (const register of CAPTURED_MODULES) {
    // The recorder is structurally what every `install()` needs. The cast is
    // to the modules' own local `PlaceholderTools`, which they do not export.
    (register as unknown as (s: McpServer, st: ServerState, p: unknown) => void)(
      NO_SERVER,
      state,
      recorder,
    );
  }
  return captured;
}
