/**
 * What a calibrating goal says to the lifter, built only from the read model's
 * structured `calibration` fields (VW-444) and never parsed out of `statusBasis`.
 *
 * Two strings, one source: `sentence` is the page's plain line, and `chartNote`
 * is the short first line titan's `GoalTrajectoryChart` takes as its
 * `calibratingNote` prop (titan #262), whose own lines below it already say
 * the band arrives with history. A baseline blocker names what it waits on and
 * never a count, because the baseline has no count the view can promise.
 */
import type { GoalCalibrationView } from '../../read-models/index.js';

export interface CalibrationCopy {
  sentence: string;
  chartNote: string;
}

const STARTING_RAMP = 'Starting ramp, not yet based on your lifts.';

export function calibrationCopy(calibration: GoalCalibrationView): CalibrationCopy {
  const wait = waitClause(calibration);
  const prefix = calibration.targetInfoLevel === 'cold' ? `${STARTING_RAMP} ` : '';
  return { sentence: `${prefix}${wait.sentence}`, chartNote: wait.chartNote };
}

function waitClause(calibration: GoalCalibrationView): CalibrationCopy {
  const sessions = sessionCount(calibration.sessionsNeeded);
  const baseline = baselineNeed(calibration.baselineState);
  switch (calibration.blockedBy) {
    case 'sessions':
      return { sentence: `${sessions} to calibrate.`, chartNote: sessions };
    case 'baseline':
      return { sentence: `Calibrates after ${baseline}.`, chartNote: `Needs ${baseline}` };
    case 'both':
      return {
        sentence: `Calibrates after ${sessions} and ${baseline}.`,
        chartNote: `${sessions} and ${baseline}`,
      };
  }
}

function sessionCount(needed: number): string {
  return `${needed} more comparable ${needed === 1 ? 'session' : 'sessions'}`;
}

/** COLD waits on enough working sets to read the lift's rep pattern; SHAPE_ONLY waits on a set near failure. */
function baselineNeed(state: GoalCalibrationView['baselineState']): string {
  return state === 'COLD' ? 'more working sets of this lift' : 'a set taken near failure';
}
