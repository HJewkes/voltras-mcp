import { describe, expect, it } from 'vitest';

import {
  EMPTY_INTERVAL_STATE,
  intervalFor,
  trackInterval,
  type IntervalEvent,
  type IntervalState,
} from '../interval.js';

function replay(
  events: IntervalEvent[],
  start: IntervalState = EMPTY_INTERVAL_STATE,
): IntervalState {
  return events.reduce(trackInterval, start);
}

const started = (slot: string, setId: string): IntervalEvent => ({
  kind: 'set_started',
  slot,
  setId,
});
const rep = (slot: string, setId: string): IntervalEvent => ({
  kind: 'rep_finalized',
  slot,
  setId,
});
const ended = (slot: string, setId: string): IntervalEvent => ({ kind: 'set_ended', slot, setId });

describe('interval tracker', () => {
  it('has no interval for a slot whose first set has not started', () => {
    const state = replay([rep('primary', 'set-1')]);

    expect(intervalFor(state, 'primary')).toBeNull();
  });

  it('opens the pre interval when a set starts', () => {
    const state = replay([started('primary', 'set-1')]);

    expect(intervalFor(state, 'primary')).toEqual({ interval: 'pre', setId: 'set-1' });
  });

  it('moves to intra on the first finalized rep and stays there for later reps', () => {
    const afterFirst = replay([started('primary', 'set-1'), rep('primary', 'set-1')]);
    const afterThird = replay([rep('primary', 'set-1'), rep('primary', 'set-1')], afterFirst);

    expect(intervalFor(afterFirst, 'primary')?.interval).toBe('intra');
    expect(intervalFor(afterThird, 'primary')?.interval).toBe('intra');
  });

  it('moves to post when the set ends and holds post through a late rep', () => {
    const state = replay([
      started('primary', 'set-1'),
      rep('primary', 'set-1'),
      ended('primary', 'set-1'),
      rep('primary', 'set-1'),
    ]);

    expect(intervalFor(state, 'primary')).toEqual({ interval: 'post', setId: 'set-1' });
  });

  it('moves straight from pre to post when a set ends with no reps', () => {
    const state = replay([started('primary', 'set-1'), ended('primary', 'set-1')]);

    expect(intervalFor(state, 'primary')?.interval).toBe('post');
  });

  it('returns to pre for the next set after post', () => {
    const state = replay([
      started('primary', 'set-1'),
      rep('primary', 'set-1'),
      ended('primary', 'set-1'),
      started('primary', 'set-2'),
    ]);

    expect(intervalFor(state, 'primary')).toEqual({ interval: 'pre', setId: 'set-2' });
  });

  it('ignores a rep that belongs to a different set than the slot is in', () => {
    const state = replay([started('primary', 'set-2'), rep('primary', 'set-1')]);

    expect(intervalFor(state, 'primary')?.interval).toBe('pre');
  });

  it('tracks bilateral slots independently', () => {
    const state = replay([
      started('left', 'set-L'),
      started('right', 'set-R'),
      rep('left', 'set-L'),
      ended('right', 'set-R'),
    ]);

    expect(intervalFor(state, 'left')).toEqual({ interval: 'intra', setId: 'set-L' });
    expect(intervalFor(state, 'right')).toEqual({ interval: 'post', setId: 'set-R' });
  });

  it('leaves the input state untouched', () => {
    const before = replay([started('primary', 'set-1')]);

    trackInterval(before, rep('primary', 'set-1'));

    expect(intervalFor(before, 'primary')?.interval).toBe('pre');
  });
});
