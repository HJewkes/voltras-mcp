/**
 * What a calibrating goal says to the lifter, built only from the read model's
 * structured `calibration` fields (VW-444) and never parsed out of `statusBasis`.
 *
 * Two strings, one source: `sentence` is the page's plain line, and `chartNote`
 * is the short first line titan's `GoalTrajectoryChart` takes as its
 * `calibratingNote` prop (titan #262), whose own lines below it already say
 * the band arrives with history. `chartNote` names the count or the blocker
 * only, never the joined clause, so it fits one line at phone width. A baseline blocker names what it waits on and
 * never a count, because the baseline has no count the view can promise.
 */
import type { GoalCalibrationView, GoalProgressView } from '../../read-models/index.js';

export interface CalibrationCopy {
  sentence: string;
  chartNote: string;
}

const STARTING_RAMP = 'Starting ramp, not yet based on your lifts.';

/** Longest in-plot note that fits one line of the phone chart (170 px of plot at 360 wide). */
export const CHART_NOTE_MAX_CHARS = 30;

export function calibrationCopy(calibration: GoalCalibrationView): CalibrationCopy {
  const wait = waitClause(calibration);
  const prefix = calibration.targetInfoLevel === 'cold' ? `${STARTING_RAMP} ` : '';
  return { sentence: `${prefix}${wait.sentence}`, chartNote: wait.chartNote };
}

function waitClause(calibration: GoalCalibrationView): CalibrationCopy {
  const needed = calibration.sessionsNeeded;
  const sessions = sessionCount(needed);
  const baseline = baselineNeed(calibration.baselineState);
  const shortBaseline = shortBaselineNeed(calibration.baselineState);
  switch (calibration.blockedBy) {
    case 'sessions':
      return { sentence: `${sessions} to calibrate.`, chartNote: sessions };
    case 'baseline':
      return { sentence: `Calibrates after ${baseline}.`, chartNote: `Needs ${shortBaseline}` };
    case 'both':
      return {
        sentence: `Calibrates after ${sessions} and ${baseline}.`,
        chartNote: `${needed} ${plural(needed, 'session')}, ${shortBaseline}`,
      };
  }
}

function sessionCount(needed: number): string {
  return `${needed} more comparable ${plural(needed, 'session')}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
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

/** The in-plot form: the chart's note must fit one line at phone width ({@link CHART_NOTE_MAX_CHARS}). */
function shortBaselineNeed(state: GoalCalibrationView['baselineState']): string {
  return state === 'COLD' ? 'more working sets' : 'a set near failure';
}
