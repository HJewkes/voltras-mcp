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
  // Freeze the lease FIRST. Surrender is seconds of async BLE work, and without
  // the freeze the outgoing holder keeps passing the guard for that whole
  // window — it could re-engage the motor after we unloaded, handing the new
  // holder a lease over a device it believes is slack.
  try {
    state.lease.beginTransfer();
  } catch {
    return {
      ...(leaseView(state, self) as object),
      acquired: false,
      forced: true,
      hint: 'Another client is already taking over the device. Retry in a moment.',
    };
  }

  let surrender;
  try {
    // Surrender rather than a bare unload: an orphaned active set would block
    // the new holder's `set.start` and lose the victim's reps — see
    // device-surrender.ts.
    surrender = await surrenderDevice(state);
  } catch (err) {
    state.lease.abortTransfer();
    throw err;
  }

  // A `set.start` never settled, so its continuation will install a set on a
  // device the victim no longer owns. Refuse rather than create that orphan.
  if (!surrender.setStartsSettled) {
    state.lease.abortTransfer();
    return {
      ...(leaseView(state, self) as object),
      acquired: false,
      forced: true,
      surrender: surrender.slots,
      warning:
        'A set was still being started on the other session when the handover ' +
        'timed out, so the lease was NOT transferred. Retry shortly.',
    };
  }

  // Every connected slot refused to unload: the cable may still be live. Do NOT
  // assume it isn't. Refusing outright would be worse — if the old session is
  // genuinely gone and the radio is wedged, that strands the user with a loaded
  // cable and nobody able to command it — so allow an explicit second
  // escalation instead of deciding for them.
  if (surrender.allUnloadsFailed && input.acceptLoadedDevice !== true) {
    state.lease.abortTransfer();
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
  if (!isDeviceEngaged(state)) {
    return { released: state.lease.release(self), ...(leaseView(state, self) as object) };
  }
  // Same freeze as a forced steal: while we are unloading, this client must not
  // be able to re-engage the motor on its way out.
  state.lease.beginTransfer();
  try {
    const surrender = await surrenderDevice(state);
    state.lease.abortTransfer();
    return {
      released: state.lease.release(self),
      ...(leaseView(state, self) as object),
      surrender: surrender.slots,
    };
  } catch (err) {
    state.lease.abortTransfer();
    throw err;
  }
}

/** Register `system.lease_status` / `lease_acquire` / `lease_release`. */
const LEASE_STATUS_DESCRIPTION =
  'Read who currently holds the single-writer device lease, and whether that is you. ' +
  'Ordinary use never needs this — the lease is acquired implicitly on your first write ' +
  'call. Use it to diagnose a contended device (another client already connected).';

const LEASE_ACQUIRE_DESCRIPTION =
  'Take the device lease. Only needed for the contended case — normally the first write ' +
  'call acquires it for you. If another client holds it, this returns acquired:false with a ' +
  "hint unless `force: true` is passed, which unloads the current holder's device first " +
  '(surrendering any in-progress set) and steals the lease. If the cable cannot be confirmed ' +
  'unloaded, this refuses unless `acceptLoadedDevice: true` is ALSO passed — do not pass that ' +
  'unless the device is confirmed unattended, since it accepts the risk of a still-loaded cable.';

const LEASE_RELEASE_DESCRIPTION =
  'Release the device lease you hold. Surrenders (unloads) the device first if it is still ' +
  'engaged, so the next holder never inherits a loaded cable. A no-op if you do not hold the ' +
  'lease.';

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
    LEASE_STATUS_DESCRIPTION,
  );
  install(
    placeholders,
    'system.lease_acquire',
    LeaseAcquireInput,
    wrapHandler(LeaseAcquireInput, (input) => acquire(state, self, input)),
    LEASE_ACQUIRE_DESCRIPTION,
  );
  install(
    placeholders,
    'system.lease_release',
    LeaseReleaseInput,
    wrapHandler(LeaseReleaseInput, () => release(state, self)),
    LEASE_RELEASE_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}
