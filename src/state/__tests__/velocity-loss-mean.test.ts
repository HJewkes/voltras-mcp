// VW-484: the set stop gate measures velocity loss on MEAN concentric
// velocity, not peak.
//
// The thresholds (20 strength / 30 hypertrophy / 10 power) come from studies
// that measure mean or mean-propulsive velocity, and every other surface —
// the wall, workout-analytics, the fitted RIR curve — already reads the mean.
// A gate on peaks measured one quantity and compared it against another.
//
// The shapes here pull peak and mean apart deliberately: a real rep's peak can
// hold up while its mean falls away, which is the case where the two measures
// disagree about when a set should stop.

import { getSetVelocityLossPct, type Rep } from '@voltras/workout-analytics';
import { describe, expect, it } from 'vitest';

import { summarizeSetForTrigger } from '../channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from '../live-state.js';
import { velocityLossReading } from '../velocity-loss-gate.js';
import { makeShapedRep, WORKING_REP } from './fixtures/rep-shapes.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100 };

/** The loss reading at every rep of a set, as the gate walks it rep by rep. */
function lossAtEachRep(reps: readonly Rep[]): (number | null)[] {
  return reps.map((rep, i) => velocityLossReading(reps.slice(0, i + 1), rep, DEVICE).lossPct);
}

/** The 1-indexed rep where the loss first reaches `pct`, or null if it never does. */
function firesAtRep(reps: readonly Rep[], pct: number): number | null {
  const index = lossAtEachRep(reps).findIndex((loss) => loss !== null && loss >= pct);
  return index === -1 ? null : index + 1;
}

/** The same walk, on PEAK velocity — what the gate did before VW-484. */
function peakFiresAtRep(reps: readonly Rep[], pct: number): number | null {
  let baseline = 0;
  for (let i = 0; i < reps.length; i++) {
    const current = reps[i].concentric.peakVelocity;
    baseline = Math.max(baseline, current);
    if (baseline > 0 && current < baseline && (100 * (baseline - current)) / baseline >= pct) {
      return i + 1;
    }
  }
  return null;
}

describe('the stop gate reads mean concentric velocity (VW-484)', () => {
  /**
   * A set whose peak holds up while the mean decays: peak falls 4% over six
   * reps, the mean falls 30%. Past rep 4 the lifter is over a 20% loss on the
   * measure the threshold was written for, and nowhere near it on peaks.
   */
  const PEAK_HOLDS_MEAN_FALLS: readonly Rep[] = [1.0, 0.94, 0.86, 0.79, 0.74, 0.7].map(
    (meanMps, i) =>
      makeShapedRep(i + 1, {
        romM: WORKING_REP.romM,
        peakMps: 1.2 - i * 0.008,
        meanMps,
      }),
  );

  it('fires on the rep where the MEAN crosses, not where the peak would', () => {
    // Mean: 1.0 baseline, rep 4 is 0.79, a 21% loss. Peak never loses 20%.
    expect(firesAtRep(PEAK_HOLDS_MEAN_FALLS, 20)).toBe(4);
    expect(peakFiresAtRep(PEAK_HOLDS_MEAN_FALLS, 20)).toBeNull();
  });

  it('reads the loss off the mean, so the reported figure is the mean figure', () => {
    const atRep4 = velocityLossReading(
      PEAK_HOLDS_MEAN_FALLS.slice(0, 4),
      PEAK_HOLDS_MEAN_FALLS[3],
      DEVICE,
    );

    expect(atRep4.baseline).toBeCloseTo(1.0, 6);
    expect(atRep4.current).toBeCloseTo(0.79, 6);
    expect(atRep4.lossPct).toBeCloseTo(21, 6);
    expect(atRep4.baselineRepNumber).toBe(1);
  });

  it('reads no loss on a new fastest MEAN rep, however its peak moved', () => {
    const reps = [
      makeShapedRep(1, { romM: WORKING_REP.romM, peakMps: 1.4, meanMps: 0.8 }),
      makeShapedRep(2, { romM: WORKING_REP.romM, peakMps: 1.0, meanMps: 0.95 }),
    ];

    const reading = velocityLossReading(reps, reps[1], DEVICE);

    // Its peak dropped 29%, which would have fired a 20% threshold on peaks.
    expect(reading.lossPct).toBeNull();
    expect(peakFiresAtRep(reps, 20)).toBe(2);
  });

  it('agrees with the wall when every rep is eligible', () => {
    // The wall reads workout-analytics' set-level loss over ALL reps; the gate
    // reads its own window over the ELIGIBLE ones. On a set where nothing is
    // filtered, the two must be the same number, since they now measure the
    // same thing (VW-484).
    const reps = PEAK_HOLDS_MEAN_FALLS;
    const last = reps[reps.length - 1];

    const gate = velocityLossReading(reps, last, DEVICE).lossPct;

    expect(gate).toBeCloseTo(getSetVelocityLossPct({ reps: [...reps] }), 6);
  });

  it('reports the set summary on the same measure the gate compares (VW-484)', () => {
    const set: ActiveSet = {
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2026-09-19T00:00:00.000Z',
      reps: [...PEAK_HOLDS_MEAN_FALLS],
      status: 'active',
    };

    const summary = summarizeSetForTrigger(set, DEVICE).vbt_summary;

    // Every figure is a mean, so none of them matches the 1.2-ish peaks.
    expect(summary.velocity_measure).toBe('mean_concentric');
    expect(summary.first_rep_v).toBeCloseTo(1.0, 3);
    expect(summary.baseline_rep_v).toBeCloseTo(1.0, 3);
    expect(summary.baseline_rep_number).toBe(1);
    expect(summary.last_rep_v).toBeCloseTo(0.7, 3);
    expect(summary.velocity_loss_pct).toBeCloseTo(30, 1);
  });

  it('still drops an eccentric-overload lead-in before measuring (VW-268)', () => {
    const overloaded: DeviceSnapshot = { ...DEVICE, eccentricPercentTenths: 1200 };
    const reps = PEAK_HOLDS_MEAN_FALLS.slice(0, 4);

    const reading = velocityLossReading(reps, reps[3], overloaded);

    // Rep 1's 1.0 is out of the window, so the baseline is rep 3's 0.86 and the
    // loss is measured from there, not from the slowed opening rep.
    expect(reading.exclusion.leadInReps).toBeGreaterThan(0);
    expect(reading.baseline).toBeCloseTo(0.86, 6);
    expect(reading.lossPct).toBeCloseTo((100 * (0.86 - 0.79)) / 0.86, 6);
  });
});
