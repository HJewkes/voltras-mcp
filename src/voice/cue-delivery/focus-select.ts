// Focus selection from one finished set's detector readings (VW-140 plan 3.4).
//
// ROM decay reads full_range, bounce reads control_lowering, hesitation reads smooth_drive.
// The detectors withhold bounce and hesitation verdicts, so the cuts that turn their raw
// readings into a fault live here, are injectable, and are engineering defaults.

import type { Rep } from '@voltras/workout-analytics';

import { detectBounce, detectHesitation } from '../../analytics/rep-faults.js';
import { readRomIntegrity } from '../../analytics/rom-integrity.js';
import { selectEligibleReps } from '../../state/rep-eligibility.js';
import { CUE_FOCUS_IDS, type CueFocusId } from './focus.js';

export interface FocusSelectMargins {
  /** A rep bounces when its eccentric peak over its concentric peak reaches this ratio. */
  bounceVelocityRatioMin: number;
  /** A rep bounces only when its bottom turnaround dwell is shorter than this. */
  bounceDwellMsMax: number;
  /** A rep hesitates when a mid-range concentric trough falls to this fraction of its peak. */
  hesitationTroughFractionMax: number;
  /** A per-rep fault reads for the set when at least this fraction of its reps show it. */
  setRepFractionMin: number;
}

/**
 * Engineering defaults, not cited figures: a bounce is a lowering at least half again as
 * fast as the lift with no pause at the bottom, a hesitation is a mid-rep dip below a third
 * of the rep's own peak, and a fault must show on half the set's reps to read.
 */
export const FOCUS_SELECT_MARGINS: FocusSelectMargins = {
  bounceVelocityRatioMin: 1.5,
  bounceDwellMsMax: 100,
  hesitationTroughFractionMax: 1 / 3,
  setRepFractionMin: 0.5,
};

/** Every focus the set's readings call a fault, in the fixed order of `CUE_FOCUS_IDS`. */
export function readSetFaults(
  reps: readonly Rep[],
  margins: FocusSelectMargins = FOCUS_SELECT_MARGINS,
): CueFocusId[] {
  if (reps.length < 2) return [];
  const eligible = selectEligibleReps(reps);
  const reads: Record<CueFocusId, boolean> = {
    full_range: readRomIntegrity(reps).decay.verdict === 'shrinking',
    control_lowering: readsOnSet(eligible, (rep) => bounces(rep, margins), margins),
    smooth_drive: readsOnSet(eligible, (rep) => hesitates(rep, margins), margins),
  };
  return CUE_FOCUS_IDS.filter((id) => reads[id]);
}

/** The one focus the next set of the exercise works on, or `null` when the set reads clean. */
export function selectFocus(
  reps: readonly Rep[],
  margins: FocusSelectMargins = FOCUS_SELECT_MARGINS,
): CueFocusId | null {
  return readSetFaults(reps, margins)[0] ?? null;
}

function readsOnSet(
  reps: readonly Rep[],
  isFault: (rep: Rep) => boolean,
  margins: FocusSelectMargins,
): boolean {
  if (reps.length < 2) return false;
  return reps.filter(isFault).length / reps.length >= margins.setRepFractionMin;
}

function bounces(rep: Rep, margins: FocusSelectMargins): boolean {
  const reading = detectBounce(rep);
  return (
    reading.eccentricPeakOverConcentricPeak >= margins.bounceVelocityRatioMin &&
    reading.dwellLengthenedMs < margins.bounceDwellMsMax
  );
}

function hesitates(rep: Rep, margins: FocusSelectMargins): boolean {
  return detectHesitation(rep).crossings.some(
    (crossing) => crossing.velocityFractionOfPeak <= margins.hesitationTroughFractionMax,
  );
}
