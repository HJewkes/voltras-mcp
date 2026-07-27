// Lease enforcement (VMCP-01.61).
//
// Applied per connection, AFTER the real handlers are installed: every
// WRITE-classified tool gets wrapped so the call first acquires — or is refused
// — the device write-lease. READ tools are left untouched, which is what keeps
// an observer session useful.
//
// Wrapping here rather than inside each tool file means enforcement cannot be
// forgotten when a tool is added: `TOOL_ACCESS` is exhaustive over `ToolName`
// (tsc rejects a missing entry), so a new tool is classified before it can
// register, and classification is what drives the wrap.
//
// `RegisteredTool.update({ callback })` writes through to `.handler` and leaves
// `inputSchema` alone (verified against the SDK's `_createRegisteredTool`), so
// wrapping does not disturb argument validation.
//
// SAFETY — the Tier-A stop-phrase path is NOT gated, by design. When the voice
// listener hears a stop word it calls `unloadSlot` / `speak` directly (see
// `makeVoiceSafety` in client-connection.ts), never through the `device.unload`
// or `system.speak` TOOLS, so it does not pass through this guard. That is the
// correct behaviour and must stay that way: a lease dispute is a coordination
// problem, but a person under motor load who says "stop" is a physical one, and
// an emergency unload must never wait on arbitration.

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorResult, type ToolResult } from './tools/helpers.js';
import { toolAccess, type ToolName } from './tool-registry.js';
import type { ServerState } from './state/server-state.js';
import type { ClientId } from './client-connection.js';
import type { LeaseDenied } from './state/write-lease.js';

/**
 * Tools exempt from the lease check.
 *
 * The `system.lease_*` trio must stay callable without the lease — gating the
 * tool you use to obtain the lease is a deadlock. They are still classified
 * `write` in `TOOL_ACCESS`, because that table describes what a tool DOES, not
 * whether it is gated; conflating the two would make the table lie.
 */
export const LEASE_EXEMPT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  // `system.lease_status` is deliberately absent: it is classified `read`, so
  // the guard never considers it and an entry here would be unreachable.
  'system.lease_acquire',
  'system.lease_release',

  // SAFETY — the load-REDUCING tools. Gating these meant a second session
  // could not stop the machine: its only route was
  // `system.lease_acquire {force:true}`, which this very module answers with
  // LEASE_HELD_ENGAGED so a host can demand user confirmation first. That put
  // an emergency unload behind an extra tool call and possibly a prompt.
  //
  // The Tier-A voice path does not cover this gap either: `system.listen_start`
  // is itself a gated write, so the ungated stop-phrase path only exists for
  // whoever already holds the lease.
  //
  // Both of these can only ever REMOVE load, so letting any client call them is
  // strictly safer than the alternative. They stay classified `write` in
  // TOOL_ACCESS, which describes what a tool DOES, not whether it is gated.
  'device.unload',
  'device.exit_guided_load',
  // NOT `device.disconnect`, despite it being in the same family: dropping the
  // BLE link does not drop the load, it removes the ability to command the
  // motor. Ungating it would let one session strand another's loaded cable
  // with no way to release it.
]);

// The load-REDUCING tools (`device.unload`, `device.exit_guided_load`) are
// exempt, so stopping the machine never waits on arbitration — see
// LEASE_EXEMPT_TOOLS below.
//
// KNOWN LIMITATION (VMCP-01.65): the lease is checked at call ENTRY only, and
// there is no cancellation. A long-running WRITE tool — `isometric.measure_max`
// runs for minutes, `timer.wait` blocks, `device.start_guided_load` drives a
// state machine — keeps running after another client force-steals the lease,
// and can still drive the device once its own await resolves. Surrender assumes
// the victim is quiesced; nothing currently makes it so. `set.start` is the one
// case handled, because `surrenderDevice` waits on its `setStartInFlight`
// latch. A general fix needs per-tool abort support, which those handlers do
// not have yet.

type ToolHandler = (args: unknown, extra?: unknown) => Promise<ToolResult> | ToolResult;

/**
 * Human-readable refusal. This text is what the model relays to the user when
 * two sessions collide, so it names the holder, how long they have had it, and
 * the exact way out — a bare "denied" would leave the model guessing.
 */
function deniedMessage(name: string, denied: LeaseDenied): string {
  if (denied.transferring === true) {
    return (
      `${name} is unavailable: the device is mid-handover between clients and ` +
      `is being unloaded. Retry in a moment. device.unload and ` +
      `device.exit_guided_load remain available if you need to stop the machine now.`
    );
  }
  const heldFor = Math.round(denied.heldForMs / 1000);
  const setNote = denied.pinned
    ? ' That session is actively driving the device right now.'
    : ' The device is idle.';
  return (
    `${name} needs the device write-lease, which is held by client ` +
    `${denied.holder.clientId} (for ${heldFor}s).${setNote} ` +
    `Read-only tools still work. To take control, call system.lease_acquire ` +
    `with force: true — if a set is in progress the device is unloaded first.`
  );
}

/**
 * Distinguish the three refusal situations, because the right response differs:
 * a transfer means "retry in a moment", an engaged holder means "someone is
 * attached to the machine — confirm before taking it", and a plain hold means
 * "the device is idle, taking it is cheap".
 */
function leaseErrorCode(denied: LeaseDenied): string {
  if (denied.transferring === true) return 'LEASE_TRANSFERRING';
  return denied.pinned ? 'LEASE_HELD_ENGAGED' : 'LEASE_HELD';
}

/** Wrap one handler so it acquires the lease before running. */
function leaseGuarded(
  name: string,
  inner: ToolHandler,
  state: ServerState,
  self: ClientId,
): ToolHandler {
  return async (args: unknown, extra?: unknown): Promise<ToolResult> => {
    const decision = state.lease.tryAcquire(self);
    if (!decision.ok) {
      // Distinct code for the engaged case so a host can require explicit user
      // confirmation before stealing a device someone is attached to, rather
      // than treating it like an idle handover.
      return errorResult({
        code: leaseErrorCode(decision),
        message: deniedMessage(name, decision),
      });
    }
    return inner(args, extra);
  };
}

/**
 * Wrap every gated WRITE tool on this connection.
 *
 * Call once, after the real handlers are installed — wrapping a placeholder
 * would gate the `STARTING` response instead of the real work, and wrapping
 * twice would stack two acquisitions per call.
 */
export function applyLeaseGuard(
  placeholders: Map<string, RegisteredTool>,
  state: ServerState,
  self: ClientId,
): void {
  for (const [name, tool] of placeholders) {
    // A non-undefined access class proves `name` is a known tool, so the cast
    // is sound. The set is keyed on `ToolName` so a typo'd entry in
    // LEASE_EXEMPT_TOOLS is a tsc error rather than a silently gated tool.
    if (toolAccess(name) !== 'write') continue;
    if (LEASE_EXEMPT_TOOLS.has(name as ToolName)) continue;
    const inner = tool.handler as ToolHandler;
    tool.update({ callback: leaseGuarded(name, inner, state, self) as never });
  }
}
