// `voltra://session/active` — active session metadata, served from
// `LiveState`. Returns `{ active: false }` when no session is active
// (EC-10) — not `null`, not `{}`. The literal `{ active: false }` shape is
// part of the contract: clients distinguish "no session" from "session with
// missing fields" by the presence of `active: false`.
//
// Polling-first per R13. The event-bridge emits
// `sendResourceUpdated({ uri: 'voltra://session/active' })` on session
// mutations; this handler just serves the latest snapshot on each read.
//
// TODO(Wave 4): wire `registerSessionResource(server, state)` from
// `runServer` after `bootstrapState` resolves.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LiveState } from '../state/live-state.js';

const URI = 'voltra://session/active';

/** Minimal slice of `ServerState` required by this resource. */
interface SessionResourceState {
  live: LiveState;
}

/**
 * Register the `voltra://session/active` resource on `server`. The handler
 * captures `state.live` by reference; subsequent `live` mutations are visible
 * to every read.
 */
export function registerSessionResource(server: McpServer, state: SessionResourceState): void {
  server.registerResource(
    'session-active',
    URI,
    {
      title: 'Active workout session',
      description:
        'Polling snapshot of the active session metadata (sessionId, startedAt, exercise, accumulated setIds). Returns { active: false } when no session is in progress.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: URI,
          mimeType: 'application/json',
          text: JSON.stringify(state.live.snapshotSession() ?? { active: false }),
        },
      ],
    }),
  );
}
