import { describe, expect, it } from 'vitest';

import { readProximity, type ChannelEvent } from '../proximity.js';
import {
  activeSet,
  effortTargetEvent,
  makeRep,
  repEvents,
  SET_ID,
  setStartedEvent,
  velocityLossEvent,
} from './proximity-fixtures.js';
import { buildRepFinalizedPayload } from '../../../state/channel-payloads.js';

function read(events: ChannelEvent[], extra: Partial<Parameters<typeof readProximity>[0]> = {}) {
  return readProximity({ setId: SET_ID, events, ...extra });
}

describe('readProximity', () => {
  it('reads every signal as null for a set with no reps or effort', () => {
    expect(read([setStartedEvent()])).toEqual({
      cueState: null,
      rir: null,
      confidence: null,
      lossPct: null,
      lossThresholdPct: null,
      romDecayVerdict: null,
      endingEvent: null,
    });
  });

  it('measures loss from the fastest rep to the latest rep', () => {
    const reading = read(repEvents([1.0, 0.9, 0.8]));

    expect(reading.lossPct).toBeCloseTo(20, 5);
  });

  it('reads no loss when the latest rep is the fastest', () => {
    expect(read(repEvents([0.8, 0.9, 1.0])).lossPct).toBe(0);
  });

  it('needs two reps before it reads a loss', () => {
    expect(read(repEvents([1.0])).lossPct).toBeNull();
  });

  it('keeps a positioning pull out of the baseline', () => {
    const pull = makeRep(1, 1.6, 1.0);
    const pullEvent = buildRepFinalizedPayload(pull, 0, activeSet([pull]), { connected: true }, 2);
    const working = repEvents([0.8, 0.8, 0.76], 2);

    expect(read([pullEvent, ...working]).lossPct).toBeCloseTo(5, 5);
  });

  it('drops the excluded lead-in reps from the loss window', () => {
    const events = repEvents([1.0, 0.7, 0.8, 0.76]);

    expect(read(events, { leadInReps: 2 }).lossPct).toBeCloseTo(5, 5);
  });

  it('ignores reps and events from another set', () => {
    const other = repEvents([1.0, 0.5], 1, 'set-other');

    expect(read([...other, ...repEvents([0.8, 0.8])]).lossPct).toBe(0);
  });

  it('records a fired velocity-loss event and takes its threshold', () => {
    const reading = read([...repEvents([1.0, 0.7]), velocityLossEvent(25, 30)]);

    expect(reading.endingEvent).toBe('velocity_loss_exceeded');
    expect(reading.lossThresholdPct).toBe(25);
  });

  it('prefers the threshold the caller supplies', () => {
    expect(read([velocityLossEvent(25, 30)], { lossThresholdPct: 20 }).lossThresholdPct).toBe(20);
  });

  it('records a fired effort event', () => {
    expect(read([effortTargetEvent()]).endingEvent).toBe('effort_target_reached');
  });

  it('carries the effort rep and ROM verdict through', () => {
    const reading = read([], {
      effort: { cueState: 'approaching', confidence: 'high', rir: 2 },
      romDecayVerdict: 'shrinking',
    });

    expect(reading).toMatchObject({
      cueState: 'approaching',
      confidence: 'high',
      rir: 2,
      romDecayVerdict: 'shrinking',
    });
  });

  it('skips a rep event whose content does not parse', () => {
    const broken: ChannelEvent = {
      meta: { event_type: 'rep_finalized', set_id: SET_ID },
      content: '{',
    };

    expect(read([broken, ...repEvents([1.0, 0.9])]).lossPct).toBeCloseTo(10, 5);
  });
});
