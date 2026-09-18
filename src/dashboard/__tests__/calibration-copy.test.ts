// What a calibrating goal says to the lifter (VW-444): one sentence for the
// page, one short line for titan's `calibratingNote`, both built only from the
// read model's structured calibration fields.

import { describe, expect, it } from 'vitest';

import { calibrationCopy } from '../spa/goals/calibration-copy.js';
import type { GoalCalibrationView } from '../read-models/index.js';

function calibration(over: Partial<GoalCalibrationView>): GoalCalibrationView {
  return {
    sessionsNeeded: 1,
    blockedBy: 'sessions',
    baselineState: 'PROVISIONAL',
    targetBasis: 'execution_ramp',
    targetInfoLevel: 'cold',
    ...over,
  };
}

describe('calibrationCopy', () => {
  it('states the starting ramp and the one comparable session still needed', () => {
    expect(calibrationCopy(calibration({}))).toEqual({
      sentence:
        'Starting ramp, not yet based on your lifts. 1 more comparable session to calibrate.',
      chartNote: '1 more comparable session',
    });
  });

  it('pluralises the session count', () => {
    const copy = calibrationCopy(calibration({ sessionsNeeded: 2 }));

    expect(copy.sentence).toContain('2 more comparable sessions to calibrate.');
  });

  it('names a set near failure, and no count, when a shape-only baseline blocks', () => {
    const copy = calibrationCopy(
      calibration({ sessionsNeeded: 0, blockedBy: 'baseline', baselineState: 'SHAPE_ONLY' }),
    );

    expect(copy).toEqual({
      sentence:
        'Starting ramp, not yet based on your lifts. Calibrates after a set taken near failure.',
      chartNote: 'Needs a set taken near failure',
    });
    expect(copy.sentence).not.toMatch(/\d/);
  });

  it('names more working sets when a cold baseline blocks', () => {
    const copy = calibrationCopy(
      calibration({ sessionsNeeded: 0, blockedBy: 'baseline', baselineState: 'COLD' }),
    );

    expect(copy.sentence).toBe(
      'Starting ramp, not yet based on your lifts. Calibrates after more working sets of this lift.',
    );
  });

  it('names both gates when the count and the baseline both block', () => {
    const copy = calibrationCopy(
      calibration({ sessionsNeeded: 2, blockedBy: 'both', baselineState: 'COLD' }),
    );

    expect(copy).toEqual({
      sentence:
        'Starting ramp, not yet based on your lifts. Calibrates after 2 more comparable sessions ' +
        'and more working sets of this lift.',
      chartNote: '2 more comparable sessions and more working sets of this lift',
    });
  });

  it('drops the starting-ramp claim when the accepted target was not derived cold', () => {
    const copy = calibrationCopy(calibration({ targetBasis: 'rp_ramp', targetInfoLevel: 'ramp' }));

    expect(copy.sentence).toBe('1 more comparable session to calibrate.');
  });
});
