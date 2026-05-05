// `debug.*` diagnostic tools — surface the bridge's ring buffers and expose
// channel push smoke-testing.
//
// Three tools:
//   * `debug.recent_frames(n)` — last N telemetry frames the bridge captured
//     via `client.onFrame`. Strictly numeric / typed values; never any raw
//     protocol bytes.
//   * `debug.recent_events(n)` — last N bridge-level events (rep_boundary,
//     set_boundary, settings_update, connection_state_change, cycle_complete)
//     with timestamps and lightweight structured payloads.
//   * `debug.push_test_channel({ content, meta })` — fires a single
//     `claude/channel` notification through the publisher so a developer
//     can verify channel delivery (host launched with `--channels`) without
//     attaching real hardware.
//
// `recent_*` default to the schema's default `n` (50), capped at the buffer's
// configured capacity (default 256, override via `VMCP_DEBUG_BUFFER_SIZE`).
// The buffers are process-local — a server restart drops them.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  DebugPushTestChannelInput,
  DebugRecentEventsInput,
  DebugRecentFramesInput,
} from '../schemas/debug.js';
import { getDebugBuffers } from '../state/debug-buffer.js';
import type { ServerState } from '../state/server-state.js';
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
 * Hot-swap the `debug.*` placeholders with their real handlers. The
 * recent_* tools read from the singleton ring buffers populated by the
 * event bridge; `push_test_channel` calls into `state.channels` so the
 * smoke test exercises the same publisher used by the bridge and set
 * lifecycle tools.
 */
export function registerDebugTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
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
  install(
    placeholders,
    'debug.push_test_channel',
    DebugPushTestChannelInput,
    wrapHandler(DebugPushTestChannelInput, (input) => {
      state.channels.publish({ content: input.content, meta: input.meta });
      return Promise.resolve({ ok: true });
    }),
  );
}
