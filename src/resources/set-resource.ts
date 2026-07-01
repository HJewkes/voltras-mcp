// `voltra://set/{slot}/active` — active set with rep buffer for a slot,
// served from that slot's `LiveState`. The legacy URI `voltra://set/active`
// is preserved as a primary-slot alias.
//
// Returns `{ active: false }` when no set is active. Clients poll this URI
// on every `sendResourceUpdated` hint emitted by the event-bridge to track
// in-progress reps.

import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceTemplateCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';

import type { RepSource } from '../config.js';
import { selectSetReps, type LiveState } from '../state/live-state.js';

const LEGACY_URI = 'voltra://set/active';
const TEMPLATE_URI = 'voltra://set/{slot}/active';

/** Minimal slice of `ServerState` required by this resource. */
export interface SetResourceState {
  liveForSlot: (slotId: string) => LiveState | undefined;
  slotIds: () => string[];
  /**
   * The configured rep source (VMCP-02.29 PR5). Resolved lazily so the
   * resource reflects `config.repSource` even though wiring runs before
   * bootstrap; defaults to `'analytics'` until state is available.
   */
  repSource: () => RepSource;
}

function setUriForSlot(slotId: string): string {
  return `voltra://set/${slotId}/active`;
}

/**
 * Register the templated per-slot set resource and the legacy alias.
 */
export function registerSetResource(server: McpServer, state: SetResourceState): void {
  const readBody = (slotId: string): string => {
    const live = state.liveForSlot(slotId);
    const snapshot = live?.snapshotSet();
    // VMCP-02.29 PR5: project onto the configured rep source. Default
    // `'analytics'` returns the snapshot unchanged (byte-identical resource).
    const body =
      snapshot === undefined ? { active: false } : selectSetReps(snapshot, state.repSource());
    return JSON.stringify(body);
  };

  const templateRead: ReadResourceTemplateCallback = (uri, variables) => ({
    contents: [
      { uri: uri.toString(), mimeType: 'application/json', text: readBody(String(variables.slot)) },
    ],
  });

  server.registerResource(
    'set-active',
    new ResourceTemplate(TEMPLATE_URI, {
      list: (): ListResourcesResult => ({
        resources: state.slotIds().map((slotId) => ({
          uri: setUriForSlot(slotId),
          name: `set-active-${slotId}`,
          title: `Active set (${slotId})`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Active set with rep buffer (per slot)',
      description:
        'Polling snapshot of the in-progress set (setId, sessionId, startedAt, reps[]). Templated by {slot}. Returns { active: false } when no set is in progress.',
      mimeType: 'application/json',
    },
    templateRead,
  );

  server.registerResource(
    'set-active-legacy',
    LEGACY_URI,
    {
      title: 'Active set (primary slot, legacy alias)',
      description: 'Backwards-compatible alias for `voltra://set/primary/active`.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [{ uri: LEGACY_URI, mimeType: 'application/json', text: readBody('primary') }],
    }),
  );
}
