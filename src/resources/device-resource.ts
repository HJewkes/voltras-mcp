// `voltra://device/current` — current device state, served from `LiveState`.
//
// Polling-first per R13. The event-bridge (Task 09) emits
// `sendResourceUpdated({ uri: 'voltra://device/current' })` on every device
// mutation; this handler just serves the latest snapshot on each read.
//
// The resource list is fixed at startup, so `sendResourceListChanged` is
// NEVER called (AC-13). The MCP capabilities declared by `runServer` include
// `resources.subscribe: true` so clients can observe the bridge's
// `sendResourceUpdated` notifications.
//
// TODO(Wave 4): wire `registerDeviceResource(server, state)` from
// `runServer` after `bootstrapState` resolves. Until then this function is
// unreferenced; integration tests cover the wiring once it lands.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LiveState } from '../state/live-state.js';

const URI = 'voltra://device/current';

/** Minimal slice of `ServerState` required by this resource. */
interface DeviceResourceState {
  live: LiveState;
}

/**
 * Register the `voltra://device/current` resource on `server`. The handler
 * captures `state.live` by reference; subsequent `live` mutations are visible
 * to every read.
 */
export function registerDeviceResource(server: McpServer, state: DeviceResourceState): void {
  server.registerResource(
    'device-current',
    URI,
    {
      title: 'Current device state',
      description:
        'Polling snapshot of the connected Voltra device (connection, weight, training mode, battery).',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: URI,
          mimeType: 'application/json',
          text: JSON.stringify(state.live.snapshotDevice()),
        },
      ],
    }),
  );
}
