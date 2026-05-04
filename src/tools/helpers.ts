// Helpers shared by every MCP tool handler. This module is the single place
// that knows the MCP `ToolResult` shape — tool files compose `wrapHandler`
// with a zod schema and a typed business function and never call
// `JSON.stringify` themselves.
//
// Handler signature note: the MCP SDK's `ToolCallback` (see
// `@modelcontextprotocol/sdk/.../server/mcp.d.ts`) passes
// `(args, extra)` to the registered callback. wrapHandler accepts the same
// `(args, extra)` arity so the returned function can be plugged directly
// into `McpServer.tool(...)` without an adapter.

import type { z } from 'zod';
import { mapSdkError } from '../errors.js';

export type ToolResult =
  | { content: Array<{ type: 'text'; text: string }>; isError?: false }
  | { content: Array<{ type: 'text'; text: string }>; isError: true };

export function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function errorResult(payload: { code: string; message: string }): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function wrapHandler<TIn>(
  schema: z.ZodType<TIn>,
  fn: (input: TIn) => Promise<unknown>,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return errorResult({
        code: 'INVALID_INPUT',
        message: parsed.error.message,
      });
    }
    try {
      return textResult(await fn(parsed.data));
    } catch (err) {
      return errorResult(mapSdkError(err));
    }
  };
}
