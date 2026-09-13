// Test doubles for the write-lease fence (VMCP-01.65).
//
// The real `WriteLease` needs a clock and a pin callback and the real
// publisher needs an McpServer; a fence only reads two numbers and publishes.
// These give a device-tool test a lease it can steal at an exact await point
// and a channel it can assert on, without either dependency.

import type { ChannelEvent, ChannelPublisher } from '../../channel-publisher.js';
import type { FenceableLease } from '../../lease-fence.js';

export interface FakeLease extends FenceableLease {
  /** Whether `clientId` holds the lease — what `fenceHolderOnly` reads (VW-232). */
  isHeldBy(clientId: string): boolean;
  /** Take the device, exactly as a forced `system.lease_acquire` would. */
  steal(): void;
  /** Freeze the lease as `beginTransfer` does, without completing a steal. */
  beginTransfer(): void;
  /**
   * Notify watchers WITHOUT moving the epoch — a holder refreshing its own
   * lease. Nothing may abort on this.
   */
  touch(): void;
}

/** `holder` is who holds the lease; a steal moves it to nobody this test names. */
export function makeFakeLease(holder?: string): FakeLease {
  let epoch = 1;
  let transferring = false;
  let heldBy = holder;
  const watchers = new Set<() => void>();
  const notify = (): void => {
    for (const watcher of [...watchers]) watcher();
  };
  return {
    generation: () => epoch,
    isTransferring: () => transferring,
    isHeldBy: (clientId: string) => heldBy !== undefined && clientId === heldBy,
    onChange: (listener: () => void) => {
      watchers.add(listener);
      return (): void => {
        watchers.delete(listener);
      };
    },
    steal: () => {
      epoch += 1;
      transferring = false;
      heldBy = undefined;
      notify();
    },
    beginTransfer: () => {
      transferring = true;
      notify();
    },
    touch: notify,
  };
}

export interface RecordingChannels extends ChannelPublisher {
  readonly events: Array<ChannelEvent & { slot?: string }>;
}

/** Records every publish, keeping the slot a `forSlot(...)` scoped it to. */
export function makeRecordingChannels(slot?: string): RecordingChannels {
  const events: Array<ChannelEvent & { slot?: string }> = [];
  const build = (scope: string | undefined): RecordingChannels => ({
    events,
    publish: (event: ChannelEvent) => {
      events.push(scope === undefined ? event : { ...event, slot: scope });
    },
    forSlot: (slotId: string) => build(slotId),
  });
  return build(slot);
}
