/**
 * What a calibrating goal says to the lifter, built only from the read model's
 * structured `calibration` fields (VW-444) and never parsed out of `statusBasis`.
 *
 * Two strings, one source: `sentence` is the page's plain line, and `chartNote`
 * is what titan's `GoalTrajectoryChart` puts first in its calibrating info tip
 * (`calibratingNote`): the wait alone, since the tip's own lines already say the
 * line is the planned ramp. A baseline blocker names what it waits on and never
 * a count, because the baseline has no count the view can promise.
 */
import type { GoalCalibrationView, GoalProgressView } from '../../read-models/index.js';

export interface CalibrationCopy {
  sentence: string;
  chartNote: string;
}

const STARTING_RAMP = 'Starting ramp, not yet based on your lifts.';

export function calibrationCopy(calibration: GoalCalibrationView): CalibrationCopy {
  const wait = waitClause(calibration);
  const prefix = calibration.targetInfoLevel === 'cold' ? `${STARTING_RAMP} ` : '';
  return { sentence: `${prefix}${wait}`, chartNote: wait };
}

function waitClause(calibration: GoalCalibrationView): string {
  const sessions = sessionCount(calibration.sessionsNeeded);
  const baseline = baselineNeed(calibration.baselineState);
  switch (calibration.blockedBy) {
    case 'sessions':
      return `${sessions} to calibrate.`;
    case 'baseline':
      return `Calibrates after ${baseline}.`;
    case 'both':
      return `Calibrates after ${sessions} and ${baseline}.`;
  }
}

function sessionCount(needed: number): string {
  return `${needed} more comparable ${needed === 1 ? 'session' : 'sessions'}`;
}

/** COLD waits on enough working sets to read the lift's rep pattern; SHAPE_ONLY waits on a set near failure. */
function baselineNeed(state: GoalCalibrationView['baselineState']): string {
  return state === 'COLD' ? 'more working sets of this lift' : 'a set taken near failure';
}

/**
 * An accepted starting ramp whose lift has calibrated since, while its offer
 * stands (VW-444 part 2). A declined offer gets no line: the decline is recorded
 * and suppresses the offer, and the card says nothing more (human, review round 2).
 */
export const RECALIBRATION_OFFERED_LINE =
  'Calibrated. Your goal is still the starting ramp; a target based on your lifts is ready.';

/** The one line a card carries about calibration, or `null` when it has nothing to say. */
export function calibrationLine(view: GoalProgressView): string | null {
  if (view.calibration !== undefined) return calibrationCopy(view.calibration).sentence;
  if (view.recalibration?.state === 'offered') return RECALIBRATION_OFFERED_LINE;
  return null;
}
