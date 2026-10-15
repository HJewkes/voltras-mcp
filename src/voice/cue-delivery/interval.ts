// Per-slot interval tracker for the cue-delivery layer (VW-140 S1).
//
// A set moves through three spoken windows: `pre` from `set_started` to the
// first `rep_finalized`, `intra` until `set_ended`, and `post` until the next
// `set_started`. State is keyed by slot so bilateral units never share a window.

export type Interval = 'pre' | 'intra' | 'post';

export type IntervalEventKind = 'set_started' | 'rep_finalized' | 'set_ended';

export interface IntervalEvent {
  kind: IntervalEventKind;
  slot: string;
  setId: string;
}

export interface SlotInterval {
  interval: Interval;
  setId: string;
}

export type IntervalState = ReadonlyMap<string, SlotInterval>;

export const EMPTY_INTERVAL_STATE: IntervalState = new Map();

/** The slot's current window, or `null` before its first set starts. */
export function intervalFor(state: IntervalState, slot: string): SlotInterval | null {
  return state.get(slot) ?? null;
}

/** Apply one channel event; returns a new state and never mutates the input. */
export function trackInterval(state: IntervalState, event: IntervalEvent): IntervalState {
  const next = nextSlotInterval(state.get(event.slot), event);
  if (next === undefined) return state;
  return new Map(state).set(event.slot, next);
}

function nextSlotInterval(
  current: SlotInterval | undefined,
  event: IntervalEvent,
): SlotInterval | undefined {
  if (event.kind === 'set_started') return { interval: 'pre', setId: event.setId };
  if (current === undefined || current.setId !== event.setId) return undefined;
  if (event.kind === 'set_ended') return { interval: 'post', setId: event.setId };
  if (current.interval === 'pre') return { interval: 'intra', setId: event.setId };
  return undefined;
}
