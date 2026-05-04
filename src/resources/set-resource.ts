// `voltra://set/active` — active set with rep buffer, served from
// `LiveState`. Returns `{ active: false }` when no set is active — not
// `null`, not `{}`. Clients poll this URI on every `sendResourceUpdated`
// hint emitted by the event-bridge to track in-progress reps.
//
// Polling-first per R13. The event-bridge emits
// `sendResourceUpdated({ uri: 'voltra://set/active' })` on every rep boundary
// (and on disconnect cascade per R24); this handler just serves the latest
// snapshot on each read.
//
// TODO(Wave 4): wire `registerSetResource(server, state)` from `runServer`
// after `bootstrapState` resolves.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LiveState } from '../state/live-state.js';

const URI = 'voltra://set/active';

/** Minimal slice of `ServerState` required by this resource. */
interface SetResourceState {
  live: LiveState;
}

/**
 * Register the `voltra://set/active` resource on `server`. The handler
 * captures `state.live` by reference; subsequent `live` mutations (including
 * `appendRep`) are visible to every read.
 */
export function registerSetResource(server: McpServer, state: SetResourceState): void {
  server.registerResource(
    'set-active',
    URI,
    {
      title: 'Active set with rep buffer',
      description:
        'Polling snapshot of the in-progress set (setId, sessionId, startedAt, reps[]). Returns { active: false } when no set is in progress.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: URI,
          mimeType: 'application/json',
          text: JSON.stringify(state.live.snapshotSet() ?? { active: false }),
        },
      ],
    }),
  );
}
