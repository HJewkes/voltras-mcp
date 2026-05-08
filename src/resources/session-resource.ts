// `voltra://session/{slot}/active` — active session metadata for a slot,
// served from that slot's `LiveState`. The legacy URI
// `voltra://session/active` is preserved as a primary-slot alias.
//
// Returns `{ active: false }` when no session is active (EC-10) — not
// `null`, not `{}`. The literal `{ active: false }` shape is part of the
// contract; clients distinguish "no session" from "session with missing
// fields" by the presence of `active: false`.
//
// Polling-first per R13.

import {
  ResourceTemplate,
  type McpServer,
  type ReadResourceTemplateCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';

import type { LiveState } from '../state/live-state.js';

const LEGACY_URI = 'voltra://session/active';
const TEMPLATE_URI = 'voltra://session/{slot}/active';

/** Minimal slice of `ServerState` required by this resource. */
export interface SessionResourceState {
  liveForSlot: (slotId: string) => LiveState | undefined;
  slotIds: () => string[];
}

function sessionUriForSlot(slotId: string): string {
  return `voltra://session/${slotId}/active`;
}

/**
 * Register the templated per-slot session resource and the legacy alias.
 */
export function registerSessionResource(server: McpServer, state: SessionResourceState): void {
  const readBody = (slotId: string): string => {
    const live = state.liveForSlot(slotId);
    return JSON.stringify(live?.snapshotSession() ?? { active: false });
  };

  const templateRead: ReadResourceTemplateCallback = (uri, variables) => ({
    contents: [
      { uri: uri.toString(), mimeType: 'application/json', text: readBody(String(variables.slot)) },
    ],
  });

  server.registerResource(
    'session-active',
    new ResourceTemplate(TEMPLATE_URI, {
      list: (): ListResourcesResult => ({
        resources: state.slotIds().map((slotId) => ({
          uri: sessionUriForSlot(slotId),
          name: `session-active-${slotId}`,
          title: `Active session (${slotId})`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Active workout session (per slot)',
      description:
        'Polling snapshot of the active session metadata (sessionId, startedAt, exercise, accumulated setIds). Templated by {slot}. Returns { active: false } when no session is in progress.',
      mimeType: 'application/json',
    },
    templateRead,
  );

  server.registerResource(
    'session-active-legacy',
    LEGACY_URI,
    {
      title: 'Active workout session (primary slot, legacy alias)',
      description: 'Backwards-compatible alias for `voltra://session/primary/active`.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [{ uri: LEGACY_URI, mimeType: 'application/json', text: readBody('primary') }],
    }),
  );
}
