// Fence in-flight multi-step device writes against a lease steal (VMCP-01.65).
//
// `lease-guard.ts` checks the write-lease at call ENTRY and then awaits the
// handler with no cancellation path. A multi-step writer awaits in the middle —
// a mode echo, a pre-trigger unload, an STT round-trip — and by the time it
// resumes another client may have force-stolen the device and had it unloaded
// underneath. Without a fence the victim's remaining writes still land, and
// re-engage a motor the new holder believes is slack.
//
// The fence is the cheap half of the fix: capture the lease epoch before the
// first BLE write, re-check it after every await, and abort with `LEASE_LOST`
// rather than issue the rest. It does not cancel a write already handed to the
// SDK — nothing here can un-send a frame — so a fence bounds the damage to the
// step already in flight. Per-tool `AbortSignal` support is the other half and
// is not in this change.
//
// Generations, not holder names: a release followed by the SAME client
// re-acquiring is still a new epoch, because the device was surrendered in
// between. A mid-handover freeze counts as lost too — that window exists
// precisely so the outgoing holder cannot drive a device that is being
// unloaded.

import { buildLeaseLostPayload } from './channel-payloads.js';
import type { ChannelPublisher } from './channel-publisher.js';

/**
 * Thrown by {@link LeaseFence.check}. `code` is what `mapSdkError` reads, so a
 * handler that lets this propagate returns a `LEASE_LOST` tool error.
 */
export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';

  constructor(tool: string, slot: string) {
    super(
      `${tool} stopped partway on slot \`${slot}\`: another client took the device ` +
        'write-lease while this call was waiting on the device, so the remaining writes ' +
        'were not issued. Call system.lease_acquire to take the device back, then re-issue ' +
        'the whole call — the settings that did land are not rolled back.',
    );
    this.name = 'LeaseLostError';
  }
}

/** The part of `WriteLease` a fence reads. */
export interface FenceableLease {
  generation(): number;
  isTransferring(): boolean;
}

export interface FenceDeps {
  lease: FenceableLease;
  channels: ChannelPublisher;
}

export interface LeaseFence {
  /** The lease epoch this fence was taken at. */
  readonly generation: number;
  /** Whether the fence still authorises a device write. */
  intact(): boolean;
  /** Abort the call: publish `lease_lost` and throw {@link LeaseLostError}. */
  check(slot: string): void;
  /**
   * Publish `lease_lost` without throwing, for the callers that are not tool
   * handlers (the voice fast-path has no tool result to fail).
   */
  report(slot: string): void;
}

/**
 * Take a fence at the current lease epoch. Call this before the first BLE
 * write of a multi-step tool, then {@link LeaseFence.check} after every await.
 *
 * `lease_lost` is published at most once per fence: the lease is gone, and one
 * event per abandoned write would be noise on a channel the model reads inline.
 */
export function fence(deps: FenceDeps, tool: string): LeaseFence {
  const taken = deps.lease.generation();
  let reported = false;
  const intact = (): boolean => deps.lease.generation() === taken && !deps.lease.isTransferring();
  const report = (slot: string): void => {
    if (reported) return;
    reported = true;
    deps.channels.forSlot(slot).publish(buildLeaseLostPayload({ tool, slot }));
  };
  return {
    generation: taken,
    intact,
    report,
    check(slot: string): void {
      if (intact()) return;
      report(slot);
      throw new LeaseLostError(tool, slot);
    },
  };
}
