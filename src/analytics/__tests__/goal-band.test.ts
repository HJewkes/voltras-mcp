// Fixtures for the goal band (VW-348, plan G2'). Each block pins one of the
// human decisions of 2026-09-13, so a constant that moves in
// `GOAL_BAND_CONSTANTS` takes a named test with it rather than sliding through.

import { describe, expect, it } from 'vitest';

import {
  deriveGoalBand,
  GOAL_BAND_CONSTANTS,
  type GoalBandInput,
  type GoalBandWeek,
} from '../goal-band.js';

/** `count` weeks indexed from 1, with the 1-based indexes in `deloads` flagged. */
function weeksOf(count: number, deloads: readonly number[] = []): GoalBandWeek[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    isDeload: deloads.includes(i + 1),
  }));
}

/** A 200 lb row with enough history to earn the RP ramp, in no declared phase. */
function rowInput(overrides: Partial<GoalBandInput> = {}): GoalBandInput {
  return {
    metric: 'top_load_at_reps',
    startValue: 200,
    horizonWeeks: 6,
    weeks: weeksOf(6),
    tier: 'intermediate',
    infoLevel: 'ramp',
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    layoff: false,
    matchedSessionCount: 4,
    baselineState: 'PROVISIONAL',
    completedMesoCount: 0,
    ...overrides,
  };
}

describe('cold: execution ramp, no gain claim', () => {
  const band = deriveGoalBand(
    rowInput({ infoLevel: 'cold', matchedSessionCount: 0, baselineState: 'COLD' }),
  );

  it('reports the execution-ramp basis', () => {
    expect(band.basis).toBe('execution_ramp');
    expect(band.infoLevel).toBe('cold');
  });

  it('draws one line, not a band: there is nothing to stretch to', () => {
    expect(band.bandLowPctPerWeek).toBe(band.bandHighPctPerWeek);
    expect(band.committedValue).toBe(band.stretchValue);
  });

  it('says in words that this is not a gain claim', () => {
    expect(band.notes.join(' ')).toContain('no gain claim');
  });

  it('downgrades a requested gain band when the baseline is shape-only', () => {
    const asked = deriveGoalBand(
      rowInput({ infoLevel: 'ramp', matchedSessionCount: 1, baselineState: 'SHAPE_ONLY' }),
    );
    expect(asked.infoLevel).toBe('cold');
    expect(asked.notes.join(' ')).toContain('Calibrating');
  });
});

describe('ramp: a +5 lb/wk row over six weeks with a week-6 deload', () => {
  const band = deriveGoalBand(rowInput({ weeks: weeksOf(6, [6]) }));

  it('is the RP ramp, full weekly step on the high edge', () => {
    expect(band.basis).toBe('rp_ramp');
    expect(band.infoLevel).toBe('ramp');
    expect(band.bandHighPctPerWeek).toBe(2.5); // 5 lb on a 200 lb row
    expect(band.bandLowPctPerWeek).toBe(1.25); // every other week held
  });

  it('projects the exact weekly edges, with the deload week flat', () => {
    expect(band.expected).toEqual([
      { weekIndex: 1, low: 200, high: 200 },
      { weekIndex: 2, low: 202.5, high: 205 },
      { weekIndex: 3, low: 205, high: 210 },
      { weekIndex: 4, low: 207.5, high: 215 },
      { weekIndex: 5, low: 210, high: 220 },
      { weekIndex: 6, low: 210, high: 220 },
    ]);
  });

  it('commits to the low edge and shows the high edge as the stretch', () => {
    expect(band.committedValue).toBe(210);
    expect(band.stretchValue).toBe(220);
    expect(band.committedValue).toBe(band.expected[5].low);
    expect(band.stretchValue).toBe(band.expected[5].high);
  });

  it('holds the band across a mid-horizon deload and resumes after it', () => {
    const midDeload = deriveGoalBand(rowInput({ weeks: weeksOf(6, [3]) }));
    expect(midDeload.expected.map((week) => week.high)).toEqual([200, 205, 205, 210, 215, 220]);
  });
});

describe('ramp: the cited 2.5-10 lb bracket clamps the proportional step', () => {
  it('binds the cap on a heavy lift', () => {
    const band = deriveGoalBand(rowInput({ startValue: 500 }));
    expect(band.bandHighPctPerWeek).toBe(2); // 10 lb of 500
  });

  it('binds the floor on a light lift', () => {
    const band = deriveGoalBand(rowInput({ startValue: 60 }));
    expect(band.expected[1].high - band.expected[0].high).toBeCloseTo(2.5, 6);
  });
});

describe('own: a fitted slope needs high confidence and a completed meso', () => {
  const fitted = { pctPerWeek: 1.8, sePctPerWeek: 0.4, confidence: 'high' } as const;
  const ownInput = rowInput({
    infoLevel: 'own',
    matchedSessionCount: 8,
    baselineState: 'CALIBRATED',
    completedMesoCount: 1,
    ownSlope: fitted,
  });

  it('spans the slope plus or minus one standard error', () => {
    const band = deriveGoalBand(ownInput);
    expect(band.basis).toBe('own_slope');
    expect(band.bandLowPctPerWeek).toBe(1.4);
    expect(band.bandHighPctPerWeek).toBe(2.2);
  });

  it('falls back to the ramp without a high-confidence fit', () => {
    const band = deriveGoalBand({
      ...ownInput,
      ownSlope: { ...fitted, confidence: 'medium' },
    });
    expect(band.basis).toBe('rp_ramp');
    expect(band.infoLevel).toBe('ramp');
  });

  it('falls back to the ramp with no completed meso on record', () => {
    const band = deriveGoalBand({ ...ownInput, completedMesoCount: 0 });
    expect(band.basis).toBe('rp_ramp');
    expect(band.notes.join(' ')).toContain('No completed mesocycle');
  });

  it('falls back to the ramp on a first meso back after a layoff', () => {
    const band = deriveGoalBand({ ...ownInput, layoff: true });
    expect(band.basis).toBe('rp_ramp');
    expect(band.notes.join(' ')).toContain('regain slope');
  });
});

describe('layoff: the high edge is front-loaded for the first two ramping weeks', () => {
  const band = deriveGoalBand(rowInput({ layoff: true }));

  it('widens only the high edge, and only early', () => {
    expect(band.expected.map((week) => week.high)).toEqual([200, 207.5, 215, 220, 225, 230]);
    expect(band.expected.map((week) => week.low)).toEqual([200, 202.5, 205, 207.5, 210, 212.5]);
  });

  it('cites the deceleration the front-loading comes from', () => {
    expect(band.notes.join(' ')).toContain('rp-s7-early-strength-gains-not-pure-muscle-signal');
  });
});

describe('diet state: what a declared phase does to a lift band', () => {
  it('centres a fat-loss lift target on hold and widens it', () => {
    const band = deriveGoalBand(rowInput({ dietState: { phase: 'fat-loss', weeksInPhase: 4 } }));
    expect(band.direction).toBe('hold');
    expect(band.bandLowPctPerWeek).toBe(-1.09375); // half the ramp span, widened x1.75
    expect(band.bandHighPctPerWeek).toBe(1.09375);
    expect(band.expected[0]).toEqual({ weekIndex: 1, low: 200, high: 200 });
    expect(band.expected[5]).toEqual({ weekIndex: 6, low: 189.0625, high: 210.9375 });
  });

  it('leaves a beginner untouched in a deficit', () => {
    const band = deriveGoalBand(
      rowInput({ tier: 'beginner', dietState: { phase: 'fat-loss', weeksInPhase: 4 } }),
    );
    expect(band.bandLowPctPerWeek).toBe(1.25);
    expect(band.bandHighPctPerWeek).toBe(2.5);
    expect(band.notes.join(' ')).toContain('rp-s4-training-invariant-across-diet-phase');
  });

  it('tightens the band toward the full ramp in a gain phase', () => {
    const band = deriveGoalBand(rowInput({ dietState: { phase: 'gain', weeksInPhase: 5 } }));
    expect(band.bandHighPctPerWeek).toBe(2.5);
    expect(band.bandLowPctPerWeek).toBe(1.5625); // 1.25 span x0.75, off the high edge
  });

  it('is not provisional in a declared phase', () => {
    expect(deriveGoalBand(rowInput()).provisional).toBe(false);
  });
});

describe('recomposition: the committed edge is hold and the stretch is the ramp (VW-365)', () => {
  const recompInput = (overrides: Partial<GoalBandInput> = {}) =>
    rowInput({
      weeks: weeksOf(6, [6]),
      dietState: { phase: 'recomposition', weeksInPhase: 4 },
      ...overrides,
    });

  it('holds the low edge at the start value and ramps the high edge', () => {
    const band = deriveGoalBand(recompInput());
    expect(band.bandLowPctPerWeek).toBe(0);
    expect(band.bandHighPctPerWeek).toBe(2.5);
    expect(band.expected).toEqual([
      { weekIndex: 1, low: 200, high: 200 },
      { weekIndex: 2, low: 200, high: 205 },
      { weekIndex: 3, low: 200, high: 210 },
      { weekIndex: 4, low: 200, high: 215 },
      { weekIndex: 5, low: 200, high: 220 },
      { weekIndex: 6, low: 200, high: 220 },
    ]);
    expect(band.committedValue).toBe(200);
    expect(band.stretchValue).toBe(220);
    expect(band.direction).toBe('hold');
  });

  it('keeps the whole low edge on the start value, not on the ramp’s held-week edge', () => {
    const band = deriveGoalBand(recompInput());
    const maintenance = deriveGoalBand(rowInput({ weeks: weeksOf(6, [6]) }));
    expect(band.expected.every((week) => week.low === 200)).toBe(true);
    expect(band.expected.map((week) => week.high)).toEqual(
      maintenance.expected.map((week) => week.high),
    );
  });

  it('leaves a beginner on the full maintenance ramp, both edges', () => {
    const beginner = deriveGoalBand(recompInput({ tier: 'beginner' }));
    const maintenance = deriveGoalBand(rowInput({ tier: 'beginner', weeks: weeksOf(6, [6]) }));
    expect(beginner.expected).toEqual(maintenance.expected);
    expect(beginner.bandLowPctPerWeek).toBe(1.25);
    expect(beginner.bandHighPctPerWeek).toBe(2.5);
    expect(beginner.notes.join(' ')).toContain('rp-s4-training-invariant-across-diet-phase');
  });

  it('emits the specialization cap as an advisory note with its label and anchors', () => {
    const notes = deriveGoalBand(recompInput()).notes.join(' ');
    expect(notes).toContain(
      `capped at ${GOAL_BAND_CONSTANTS.recompositionSpecializationCap} muscle`,
    );
    expect(notes).toContain('ENGINEERING DEFAULT');
    expect(notes).toContain('rp-s5-fatloss-priority-training-rule');
    expect(notes).toContain('never a block');
  });

  it('does not cap a beginner, whose program does not change across phases', () => {
    expect(deriveGoalBand(recompInput({ tier: 'beginner' })).notes.join(' ')).not.toContain(
      'capped at',
    );
  });

  it('is a settled band, not a provisional one', () => {
    expect(deriveGoalBand(recompInput()).provisional).toBe(false);
    expect(deriveGoalBand(recompInput()).notes.join(' ')).not.toContain('VW-346');
  });
});

describe('recomposition bodyweight: hold by default, slow loss when declared (VW-365)', () => {
  const bodyweight = (slowLoss?: boolean) =>
    deriveGoalBand(
      rowInput({
        metric: 'bodyweight',
        startValue: 200,
        horizonWeeks: 4,
        weeks: weeksOf(4),
        dietState: { phase: 'recomposition', weeksInPhase: 4, slowLoss },
      }),
    );

  it('holds the maintenance corridor by default', () => {
    const band = bodyweight();
    expect(band.direction).toBe('hold');
    expect(band.corridorPct).toBe(GOAL_BAND_CONSTANTS.bodyweightMaintenanceBufferPct);
    expect(band.expected.every((week) => week.low === 196 && week.high === 204)).toBe(true);
    expect(band.notes.join(' ')).toContain('rp-s12-maintenance-buffer-2pct');
  });

  it('commits to holding weight and stretches to -0.5%/wk when the lifter declared slow loss (VW-468)', () => {
    const band = bodyweight(true);
    expect(band.direction).toBe('down');
    expect(band.bandLowPctPerWeek).toBe(0);
    expect(band.bandHighPctPerWeek).toBe(-0.5);
    expect(band.corridorPct).toBeNull();
    expect(band.expected).toEqual([
      { weekIndex: 1, low: 200, high: 200 },
      { weekIndex: 2, low: 200, high: 199 },
      { weekIndex: 3, low: 200, high: 198 },
      { weekIndex: 4, low: 200, high: 197 },
    ]);
    expect(band.committedValue).toBe(200);
    expect(band.stretchValue).toBe(197);
    expect(band.notes.join(' ')).toContain('rp-s11-fat-loss-rate-heuristic');
    expect(band.notes.join(' ')).toContain('VW-468');
  });

  it('stretches to the slow edge of the cited fat-loss range', () => {
    expect(bodyweight(true).bandHighPctPerWeek).toBe(
      GOAL_BAND_CONSTANTS.bodyweightFatLossPctPerWeek.low,
    );
  });

  it.each([
    [150, 144.75],
    [190, 183.35],
    [230, 221.95],
  ])('pins a %i lb lifter over 8 weeks: hold the start, stretch to %f', (start, stretch) => {
    const band = deriveGoalBand(
      rowInput({
        metric: 'bodyweight',
        startValue: start,
        horizonWeeks: 8,
        weeks: weeksOf(8),
        dietState: { phase: 'recomposition', weeksInPhase: 4, slowLoss: true },
      }),
    );
    expect(band.committedValue).toBe(start);
    expect(band.stretchValue).toBeCloseTo(stretch, 6);
    expect(band.expected.every((week) => week.low === start)).toBe(true);
  });
});

describe('bodyweight: the band is the declared phase’s own rate', () => {
  const bodyweight = (phase: 'fat-loss' | 'gain' | 'maintenance', startValue: number) =>
    deriveGoalBand(
      rowInput({
        metric: 'bodyweight',
        startValue,
        horizonWeeks: 4,
        weeks: weeksOf(4),
        dietState: { phase, weeksInPhase: 4 },
      }),
    );

  it('loses 0.5-1%/wk in a deficit, committed edge first', () => {
    const band = bodyweight('fat-loss', 200);
    expect(band.direction).toBe('down');
    expect(band.bandLowPctPerWeek).toBe(-0.5);
    expect(band.bandHighPctPerWeek).toBe(-1);
    expect(band.expected).toEqual([
      { weekIndex: 1, low: 200, high: 200 },
      { weekIndex: 2, low: 199, high: 198 },
      { weekIndex: 3, low: 198, high: 196 },
      { weekIndex: 4, low: 197, high: 194 },
    ]);
    expect(band.committedValue).toBe(197);
    expect(band.stretchValue).toBe(194);
  });

  it('gains 0.25-0.5%/wk in a surplus and flags a sub-noise-floor committed edge', () => {
    const band = bodyweight('gain', 160);
    expect(band.direction).toBe('up');
    expect(band.bandLowPctPerWeek).toBe(0.25);
    expect(band.bandHighPctPerWeek).toBe(0.5);
    expect(band.expected.map((week) => week.low)).toEqual([160, 160.4, 160.8, 161.2]);
    expect(band.expected.map((week) => week.high)).toEqual([160, 160.8, 161.6, 162.4]);
    expect(band.notes.join(' ')).toContain('noise floor');
  });

  it('is a flat +/-2% corridor in maintenance, not a rate', () => {
    const band = bodyweight('maintenance', 180);
    expect(band.direction).toBe('hold');
    expect(band.bandLowPctPerWeek).toBe(0);
    expect(band.bandHighPctPerWeek).toBe(0);
    expect(band.corridorPct).toBe(2);
    expect(band.expected.every((week) => week.low === 176.4 && week.high === 183.6)).toBe(true);
  });

  it('does not wait for training history the way a lift band does', () => {
    const band = deriveGoalBand(
      rowInput({
        metric: 'bodyweight',
        horizonWeeks: 4,
        weeks: weeksOf(4),
        infoLevel: 'cold',
        matchedSessionCount: 0,
        baselineState: 'COLD',
        dietState: { phase: 'fat-loss', weeksInPhase: 4 },
      }),
    );
    expect(band.basis).toBe('rp_ramp');
  });
});

describe('the other metrics', () => {
  it('steps a rep goal by the cited 1-2 reps per week', () => {
    const band = deriveGoalBand(
      rowInput({ metric: 'reps_at_load', startValue: 8, horizonWeeks: 4, weeks: weeksOf(4) }),
    );
    expect(band.expected.map((week) => week.low)).toEqual([8, 9, 10, 11]);
    expect(band.expected.map((week) => week.high)).toEqual([8, 10, 12, 14]);
  });

  it('holds a 28-day session count, which is a commitment and not a progression', () => {
    const band = deriveGoalBand(
      rowInput({ metric: 'sessions_28d', startValue: 12, horizonWeeks: 4, weeks: weeksOf(4) }),
    );
    expect(band.corridorPct).toBe(0);
    expect(band.expected.every((week) => week.low === 12 && week.high === 12)).toBe(true);
  });

  it('carries the e1RM standard error on an e1rm_trend band', () => {
    const band = deriveGoalBand(rowInput({ metric: 'e1rm_trend' }));
    expect(band.notes.join(' ')).toContain(`${GOAL_BAND_CONSTANTS.e1rmSeePct}%`);
  });
});

describe('input guards', () => {
  it('declines a horizon past the planning window in words, not by throwing', () => {
    const band = deriveGoalBand(rowInput({ horizonWeeks: 30, weeks: weeksOf(30) }));
    expect(band.notes.join(' ')).toContain('rp-s11-goal-horizon-3to6-months');
  });

  it('rejects a non-positive start value', () => {
    expect(() => deriveGoalBand(rowInput({ startValue: 0 }))).toThrow(/startValue/);
  });

  it('rejects a week list that does not match the horizon', () => {
    expect(() => deriveGoalBand(rowInput({ weeks: weeksOf(5) }))).toThrow(/6-week horizon/);
  });

  it('rejects an empty week list', () => {
    expect(() => deriveGoalBand(rowInput({ weeks: [], horizonWeeks: 0 }))).toThrow(
      /must not be empty/,
    );
  });
});

describe('determinism', () => {
  it('returns the same band for the same input', () => {
    expect(deriveGoalBand(rowInput())).toEqual(deriveGoalBand(rowInput()));
  });
});
