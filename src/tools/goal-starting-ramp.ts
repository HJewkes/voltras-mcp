// What `goal.propose_targets` and `goal.accept_target` tell the agent about a
// target derived before calibration (VW-444). Such a number is the generic
// programmed ramp, the same for any new lifter; the tools still propose and
// accept it unchanged, and the response says so in structured fields the agent
// reads instead of leaving it to be inferred from `infoLevel`.
//
// Confidentiality: coaching prose and fitness metadata only, no protocol data.

import {
  calibrationGapOf,
  isStartingRamp,
  type CalibrationGap,
  type GoalMetric,
} from '../analytics/goal-band.js';
import type { BaselineState } from '../store/types.js';

/** Attached to a cold lift target in both tools' responses. */
export interface StartingRampNotice {
  /** The coach re-proposes a data-based target once calibration ends; this one is never edited. */
  reProposeAfterCalibration: true;
  note: string;
}

/** The proposal's notice also carries what calibration is still waiting on. */
export interface ProposedStartingRamp extends StartingRampNotice, CalibrationGap {
  baselineState: BaselineState;
}

const RE_PROPOSE =
  'Once calibration ends, propose a data-based target and let the lifter choose whether to ' +
  'start a new chapter with it (goal.new_chapter, or goal.retire with an outcome). The accepted ' +
  'number is never changed in place.';

const STARTING_RAMP =
  'Starting ramp: this target is the generic programmed ramp, not yet based on the lifter’s ' +
  'own lifts.';

export function proposedStartingRamp(derived: {
  metric: GoalMetric;
  matchedSessionCount: number;
  baselineState: BaselineState;
  band: { infoLevel: 'cold' | 'ramp' | 'own' };
}): ProposedStartingRamp | undefined {
  if (!isStartingRamp(derived.metric, derived.band.infoLevel)) return undefined;
  const gap = calibrationGapOf(derived.matchedSessionCount, derived.baselineState);
  if (gap === null) return undefined;
  return {
    ...gap,
    baselineState: derived.baselineState,
    reProposeAfterCalibration: true,
    note: `${STARTING_RAMP} ${waitingOn(gap)} ${RE_PROPOSE}`,
  };
}

export function acceptedStartingRamp(target: {
  metric: GoalMetric;
  infoLevel: 'cold' | 'ramp' | 'own';
}): StartingRampNotice | undefined {
  if (!isStartingRamp(target.metric, target.infoLevel)) return undefined;
  return {
    reProposeAfterCalibration: true,
    note: `${STARTING_RAMP} Accepting it fixes this ramp as the goal. ${RE_PROPOSE}`,
  };
}

function waitingOn(gap: CalibrationGap): string {
  const sessions = `${gap.sessionsNeeded} more comparable session(s)`;
  const baseline = 'a rep baseline past its shape-only stage';
  if (gap.blockedBy === 'sessions') return `Calibration needs ${sessions}.`;
  if (gap.blockedBy === 'baseline') return `Calibration needs ${baseline}.`;
  return `Calibration needs ${sessions} and ${baseline}.`;
}
