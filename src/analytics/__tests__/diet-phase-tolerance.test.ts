// VW-277: the two-axis adjustment table, on its own.
//
// The integration tests (plan-progression-tools, metrics-tools-history,
// metrics-tools) prove the three consumers wire it up; these prove the table
// itself, one case per phase plus the cells the RP notes actually name.

import { describe, expect, it } from 'vitest';

import {
  dietPhaseTolerance,
  toleranceEffect,
  weeksInPhaseAt,
  type DietPhaseState,
} from '../diet-phase-tolerance.js';

const MAINTENANCE: DietPhaseState = { phase: 'maintenance', weeksInPhase: 6 };
const UNKNOWN: DietPhaseState = { phase: 'unknown', weeksInPhase: null };
const CUT_WEEK_1: DietPhaseState = { phase: 'fat-loss', weeksInPhase: 1 };
const CUT_WEEK_6: DietPhaseState = { phase: 'fat-loss', weeksInPhase: 6 };
const CUT_WEEK_12: DietPhaseState = { phase: 'fat-loss', weeksInPhase: 12 };
const GAIN_WEEK_6: DietPhaseState = { phase: 'gain', weeksInPhase: 6 };

describe('diet-phase tolerance — one case per phase', () => {
  // The 7% dip is the fixture the whole feature turns on: the SAME performance
  // deviation, judged under each of the three phases.
  const DIP_PCT = -7;

  it('a fat-loss phase widens the tolerance until the same dip needs no response', () => {
    const verdict = dietPhaseTolerance(CUT_WEEK_6, DIP_PCT, 'flat');

    expect(verdict.band).toBe('small');
    expect(verdict.magnitude).toBe('none');
    expect(verdict.untoleratedMagnitude).toBe('moderate');
    expect(toleranceEffect(verdict)).toBe('softened');
    expect(verdict.context).toEqual({
      phase: 'fat-loss',
      weeksInPhase: 6,
      toleranceApplied: true,
    });
  });

  it('a gain phase leaves that same dip needing the moderate response', () => {
    const verdict = dietPhaseTolerance(GAIN_WEEK_6, DIP_PCT, 'flat');

    expect(verdict.band).toBe('moderate');
    expect(verdict.magnitude).toBe('moderate');
    expect(verdict.context.toleranceApplied).toBe(true);
  });

  it('a maintenance phase moves nothing at all', () => {
    const verdict = dietPhaseTolerance(MAINTENANCE, DIP_PCT, 'flat');

    expect(verdict.toleranceMultiplier).toBe(1);
    expect(verdict.magnitude).toBe('moderate');
    expect(toleranceEffect(verdict)).toBe('none');
    expect(verdict.context.toleranceApplied).toBe(false);
  });

  it('an undeclared phase answers exactly as maintenance does', () => {
    const declared = dietPhaseTolerance(MAINTENANCE, DIP_PCT, 'flat');
    const undeclared = dietPhaseTolerance(UNKNOWN, DIP_PCT, 'flat');

    expect(undeclared.magnitude).toBe(declared.magnitude);
    expect(undeclared.band).toBe(declared.band);
    expect(undeclared.toleranceMultiplier).toBe(declared.toleranceMultiplier);
    expect(undeclared.context).toEqual({
      phase: 'unknown',
      weeksInPhase: null,
      toleranceApplied: false,
    });
  });

  // A gain TIGHTENS, so there is a dip small enough that maintenance ignores it
  // and a gain does not. The 7% fixture above is too large to show this.
  it('a gain phase acts on a dip maintenance would call noise', () => {
    const small = -4.5;

    expect(dietPhaseTolerance(MAINTENANCE, small, 'flat').magnitude).toBe('none');
    const gain = dietPhaseTolerance(GAIN_WEEK_6, small, 'flat');
    expect(gain.magnitude).toBe('moderate');
    expect(toleranceEffect(gain)).toBe('hardened');
  });
});

describe('diet-phase tolerance — weeks in phase', () => {
  // rp-s12-two-week-cap-for-slow-signal-situations: the first couple of weeks
  // after a transition are the slow-signal window, so week 1 of a cut has not
  // yet earned the widening week 6 has.
  it('week 1 of a cut still calls for the response week 6 waives', () => {
    expect(dietPhaseTolerance(CUT_WEEK_1, -7, 'flat').magnitude).toBe('moderate');
    expect(dietPhaseTolerance(CUT_WEEK_6, -7, 'flat').magnitude).toBe('none');
  });

  it('a long cut widens further than a mid-length one', () => {
    expect(dietPhaseTolerance(CUT_WEEK_1, -7, 'flat').toleranceMultiplier).toBe(1.25);
    expect(dietPhaseTolerance(CUT_WEEK_6, -7, 'flat').toleranceMultiplier).toBe(1.75);
    expect(dietPhaseTolerance(CUT_WEEK_12, -7, 'flat').toleranceMultiplier).toBe(2.25);
  });

  it('a gain withholds its tightening inside the settling window', () => {
    const settling = dietPhaseTolerance({ phase: 'gain', weeksInPhase: 2 }, -4.5, 'flat');

    expect(settling.toleranceMultiplier).toBe(1);
    expect(settling.magnitude).toBe('none');
  });

  it('counts the first seven days as week 1 and clamps a future start', () => {
    expect(weeksInPhaseAt('2026-01-01T00:00:00.000Z', '2026-01-07T23:00:00.000Z')).toBe(1);
    expect(weeksInPhaseAt('2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z')).toBe(2);
    expect(weeksInPhaseAt('2026-02-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z')).toBe(1);
  });
});

describe('diet-phase tolerance — the trend-slope axis', () => {
  // rp-s12-trend-slope-overrides-raw-deviation: a trend already converging on
  // its own needs no help, however large this week's gap looks.
  it('waives the response entirely on a moderate deviation that is improving', () => {
    expect(dietPhaseTolerance(MAINTENANCE, -12, 'improving').magnitude).toBe('none');
    expect(dietPhaseTolerance(MAINTENANCE, -12, 'flat').magnitude).toBe('moderate');
  });

  // rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope's own diagonal:
  // large + diverging is the only cell that reaches the top band.
  it('reserves the largest response for a large deviation with a declining trend', () => {
    expect(dietPhaseTolerance(MAINTENANCE, -30, 'declining').magnitude).toBe('major');
    expect(dietPhaseTolerance(MAINTENANCE, -30, 'flat').magnitude).toBe('moderate');
    expect(dietPhaseTolerance(MAINTENANCE, -30, 'improving').magnitude).toBe('minor');
  });

  it('never advises anything on a small deviation that is flat or improving', () => {
    expect(dietPhaseTolerance(MAINTENANCE, -2, 'flat').magnitude).toBe('none');
    expect(dietPhaseTolerance(MAINTENANCE, -2, 'improving').magnitude).toBe('none');
    expect(dietPhaseTolerance(MAINTENANCE, -2, 'declining').magnitude).toBe('minor');
  });
});

describe('diet-phase tolerance — ahead of schedule', () => {
  it('runs the same table when the lifter is ahead, and offers three options', () => {
    const verdict = dietPhaseTolerance(MAINTENANCE, 25, 'flat');

    expect(verdict.direction).toBe('ahead');
    expect(verdict.band).toBe('large');
    expect(verdict.magnitude).toBe('moderate');
    expect(verdict.aheadOptions).toHaveLength(3);
  });

  it('offers the gain-phase wording in a gain phase', () => {
    const gain = dietPhaseTolerance(GAIN_WEEK_6, 25, 'flat');

    expect(gain.aheadOptions[0]).toContain('raise the end-of-block target');
    expect(dietPhaseTolerance(CUT_WEEK_6, 25, 'flat').aheadOptions[0]).toContain(
      'bank the extra progress',
    );
  });

  // rp-s12-ahead-of-schedule-*: the options exist to be presented, and a lifter
  // barely ahead of plan is not a decision — silence is right there.
  it('offers nothing when the lead is inside the tolerated band', () => {
    expect(dietPhaseTolerance(MAINTENANCE, 2, 'flat').aheadOptions).toEqual([]);
  });

  it('surfaces the ahead decision sooner in a gain than at maintenance', () => {
    const lead = 4.5;

    expect(dietPhaseTolerance(MAINTENANCE, lead, 'flat').aheadOptions).toEqual([]);
    expect(dietPhaseTolerance(GAIN_WEEK_6, lead, 'flat').aheadOptions).toHaveLength(3);
  });
});

describe('diet-phase tolerance — the rationale clause', () => {
  it('names the week, the phase and the direction it moved the line', () => {
    const { rationale } = dietPhaseTolerance(CUT_WEEK_6, -7, 'flat');

    expect(rationale).toContain('week 6 of a fat-loss phase');
    expect(rationale).toContain('widened');
    expect(rationale).toContain('1.75x');
  });

  it('says plainly when nothing was declared', () => {
    expect(dietPhaseTolerance(UNKNOWN, -7, 'flat').rationale).toContain('no diet phase declared');
  });

  it('says tightened for a gain', () => {
    expect(dietPhaseTolerance(GAIN_WEEK_6, -7, 'flat').rationale).toContain('tightened');
  });
});
