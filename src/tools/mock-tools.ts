// Mock-only tool handlers (R11). Registered ONLY when
// `config.adapter === 'mock'` — `runServer` (src/server.ts) gates the call;
// this module does not re-check.
//
// AC-09 / EC-09 ─────────────────────────────────────────────────────────────
// When the adapter is `node`, `runServer` removes the `mock.*` placeholders
// before calling Wave 3 registration helpers, so `tools/list` does not
// surface mock entries. This module's contract is therefore:
//   1. Caller has already established `config.adapter === 'mock'`.
//   2. Caller passes a `placeholders` map that DOES contain `mock.configure`
//      and `mock.inject_error`.
// We assert (2) defensively — a missing placeholder means `runServer` and
// this module disagree about which tools exist, which is a programming bug.
//
// SDK API status (node-sdk@0.3.0) ────────────────────────────────────────────
// `MockBLEAdapter` (dist/types/bluetooth/adapters/mock.d.ts) only takes
// `MockBLEConfig` via its constructor. There is NO public `configure()` and
// NO public `injectError()`. `VoltraManager` likewise exposes no
// `getAdapter()` accessor — the active adapter is a private field assembled
// via `adapterFactory`.
//
// Two options were available (per task briefing):
//   (a) Recreate the `MockBLEAdapter` with new config and re-bootstrap the
//       relevant slice of `ServerState`. Intrusive — leaks adapter lifecycle
//       into the tool layer and would require disposing/replacing a manager
//       that may have an active connection. Rejected.
//   (b) Document the gap and return a structured `NOT_IMPLEMENTED` error so
//       callers can detect the missing capability. Chosen.
//
// When the SDK exposes the missing surface (likely > 0.3.x), this module
// flips: import `MockBLEAdapter` lazily, use `state.manager.getAdapter()`
// (or whatever accessor lands), and call `configure(input)` /
// `injectError(input.type)`. The schema in `src/schemas/mock.ts` already
// matches the expected shape, so no schema change should be needed.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { MockConfigureInput, MockInjectErrorInput } from '../schemas/mock.js';
import type { ServerState } from '../state/server-state.js';
import { errorResult, type ToolResult } from './helpers.js';

const MOCK_CONFIGURE = 'mock.configure';
const MOCK_INJECT_ERROR = 'mock.inject_error';

/** Build a callback that validates input then returns NOT_IMPLEMENTED. */
function notImplementedHandler<TIn>(
  schema: z.ZodType<TIn>,
  toolName: string,
  missingApi: string,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return errorResult({
        code: 'INVALID_INPUT',
        message: parsed.error.message,
      });
    }
    return errorResult({
      code: 'NOT_IMPLEMENTED',
      message: `${toolName} requires @voltras/node-sdk to expose ${missingApi}; not available in 0.3.x.`,
    });
  };
}

function takePlaceholder(placeholders: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const placeholder = placeholders.get(name);
  if (!placeholder) {
    throw new Error(
      `registerMockTools: expected ${name} placeholder; runServer must register it before calling this function.`,
    );
  }
  return placeholder;
}

/**
 * Hot-swap the `mock.configure` and `mock.inject_error` placeholder callbacks
 * with their real handlers. Caller (runServer) MUST only invoke this when
 * `config.adapter === 'mock'`. The `state` parameter is accepted for forward
 * compatibility — once the SDK exposes a runtime configure/inject API, the
 * handlers will reach through `state.manager` to the underlying adapter.
 */
export function registerMockTools(
  _server: McpServer,
  _state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  // Resolve placeholders up front so a wiring bug surfaces synchronously,
  // not on the first tool invocation.
  const configurePh = takePlaceholder(placeholders, MOCK_CONFIGURE);
  const injectPh = takePlaceholder(placeholders, MOCK_INJECT_ERROR);

  configurePh.update({
    callback: notImplementedHandler(
      MockConfigureInput,
      MOCK_CONFIGURE,
      'a runtime MockBLEAdapter.configure() method',
    ),
  });

  injectPh.update({
    callback: notImplementedHandler(
      MockInjectErrorInput,
      MOCK_INJECT_ERROR,
      'a public MockBLEAdapter.injectError() / error-injection method',
    ),
  });
}
