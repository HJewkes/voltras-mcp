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
// step already in flight.
//
// VW-200 adds the other half for the tools that BLOCK rather than step: an
// isometric hold, a protocol rest, `timer.wait`. They have no await to re-check
// at, so `signal()` turns the same fence into an `AbortSignal` fed by the
// lease's change notification, and `waitFenced` is the sleep that honours it.
// Same epoch, same publish, no second clock.
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
  /** Subscribe to lease changes; returns the unsubscribe handle. */
  onChange(listener: () => void): () => void;
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
   * Publish `lease_lost` and RETURN the error rather than throwing it, for the
   * abort callbacks that have a promise to reject instead of a stack to unwind.
   */
  lost(slot: string): LeaseLostError;
  /**
   * Publish `lease_lost` without throwing, for the callers that are not tool
   * handlers (the voice fast-path has no tool result to fail).
   */
  report(slot: string): void;
  /**
   * A signal that aborts the moment the fence stops being intact (VW-200).
   *
   * For the blocking holders — an isometric hold, a rest, `timer.wait` — which
   * are parked on a timer and have no await to re-check at. The signal is
   * driven by the lease's own change notification, so it reads the same epoch
   * `intact()` does and introduces no second clock. Created on first call and
   * memoised; {@link dispose} drops the subscription it takes.
   */
  signal(): AbortSignal;
  /**
   * Drop the lease subscription taken by {@link signal}. A no-op for a fence
   * that never asked for one, so the step-by-step `check` callers need not
   * call it.
   */
  dispose(): void;
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
  let controller: AbortController | null = null;
  let unsubscribe: (() => void) | null = null;
  return {
    generation: taken,
    intact,
    report,
    lost(slot: string): LeaseLostError {
      report(slot);
      return new LeaseLostError(tool, slot);
    },
    check(slot: string): void {
      if (intact()) return;
      report(slot);
      throw new LeaseLostError(tool, slot);
    },
    signal(): AbortSignal {
      if (controller !== null) return controller.signal;
      const created = new AbortController();
      controller = created;
      if (!intact()) {
        created.abort();
        return created.signal;
      }
      unsubscribe = deps.lease.onChange(() => {
        if (intact()) return;
        created.abort();
      });
      return created.signal;
    },
    dispose(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/**
 * Sleep `ms`, or reject with {@link LeaseLostError} the moment the fence
 * trips (VW-200).
 *
 * This is what makes a blocking lease holder interruptible: the timer and the
 * lease's change notification race, and whichever lands first settles the
 * promise. On a trip it publishes `lease_lost` exactly as a step-by-step
 * `check` would, because it goes through the same fence.
 */
export function waitFenced(ms: number, leaseFence: LeaseFence, slot: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const signal = leaseFence.signal();
    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      settle();
      reject(leaseFence.lost(slot));
    };
    const timer = setTimeout(() => {
      settle();
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
  });
}
