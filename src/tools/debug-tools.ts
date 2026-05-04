// `debug.*` diagnostic tools — surface the bridge's ring buffers.
//
// Two read-only tools:
//   * `debug.recent_frames(n)` — last N telemetry frames the bridge captured
//     via `client.onFrame`. Strictly numeric / typed values; never any raw
//     protocol bytes.
//   * `debug.recent_events(n)` — last N bridge-level events (rep_boundary,
//     set_boundary, settings_update, connection_state_change, cycle_complete)
//     with timestamps and lightweight structured payloads.
//
// Both default to the schema's default `n` (50), capped at the buffer's
// configured capacity (default 256, override via `VMCP_DEBUG_BUFFER_SIZE`).
// The buffers are process-local — a server restart drops them.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { DebugRecentEventsInput, DebugRecentFramesInput } from '../schemas/debug.js';
import { getDebugBuffers } from '../state/debug-buffer.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
}

/**
 * Hot-swap `debug.recent_frames` and `debug.recent_events` placeholders with
 * their real handlers. Both pull from the singleton ring buffers populated
 * by the event bridge.
 */
export function registerDebugTools(_server: McpServer, placeholders: PlaceholderTools): void {
  install(
    placeholders,
    'debug.recent_frames',
    DebugRecentFramesInput,
    wrapHandler(DebugRecentFramesInput, (input) => {
      const buffers = getDebugBuffers();
      const frames = buffers.frames.recent(input.n);
      return Promise.resolve({
        capacity: buffers.capacity,
        size: buffers.frames.length(),
        returned: frames.length,
        frames,
      });
    }),
  );
  install(
    placeholders,
    'debug.recent_events',
    DebugRecentEventsInput,
    wrapHandler(DebugRecentEventsInput, (input) => {
      const buffers = getDebugBuffers();
      const events = buffers.events.recent(input.n);
      return Promise.resolve({
        capacity: buffers.capacity,
        size: buffers.events.length(),
        returned: events.length,
        events,
      });
    }),
  );
}
