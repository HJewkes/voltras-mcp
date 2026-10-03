// Error boundary for the event bridge's SDK listeners (VW-809).
//
// The SDK runs a typed event's listeners in a bare loop, so one listener that
// throws aborts every listener after it for that event, and the adapter only
// reports it on the console. Wrapping each bridge listener keeps the failure
// inside the bridge: the voltras logger records it and the slot counts it, so
// `device.get_state` can show an operator that an event was dropped.

import type { VoltraClient } from '@voltras/node-sdk';
import { log } from '../logger.js';

/** The slot fields a guarded listener reports a failure against. */
export interface GuardedSlot {
  slotId: string;
  /** Throws caught per event label since the slot was created. */
  listenerFaults?: Record<string, number>;
}

const LISTENER_LABELS = {
  onRawFrame: 'raw_frame',
  onFrame: 'frame',
  onPerRep: 'per_rep',
  onSummary: 'summary',
  onSetSummary: 'set_summary',
  onInProgress: 'in_progress',
  onGuidedLoadState: 'guided_load_state',
  onSettingsUpdate: 'settings_update',
  onStateDump: 'state_dump',
  onConnectionStateChange: 'connection_state_change',
} as const;

type ListenerName = keyof typeof LISTENER_LABELS;
type AnyListener = (...args: never[]) => void;

/** The client's `on*` registrations, each wrapped by {@link guardListener}. */
export type GuardedListeners = {
  [K in ListenerName]: (listener: Parameters<VoltraClient[K]>[0]) => unknown;
};

/**
 * Wrap `fn` so a throw is logged and counted on `slot` instead of escaping
 * into the SDK. Only the event label and slot id reach the log, never the
 * event payload.
 */
export function guardListener<A extends unknown[]>(
  label: string,
  slot: GuardedSlot,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args);
    } catch (err) {
      recordListenerFault(label, slot, err);
    }
  };
}

/** A view of `client` whose `on*` methods register guarded listeners. */
export function guardClientListeners(client: VoltraClient, slot: GuardedSlot): GuardedListeners {
  const guarded = {} as Record<ListenerName, (listener: AnyListener) => unknown>;
  for (const name of Object.keys(LISTENER_LABELS) as ListenerName[]) {
    guarded[name] = (listener) => {
      const register = client[name] as (wrapped: AnyListener) => unknown;
      return register.call(client, guardListener(LISTENER_LABELS[name], slot, listener));
    };
  }
  return guarded as GuardedListeners;
}

function recordListenerFault(label: string, slot: GuardedSlot, err: unknown): void {
  const faults = (slot.listenerFaults ??= {});
  faults[label] = (faults[label] ?? 0) + 1;
  log.error(`event-bridge: ${label} listener threw on slot ${slot.slotId}`, err);
}
