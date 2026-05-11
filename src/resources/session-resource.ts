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

import type { IdleRep, LiveState } from '../state/live-state.js';

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
 * Convert one `IdleRep` from LiveState's raw mm-scale storage into the
 * m/s + metres serialized shape used by both the session resource and the
 * `idle_rep` channel payload (F18 / VMCP-01.32). Keeping the conversion
 * here (rather than in LiveState.recordIdleRep) preserves the raw scale
 * for any internal consumer that still wants it.
 */
function serializeIdleRep(entry: IdleRep): IdleRep {
  return {
    ts: entry.ts,
    vCon: entry.vCon !== null ? Number((entry.vCon / 1000).toFixed(3)) : null,
    rom: entry.rom !== null ? Number((entry.rom / 1000).toFixed(3)) : null,
    slot: entry.slot,
  };
}

/**
 * Build the session resource body for a given slot. When a session is active,
 * includes `idleRepCount` and `idleReps` alongside the session fields so the
 * PT skill can detect reps lifted between `set.start` calls. When no session
 * is active, still includes idle counts since idle reps accumulate
 * independently of whether a session is open.
 *
 * `idleReps` are converted from LiveState's internal mm-scale storage to
 * the documented m/s + metres surface at this serialization boundary.
 */
function buildSessionBody(live: LiveState | undefined): string {
  if (live === undefined) {
    return JSON.stringify({ active: false });
  }
  const session = live.snapshotSession();
  const idleRepCount = live.idleRepCount;
  const idleReps = live.idleReps.map(serializeIdleRep);
  if (session === undefined) {
    return JSON.stringify({ active: false, idleRepCount, idleReps });
  }
  return JSON.stringify({ ...session, idleRepCount, idleReps });
}

/**
 * Register the templated per-slot session resource and the legacy alias.
 */
export function registerSessionResource(server: McpServer, state: SessionResourceState): void {
  const readBody = (slotId: string): string => {
    const live = state.liveForSlot(slotId);
    return buildSessionBody(live);
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
