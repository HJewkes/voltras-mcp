// The one "a set has started" seam (VW-540). Every place that opens an active
// set calls it once the set is installed and its start snapshot recorded:
// `set.start`, auto-arm and the guided-load bootstrap.
//
// A subscriber is registered by adding it to SET_START_SUBSCRIBERS. Each runs
// independently, and a failure in one is logged and never reaches the set.

import { log } from '../logger.js';
import { pinEffortContext } from './effort-pin.js';
import { getSlot, type ServerState } from './server-state.js';

export interface SetStartEvent {
  slotId: string;
  setId: string;
}

export type SetStartSubscriber = (state: ServerState, event: SetStartEvent) => Promise<void>;

const pinEffortOnStart: SetStartSubscriber = (state, event) =>
  pinEffortContext(state, getSlot(state, event.slotId).live, event.setId);

export const SET_START_SUBSCRIBERS: readonly SetStartSubscriber[] = [pinEffortOnStart];

/** Run every subscriber for one started set. Never rejects. */
export async function onSetStarted(
  state: ServerState,
  event: SetStartEvent,
  subscribers: readonly SetStartSubscriber[] = SET_START_SUBSCRIBERS,
): Promise<void> {
  await Promise.all(
    subscribers.map(async (subscriber) => {
      try {
        await subscriber(state, event);
      } catch (err) {
        log.warn('set-start: a subscriber failed; the set is unaffected', err);
      }
    }),
  );
}
