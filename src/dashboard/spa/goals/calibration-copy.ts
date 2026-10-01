/**
 * What a calibrating goal says to the lifter, built only from the read model's
 * structured `calibration` fields (VW-444) and never parsed out of `statusBasis`.
 *
 * Two strings, one source: `sentence` is the page's plain line, and `chartNote`
 * is what titan's `GoalTrajectoryChart` puts first in its calibrating info tip
 * (`calibratingNote`): the wait alone, since the tip's own lines already say the
 * line is the planned ramp. A baseline blocker names what it waits on and never
 * a count, because the baseline has no count the view can promise. The wording
 * and its source live in `coach-copy/dashboard.ts`.
 */
import { CALIBRATION_FRAGMENTS as LINES } from '../../../coach-copy/dashboard.js';
import { fillSlots } from '../../../coach-copy/fill.js';
import type { GoalCalibrationView, GoalProgressView } from '../../read-models/index.js';

export interface CalibrationCopy {
  sentence: string;
  chartNote: string;
}

export function calibrationCopy(calibration: GoalCalibrationView): CalibrationCopy {
  const wait = waitClause(calibration);
  const prefix = calibration.targetInfoLevel === 'cold' ? `${LINES.startingRamp.text} ` : '';
  return { sentence: `${prefix}${wait}`, chartNote: wait };
}

function waitClause(calibration: GoalCalibrationView): string {
  const sessions = sessionCount(calibration.sessionsNeeded);
  const baseline = baselineNeed(calibration.baselineState);
  switch (calibration.blockedBy) {
    case 'sessions':
      return fillSlots(LINES.waitSessions.text, { sessions });
    case 'baseline':
      return fillSlots(LINES.waitBaseline.text, { baseline });
    case 'both':
      return fillSlots(LINES.waitBoth.text, { sessions, baseline });
  }
}

function sessionCount(needed: number): string {
  const line = needed === 1 ? LINES.sessionCountOne : LINES.sessionCountMany;
  return fillSlots(line.text, { needed: String(needed) });
}

/** COLD waits on enough working sets to read the lift's rep pattern; SHAPE_ONLY waits on a set near failure. */
function baselineNeed(state: GoalCalibrationView['baselineState']): string {
  return state === 'COLD' ? LINES.baselineCold.text : LINES.baselineShapeOnly.text;
}

/**
 * An accepted starting ramp whose lift has calibrated since, while its offer
 * stands (VW-444 part 2). A declined offer gets no line: the decline is recorded
 * and suppresses the offer, and the card says nothing more (human, review round 2).
 */
export const RECALIBRATION_OFFERED_LINE = LINES.recalibrationOffered.text;

/** The one line a card carries about calibration, or `null` when it has nothing to say. */
export function calibrationLine(view: GoalProgressView): string | null {
  if (view.calibration !== undefined) return calibrationCopy(view.calibration).sentence;
  if (view.recalibration?.state === 'offered') return RECALIBRATION_OFFERED_LINE;
  return null;
}
