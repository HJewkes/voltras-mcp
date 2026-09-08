// VW-168: the velocity-loss baseline, the `set_ended` VBT summary and the
// `vbt.rir` denominator all read the same eligible-rep window.
//
// The shapes below are the 2026-09-07 dogfood's: a rope-positioning pull at
// the head of the set was the fastest "rep" in it, so the unfiltered peak made
// it the baseline and `velocity_loss_exceeded` fired on rep 2 of every set.

import { describe, expect, it } from 'vitest';

import {
  peakConcentricBaseline,
  summarizeSetForTrigger,
  velocityLossBaseline,
} from '../channel-payloads.js';
import type { ActiveSet } from '../live-state.js';
import {
  makeShapedRep,
  makeWorkingSet,
  POSITIONING_PULL,
  WORKING_REP,
} from './fixtures/rep-shapes.js';

/** Loss (%) the trigger would compute for the last rep of `reps`. */
function lossPctAtLastRep(reps: ReturnType<typeof makeWorkingSet>): number {
  const { velocity: baseline } = velocityLossBaseline(reps);
  const current = reps[reps.length - 1].concentric.peakVelocity;
  return baseline <= 0 || current >= baseline ? 0 : (100 * (baseline - current)) / baseline;
}

describe('velocityLossBaseline', () => {
  it('(a) ignores the positioning pull that opened the set', () => {
    const working = makeWorkingSet(3).map((rep, i) => ({ ...rep, repNumber: i + 2 }));
    const reps = [makeShapedRep(1, POSITIONING_PULL), ...working];

    const { velocity, repNumber } = velocityLossBaseline(reps);

    expect(velocity).toBeCloseTo(WORKING_REP.peakMps, 6);
    expect(repNumber).toBe(2);
    // Unfiltered, the pull would have been the baseline and every later rep
    // would have read as a ~47% loss.
    expect(peakConcentricBaseline(reps)).toBeCloseTo(POSITIONING_PULL.peakMps, 6);
  });

  it('(a) keeps the loss on the rep after the pull under a 25% threshold', () => {
    const working = makeWorkingSet(2).map((rep, i) => ({ ...rep, repNumber: i + 2 }));
    const reps = [makeShapedRep(1, POSITIONING_PULL), ...working];

    expect(lossPctAtLastRep(reps)).toBeLessThan(25);
  });

  it('(b) leaves an ordinary set on the unfiltered baseline', () => {
    const reps = makeWorkingSet(5);

    expect(velocityLossBaseline(reps).velocity).toBeCloseTo(peakConcentricBaseline(reps), 6);
    expect(velocityLossBaseline(reps).repNumber).toBe(1);
  });

  it('(c) keeps a genuinely fastest rep 1 as the baseline', () => {
    const reps = [
      makeShapedRep(1, { romM: WORKING_REP.romM, peakMps: 1.2 }),
      ...makeWorkingSet(3).map((rep, i) => ({ ...rep, repNumber: i + 2 })),
    ];

    const { velocity, repNumber } = velocityLossBaseline(reps);

    expect(velocity).toBeCloseTo(1.2, 6);
    expect(repNumber).toBe(1);
  });

  it('(d) does not exclude either rep of a two-rep set', () => {
    const reps = makeWorkingSet(2);

    expect(velocityLossBaseline(reps).velocity).toBeCloseTo(peakConcentricBaseline(reps), 6);
  });
});

describe('vbt_summary agrees with the trigger about which reps were work', () => {
  function summarize(reps: ReturnType<typeof makeWorkingSet>) {
    const set: ActiveSet = {
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2026-09-07T00:00:00.000Z',
      reps,
      status: 'active',
    };
    return summarizeSetForTrigger(set, { connected: true, weightLbs: 40 }).vbt_summary;
  }

  it('reports the first and peak velocities of the eligible reps', () => {
    const working = makeWorkingSet(3).map((rep, i) => ({ ...rep, repNumber: i + 2 }));
    const summary = summarize([makeShapedRep(1, POSITIONING_PULL), ...working]);

    expect(summary.peak_rep_v).toBeCloseTo(WORKING_REP.peakMps, 2);
    expect(summary.peak_rep_number).toBe(2);
    expect(summary.first_rep_v).toBeCloseTo(WORKING_REP.peakMps, 2);
  });

  it('still reports the set’s actual last rep', () => {
    const working = makeWorkingSet(3).map((rep, i) => ({ ...rep, repNumber: i + 2 }));
    const reps = [makeShapedRep(1, POSITIONING_PULL), ...working];

    expect(summarize(reps).last_rep_v).toBeCloseTo(
      reps[reps.length - 1].concentric.peakVelocity,
      2,
    );
  });
});
