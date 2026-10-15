import type { CueState, EffortConfidence } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import { readProximity, type ChannelEvent, type ProximityReading } from '../proximity.js';
import { DIRECTIVE_LOSS_FRACTION, directiveReason, registerFor } from '../tone.js';
import { effortTargetEvent, repEvents, SET_ID, velocityLossEvent } from './proximity-fixtures.js';

const CALM: ProximityReading = {
  cueState: null,
  rir: null,
  confidence: null,
  lossPct: null,
  lossThresholdPct: null,
  romDecayVerdict: null,
  endingEvent: null,
};

const reading = (overrides: Partial<ProximityReading>): ProximityReading => ({
  ...CALM,
  ...overrides,
});

describe('registerFor', () => {
  it('stays affirming with no reading or an all-null reading', () => {
    expect(registerFor(null)).toBe('affirming');
    expect(registerFor(CALM)).toBe('affirming');
  });

  it.each<CueState>(['approaching', 'reached', 'past'])(
    'turns directive when a high-confidence effort read is %s',
    (cueState) => {
      expect(registerFor(reading({ cueState, confidence: 'high' }))).toBe('directive');
    },
  );

  it.each<[CueState, EffortConfidence | null]>([
    ['working', 'high'],
    ['in_range', 'high'],
    ['approaching', 'low'],
    ['reached', 'low'],
    ['past', 'low'],
    ['past', null],
  ])('stays affirming for effort %s at confidence %s', (cueState, confidence) => {
    expect(registerFor(reading({ cueState, confidence }))).toBe('affirming');
  });

  it('turns directive at two thirds of the loss threshold, not before', () => {
    const threshold = 30;
    const edge = threshold * DIRECTIVE_LOSS_FRACTION;

    expect(registerFor(reading({ lossPct: edge, lossThresholdPct: threshold }))).toBe('directive');
    expect(registerFor(reading({ lossPct: edge - 0.1, lossThresholdPct: threshold }))).toBe(
      'affirming',
    );
  });

  it('pins the directive line at exactly two thirds of a 30% threshold', () => {
    expect(registerFor(reading({ lossPct: 20, lossThresholdPct: 30 }))).toBe('directive');
    expect(registerFor(reading({ lossPct: 19.9, lossThresholdPct: 30 }))).toBe('affirming');
  });

  it('never escalates on loss without a usable threshold', () => {
    expect(registerFor(reading({ lossPct: 90 }))).toBe('affirming');
    expect(registerFor(reading({ lossPct: 90, lossThresholdPct: 0 }))).toBe('affirming');
  });

  it('turns directive once a velocity-loss event has fired', () => {
    const fired = readProximity({ setId: SET_ID, events: [velocityLossEvent(40, 41)] });

    expect(directiveReason(fired)).toBe('ending_event');
    expect(registerFor(fired)).toBe('directive');
  });

  it('turns directive once an effort event has fired', () => {
    const fired = readProximity({ setId: SET_ID, events: [effortTargetEvent()] });

    expect(registerFor(fired)).toBe('directive');
  });

  it('turns directive on a ROM decay past its margin and not on a stable one', () => {
    expect(directiveReason(reading({ romDecayVerdict: 'shrinking' }))).toBe('rom_decay');
    expect(registerFor(reading({ romDecayVerdict: 'stable' }))).toBe('affirming');
  });

  it('turns directive from a rep stream that decays past the line', () => {
    const fresh = readProximity({
      setId: SET_ID,
      events: repEvents([1.0, 0.95, 0.9]),
      lossThresholdPct: 30,
    });
    const decayed = readProximity({
      setId: SET_ID,
      events: repEvents([1.0, 0.9, 0.79]),
      lossThresholdPct: 30,
    });

    expect(registerFor(fresh)).toBe('affirming');
    expect(registerFor(decayed)).toBe('directive');
  });
});

// Seeded so the property run is the same on every machine.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function relabel(events: readonly ChannelEvent[], offset: number): ChannelEvent[] {
  return events.map((event) => {
    const content = JSON.parse(event.content) as { rep: { rep_number: number } };
    const repNumber = content.rep.rep_number + offset;
    content.rep.rep_number = repNumber;
    return {
      meta: { ...event.meta, rep_count: String(repNumber) },
      content: JSON.stringify(content),
    };
  });
}

describe('registerFor property: rep numbers never move the register', () => {
  it('gives the same register for every relabelling of the same rep stream', () => {
    const random = seededRandom(604);
    for (let trial = 0; trial < 200; trial++) {
      const peaks = Array.from(
        { length: 2 + Math.floor(random() * 10) },
        () => 0.4 + random() * 0.6,
      );
      const firstRepNumber = 1 + Math.floor(random() * 20);
      const threshold = 10 + Math.floor(random() * 30);
      const events = repEvents(peaks, firstRepNumber);
      const baseline = registerFor(
        readProximity({ setId: SET_ID, events, lossThresholdPct: threshold }),
      );

      for (const offset of [-firstRepNumber + 1, 7, 1000]) {
        const relabelled = readProximity({
          setId: SET_ID,
          events: relabel(events, offset),
          lossThresholdPct: threshold,
        });
        expect(registerFor(relabelled)).toBe(baseline);
      }
    }
  });
});
