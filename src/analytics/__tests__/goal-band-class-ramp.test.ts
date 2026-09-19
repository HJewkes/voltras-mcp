// The per-class weekly ramp (VW-482), pinned as 8-week high and low edges.
// The intermediate rows are the research's R3 table
// (sources/research/2026-09-19-vw-482-progression-rates-research.md §1.5),
// computed exactly: 7 steps of the class percent, and the low edge holds every
// other week, so it takes 3.5 of them.

import { describe, expect, it } from 'vitest';

import {
  deriveGoalBand,
  programmedRampStepLbs,
  type GoalBandInput,
  type RampClass,
} from '../goal-band.js';
import type { Tier } from '../../tools/tier-signal.js';

const EIGHT_WEEKS = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, isDeload: false }));

function eightWeekBand(startValue: number, rampClass: RampClass, tier: Tier, cold = false) {
  const input: GoalBandInput = {
    metric: 'top_load_at_reps',
    startValue,
    horizonWeeks: 8,
    weeks: EIGHT_WEEKS,
    tier,
    rampClass,
    infoLevel: cold ? 'cold' : 'ramp',
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    layoff: false,
    matchedSessionCount: cold ? 0 : 4,
    baselineState: cold ? 'COLD' : 'CALIBRATED',
    completedMesoCount: 0,
  };
  return deriveGoalBand(input);
}

type Edges = readonly [high: number, low: number];
type ClassRow = readonly [isolation: Edges, upper: Edges, lower: Edges];

const CLASSES: readonly RampClass[] = ['isolation', 'upper_compound', 'lower_compound'];

const PINNED: Record<Tier, Record<number, ClassRow>> = {
  intermediate: {
    20: [
      [22.1, 21.05],
      [22.8, 21.4],
      [24.2, 22.1],
    ],
    40: [
      [44.2, 42.1],
      [45.6, 42.8],
      [48.4, 44.2],
    ],
    100: [
      [110.5, 105.25],
      [114, 107],
      [121, 110.5],
    ],
    200: [
      [221, 210.5],
      [228, 214],
      [242, 221],
    ],
    300: [
      [331.5, 315.75],
      [342, 321],
      [363, 331.5],
    ],
  },
  beginner: {
    20: [
      [23.15, 21.575],
      [24.2, 22.1],
      [26.3, 23.15],
    ],
    40: [
      [46.3, 43.15],
      [48.4, 44.2],
      [52.6, 46.3],
    ],
    100: [
      [115.75, 107.875],
      [121, 110.5],
      [131.5, 115.75],
    ],
    200: [
      [231.5, 215.75],
      [242, 221],
      [263, 231.5],
    ],
    // 4.5% of 300 is 13.5 lb, so the 10 lb cap binds.
    300: [
      [347.25, 323.625],
      [363, 331.5],
      [370, 335],
    ],
  },
  advanced: {
    20: [
      [21.05, 20.525],
      [21.4, 20.7],
      [22.1, 21.05],
    ],
    40: [
      [42.1, 41.05],
      [42.8, 41.4],
      [44.2, 42.1],
    ],
    100: [
      [105.25, 102.625],
      [107, 103.5],
      [110.5, 105.25],
    ],
    200: [
      [210.5, 205.25],
      [214, 207],
      [221, 210.5],
    ],
    300: [
      [315.75, 307.875],
      [321, 310.5],
      [331.5, 315.75],
    ],
  },
};

describe.each(Object.keys(PINNED) as Tier[])('%s: 8-week edges by class', (tier) => {
  const cases = Object.entries(PINNED[tier]).flatMap(([start, row]) =>
    CLASSES.map((rampClass, i) => ({ start: Number(start), rampClass, edges: row[i] })),
  );

  it.each(cases)('$start lb $rampClass ends at $edges', ({ start, rampClass, edges }) => {
    const band = eightWeekBand(start, rampClass, tier);
    expect(band.stretchValue).toBeCloseTo(edges[0], 6);
    expect(band.committedValue).toBeCloseTo(edges[1], 6);
  });
});

describe('the cable overhead tricep extension that opened VW-482', () => {
  it('derives a cold 40 lb isolation goal near 44 lb over 8 weeks, not 57.5', () => {
    const band = eightWeekBand(40, 'isolation', 'intermediate', true);
    expect(band.committedValue).toBeCloseTo(44.2, 6);
    expect(band.stretchValue).toBeCloseTo(44.2, 6);
  });
});

describe('programmedRampStepLbs', () => {
  it('orders the classes isolation, upper, lower at every tier', () => {
    for (const tier of ['beginner', 'intermediate', 'advanced'] as const) {
      const [isolation, upper, lower] = CLASSES.map((c) => programmedRampStepLbs(100, c, tier));
      expect(isolation).toBeLessThan(upper);
      expect(upper).toBeLessThan(lower);
    }
  });

  it('keeps the step exact rather than rounding it to the device step', () => {
    expect(programmedRampStepLbs(40, 'isolation', 'intermediate')).toBeCloseTo(0.6, 9);
  });

  it('caps the step at 10 lb', () => {
    expect(programmedRampStepLbs(400, 'lower_compound', 'intermediate')).toBe(10);
  });
});
