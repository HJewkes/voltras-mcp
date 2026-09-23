// What a calibrating goal says to the lifter (VW-444): one sentence for the
// page, one short line for titan's `calibratingNote`, both built only from the
// read model's structured calibration fields.

import { describe, expect, it } from 'vitest';

import {
  CHART_NOTE_MAX_CHARS,
  RECALIBRATION_OFFERED_LINE,
  calibrationCopy,
} from '../spa/goals/calibration-copy.js';
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
      chartNote: 'Needs a set near failure',
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
      chartNote: '2 sessions, more working sets',
    });
  });

  it('drops the starting-ramp claim when the accepted target was not derived cold', () => {
    const copy = calibrationCopy(calibration({ targetBasis: 'rp_ramp', targetInfoLevel: 'ramp' }));

    expect(copy.sentence).toBe('1 more comparable session to calibrate.');
  });
});

describe('the recalibration line (VW-444 part 2)', () => {
  it('says a target based on the lifts is ready, with no call to action', () => {
    expect(RECALIBRATION_OFFERED_LINE).toBe(
      'Calibrated. Your goal is still the starting ramp; a target based on your lifts is ready.',
    );
  });
});

describe('the in-plot chart note (fits one line at phone width)', () => {
  it.each<[string, Partial<GoalCalibrationView>, string]>([
    ['sessions', { sessionsNeeded: 1, blockedBy: 'sessions' }, '1 more comparable session'],
    [
      'a shape-only baseline',
      { sessionsNeeded: 0, blockedBy: 'baseline', baselineState: 'SHAPE_ONLY' },
      'Needs a set near failure',
    ],
    [
      'a cold baseline',
      { sessionsNeeded: 0, blockedBy: 'baseline', baselineState: 'COLD' },
      'Needs more working sets',
    ],
    [
      'both',
      { sessionsNeeded: 1, blockedBy: 'both', baselineState: 'COLD' },
      '1 session, more working sets',
    ],
  ])('names only the count or the blocker for %s', (_name, over, note) => {
    expect(calibrationCopy(calibration(over)).chartNote).toBe(note);
  });

  // Measured at 360 wide: the note's line runs from x=34 to x=204 (170 px), and these notes
  // average about 5.4 px a character, so 30 characters is about 162 px.
  it(`never runs past ${CHART_NOTE_MAX_CHARS} characters for any single-digit count`, () => {
    const blockers = ['sessions', 'baseline', 'both'] as const;
    const baselines = ['COLD', 'SHAPE_ONLY'] as const;
    for (let sessionsNeeded = 1; sessionsNeeded <= 9; sessionsNeeded++) {
      for (const blockedBy of blockers) {
        for (const baselineState of baselines) {
          const { chartNote } = calibrationCopy(
            calibration({ sessionsNeeded, blockedBy, baselineState }),
          );
          expect(chartNote.length, chartNote).toBeLessThanOrEqual(CHART_NOTE_MAX_CHARS);
        }
      }
    }
  });
});
