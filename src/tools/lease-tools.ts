// `system.lease_*` tool handlers (VMCP-01.61).
//
// These three tools are the only WRITE-classified tools NOT gated on the lease
// — gating the tool you use to obtain the lease would be a deadlock. See
// `LEASE_EXEMPT_TOOLS` in `../lease-guard.ts`.
//
// Ordinary use never touches them: `tryAcquire` runs implicitly on the first
// WRITE call, so a single session behaves exactly as it did before the lease
// existed. They exist for the contended case — finding out who holds the
// device, and taking it back from a session that has gone away.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { isDeviceEngaged, type ServerState } from '../state/server-state.js';
import { LeaseAcquireInput, LeaseReleaseInput, LeaseStatusInput } from '../schemas/lease.js';
import { surrenderDevice } from './device-surrender.js';
import { log } from '../logger.js';
import { wrapHandler } from './helpers.js';
import type { ClientId } from '../client-connection.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/** Shape returned by all three tools, so callers can read one thing. */
function leaseView(state: ServerState, self: ClientId): unknown {
  const holder = state.lease.peek();
  return {
    self,
    heldByYou: holder?.clientId === self,
    holder:
      holder === null
        ? null
        : {
            clientId: holder.clientId,
            acquiredAt: new Date(holder.acquiredAt).toISOString(),
            lastActivityAt: new Date(holder.lastActivityAt).toISOString(),
          },
  };
}

async function acquire(
  state: ServerState,
  self: ClientId,
  input: z.infer<typeof LeaseAcquireInput>,
): Promise<unknown> {
  const decision = state.lease.tryAcquire(self);
  if (decision.ok) {
    return { ...(leaseView(state, self) as object), acquired: true, forced: false };
  }
  if (input.force !== true) {
    return {
      ...(leaseView(state, self) as object),
      acquired: false,
      forced: false,
      hint: 'Another client holds the device. Retry with force: true to take it.',
    };
  }
  // Surrender BEFORE the transfer, never after: in between, the previous holder
  // still believes it owns a loaded cable. Surrender rather than a bare unload
  // because an orphaned active set would block the new holder's `set.start` and
  // lose the victim's reps — see device-surrender.ts.
  const surrender = await surrenderDevice(state);

  // Every connected slot refused to unload: the cable may still be live. Do NOT
  // assume it isn't. Refusing outright would be worse — if the old session is
  // genuinely gone and the radio is wedged, that strands the user with a loaded
  // cable and nobody able to command it — so allow an explicit second
  // escalation instead of deciding for them.
  if (surrender.allUnloadsFailed && input.acceptLoadedDevice !== true) {
    return {
      ...(leaseView(state, self) as object),
      acquired: false,
      forced: true,
      surrender: surrender.slots,
      warning:
        'Could not unload any connected slot, so THE CABLE MAY STILL BE LOADED. ' +
        'The lease was NOT transferred. If the device is unattended and you accept ' +
        'that risk, retry with force: true and acceptLoadedDevice: true.',
    };
  }

  const stolen = state.lease.steal(self);
  log.warn(`lease forcibly taken by ${self} from ${decision.holder.clientId}`);
  return {
    ...(leaseView(state, self) as object),
    acquired: true,
    forced: true,
    takenFrom: stolen.stolen ? decision.holder.clientId : null,
    surrender: surrender.slots,
    ...(surrender.anyUnloadFailed
      ? { warning: 'At least one slot could not be unloaded — the cable may still be loaded.' }
      : {}),
  };
}

/**
 * Release the lease, surrendering the device first if it is still engaged.
 *
 * Handing the next client a loaded cable is the same hazard as a forced steal,
 * so the same rule applies: you cannot hand off a loaded device. Releasing when
 * nothing is engaged — the common case — does no device work at all.
 */
async function release(state: ServerState, self: ClientId): Promise<unknown> {
  if (!state.lease.isHeldBy(self)) {
    return { released: false, ...(leaseView(state, self) as object) };
  }
  const surrender = isDeviceEngaged(state) ? await surrenderDevice(state) : null;
  return {
    released: state.lease.release(self),
    ...(leaseView(state, self) as object),
    ...(surrender === null ? {} : { surrender: surrender.slots }),
  };
}

/** Register `system.lease_status` / `lease_acquire` / `lease_release`. */
export function registerLeaseTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
  self: ClientId,
): void {
  install(
    placeholders,
    'system.lease_status',
    LeaseStatusInput,
    wrapHandler(LeaseStatusInput, () => Promise.resolve(leaseView(state, self))),
  );
  install(
    placeholders,
    'system.lease_acquire',
    LeaseAcquireInput,
    wrapHandler(LeaseAcquireInput, (input) => acquire(state, self, input)),
  );
  install(
    placeholders,
    'system.lease_release',
    LeaseReleaseInput,
    wrapHandler(LeaseReleaseInput, () => release(state, self)),
  );
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
