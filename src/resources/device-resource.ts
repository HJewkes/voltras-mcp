// `voltra://device/{slot}/current` — current device state for a single slot,
// served from that slot's `LiveState`. The legacy URI `voltra://device/current`
// is preserved as a primary-slot alias so existing single-device callers keep
// working unchanged.
//
// Polling-first per R13. The event-bridge emits
// `sendResourceUpdated({ uri: 'voltra://device/current' })` on every
// primary-slot device mutation; bilateral mutations also notify the per-slot
// templated URI. This handler just serves the latest snapshot on each read.
//
// The resource list is fixed in shape but DYNAMIC in content — the bridge
// surfaces one entry per active slot via the `list` callback on the template
// (so a consumer scanning resources discovers `primary`, `left`, `right`
// without subscribing to list-changed pings; the template also makes the
// schema explicit). The legacy static URI is registered separately for
// backwards compatibility.

import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceTemplateCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';

import type { LiveState } from '../state/live-state.js';

const LEGACY_URI = 'voltra://device/current';
const TEMPLATE_URI = 'voltra://device/{slot}/current';

/** Minimal slice of `ServerState` required by this resource. */
export interface DeviceResourceState {
  /** Resolve a slot's `LiveState` by id. Returns `undefined` for unknown slots. */
  liveForSlot: (slotId: string) => LiveState | undefined;
  /** Enumerate every active slot id (used to populate the resource list). */
  slotIds: () => string[];
}

/**
 * Build the per-slot URI for a slot id. Centralised so the template registration
 * and the list callback agree on the exact substitution shape.
 */
function deviceUriForSlot(slotId: string): string {
  return `voltra://device/${slotId}/current`;
}

/**
 * Register both the templated per-slot device resource and the legacy static
 * URI alias. Bilateral consumers read `voltra://device/{slot}/current`;
 * existing single-device flows continue to read `voltra://device/current`
 * (which routes to the `'primary'` slot).
 */
export function registerDeviceResource(server: McpServer, state: DeviceResourceState): void {
  const readBySlot = (slotId: string): { uri: string; mimeType: string; text: string } => {
    const live = state.liveForSlot(slotId);
    const snapshot = live ? live.snapshotDevice() : { connected: false };
    return {
      uri: deviceUriForSlot(slotId),
      mimeType: 'application/json',
      text: JSON.stringify(snapshot),
    };
  };

  const templateRead: ReadResourceTemplateCallback = (uri, variables) => {
    const slotId = String(variables.slot);
    return { contents: [{ ...readBySlot(slotId), uri: uri.toString() }] };
  };

  server.registerResource(
    'device-current',
    new ResourceTemplate(TEMPLATE_URI, {
      list: (): ListResourcesResult => ({
        resources: state.slotIds().map((slotId) => ({
          uri: deviceUriForSlot(slotId),
          name: `device-current-${slotId}`,
          title: `Current device state (${slotId})`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Current device state (per slot)',
      description:
        'Polling snapshot of the connected Voltra device for a slot (connection, weight, training mode, battery). Templated by {slot} — pass `primary` for single-device flows or `left`/`right` for bilateral.',
      mimeType: 'application/json',
    },
    templateRead,
  );

  server.registerResource(
    'device-current-legacy',
    LEGACY_URI,
    {
      title: 'Current device state (primary slot, legacy alias)',
      description:
        'Backwards-compatible alias for `voltra://device/primary/current`. Reads the primary slot.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [{ ...readBySlot('primary'), uri: LEGACY_URI }],
    }),
  );
}
