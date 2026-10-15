// Tone register gate for the cue-delivery layer (VW-140 plan 3.5).
//
// The register turns directive on measured decay or proximity to failure, never on a rep
// number: the reading carries none. A null or low-confidence input never escalates.

import type { CueState } from '@voltras/workout-analytics';

import type { CueRegister } from './focus-phrases.js';
import type { ProximityReading } from './proximity.js';

/**
 * Engineering default, not a cited figure: two thirds of the set's own velocity-loss
 * threshold, so the short form starts a little before the watch would end the set.
 */
export const DIRECTIVE_LOSS_FRACTION = 2 / 3;

const NEAR_FAILURE_STATES: ReadonlySet<CueState> = new Set(['approaching', 'reached', 'past']);

export type DirectiveReason = 'effort_near_target' | 'velocity_loss' | 'ending_event' | 'rom_decay';

/** The first rule that turns the register directive, or `null` when it stays affirming. */
export function directiveReason(reading: ProximityReading | null): DirectiveReason | null {
  if (reading === null) return null;
  if (reading.endingEvent !== null) return 'ending_event';
  if (reading.confidence === 'high' && isNearFailure(reading.cueState)) {
    return 'effort_near_target';
  }
  if (isLossNearThreshold(reading.lossPct, reading.lossThresholdPct)) return 'velocity_loss';
  if (reading.romDecayVerdict === 'shrinking') return 'rom_decay';
  return null;
}

export function registerFor(reading: ProximityReading | null): CueRegister {
  return directiveReason(reading) === null ? 'affirming' : 'directive';
}

function isNearFailure(cueState: CueState | null): boolean {
  return cueState !== null && NEAR_FAILURE_STATES.has(cueState);
}

function isLossNearThreshold(lossPct: number | null, thresholdPct: number | null): boolean {
  if (lossPct === null || thresholdPct === null || thresholdPct <= 0) return false;
  return lossPct >= thresholdPct * DIRECTIVE_LOSS_FRACTION;
}
