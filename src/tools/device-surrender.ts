// Hand the device over safely (VMCP-01.61).
//
// Any transfer of the write-lease from one client to another has to leave the
// device in a state the next holder can actually use, and leave the previous
// holder's work persisted. Dropping the cable's load is NOT sufficient:
//
//   - `unloadSlot` unloads and exits guided load but never ends the live set,
//     so the victim's `slot.live.set` stays `status: 'active'`. The new holder's
//     `set.start` then throws `SET_ALREADY_ACTIVE` and the takeover yields a
//     device nobody can lift on.
//   - A stranded active set pins the lease forever (see `isDeviceEngaged`), so
//     the new holder's lease can never idle-expire.
//   - Worst: the previous holder is now lease-denied on `set.end`, so its reps
//     are never written. Silent data loss.
//
// So surrender = FINALIZE the set (which persists it) and THEN unload. Order
// matters: `finalizeSet` reads live device state to stamp the stored row.

import { finalizeSet } from './set-tools.js';
import { setTimeout as delay } from 'node:timers/promises';
import { unloadSlot } from './device-tools.js';
import { getSlot, type ServerState } from '../state/server-state.js';
import { log } from '../logger.js';

/** How long to wait for an in-flight `set.start` to install its set. */
const SET_START_SETTLE_TIMEOUT_MS = 3000;
const SET_START_POLL_MS = 10;

/**
 * Accumulate errors rather than overwrite. A slot that failed to finalize AND
 * failed to unload must report both — reporting only the unload error would
 * hide the data-loss half.
 */
function appendError(outcome: SlotSurrender, message: string): void {
  outcome.error = outcome.error === undefined ? message : `${outcome.error}; ${message}`;
}

/**
 * Block until no slot has a `set.start` mid-flight, or the timeout expires.
 * Bounded: a wedged radio must not make surrender hang forever — proceeding
 * without the set installed is worse than nothing, but hanging is worse still.
 */
async function waitForSetStartsToSettle(state: ServerState): Promise<void> {
  const deadline = Date.now() + SET_START_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let pending = false;
    for (const slot of state.slots.values()) {
      if (slot.setStartInFlight === true) pending = true;
    }
    if (!pending) return;
    await delay(SET_START_POLL_MS);
  }
  log.warn('surrender: a set.start was still in flight after the settle timeout');
}

/** What happened to one slot during a surrender. */
export interface SlotSurrender {
  slotId: string;
  /** setId of a set finalized (and persisted) on the way out, if any. */
  finalizedSetId: string | null;
  /** False when the cable may still be loaded — the caller must say so. */
  unloaded: boolean;
  /** Present when a step failed; the message is safe to show a user. */
  error?: string;
}

export interface SurrenderResult {
  slots: SlotSurrender[];
  /** True when at least one connected slot could not be unloaded. */
  anyUnloadFailed: boolean;
  /** True when NO connected slot could be unloaded — the dangerous case. */
  allUnloadsFailed: boolean;
}

/**
 * Finalize any active set and drop the load on every connected slot.
 *
 * Failures are captured per slot rather than thrown: one wedged slot must not
 * stop the others from being made safe. The caller decides what a failure
 * means — {@link SurrenderResult} exists so a forced takeover can tell the user
 * "the cable may still be loaded" instead of assuming it isn't.
 */
export async function surrenderDevice(state: ServerState): Promise<SurrenderResult> {
  // Let any in-flight `set.start` finish installing its set before we finalize.
  // `set.start` engages the motor and only calls `live.startSet` after the BLE
  // round-trip, clearing `setStartInFlight` after THAT. Surrendering inside
  // that window would finalize nothing (there is no set yet), and the caller's
  // continuation would then install an active set on a device it no longer
  // owns — re-orphaning exactly what surrender exists to prevent.
  await waitForSetStartsToSettle(state);

  const slots: SlotSurrender[] = [];
  let connectedCount = 0;
  let unloadFailures = 0;

  for (const slotId of state.slots.keys()) {
    const slot = getSlot(state, slotId);
    const outcome: SlotSurrender = { slotId, finalizedSetId: null, unloaded: false };

    // Finalize BEFORE unloading so the stored row reflects the configuration
    // that was actually being lifted against.
    try {
      const stored = await finalizeSet(state, slotId, { cause: 'tool', disengageMotor: true });
      outcome.finalizedSetId = stored?.id ?? null;
    } catch (err) {
      appendError(outcome, `failed to finalize the active set: ${String(err)}`);
      log.error(`surrender: could not finalize set on slot ${slotId}`, err);
    }

    if (!slot.client.isConnected) {
      // Nothing to unload; not counted as a failure.
      outcome.unloaded = true;
      slots.push(outcome);
      continue;
    }

    connectedCount += 1;
    try {
      await unloadSlot(state, slotId);
      outcome.unloaded = true;
    } catch (err) {
      unloadFailures += 1;
      appendError(outcome, `failed to unload: ${String(err)}`);
      log.error(`surrender: could not unload slot ${slotId}`, err);
    }
    slots.push(outcome);
  }

  return {
    slots,
    anyUnloadFailed: unloadFailures > 0,
    allUnloadsFailed: connectedCount > 0 && unloadFailures === connectedCount,
  };
}
