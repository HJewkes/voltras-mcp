// The weekly step a stall is judged against, and the flatline a stall reports (VW-452).
//
// The rate rule itself is workout-analytics `detectPlateau` in rate mode (VW-677):
// a run its window form calls a plateau is a stall only when its own fitted
// slope is under a quarter of the expected weekly step
// (rp:rp-s7-plateau-flatline-vs-slowdown-distinction). WA's series carry no
// units, so the step stays here: it is a load, read at the device's 1 lb step.

import type { RatePlateauDetection } from '@voltras/workout-analytics';

import { computePercentIncrement } from './percent-increment.js';

/**
 * The weekly step a stall is judged against, which is not the goal ramp's (VW-482).
 *
 * The floor and cap cite rp:rp-s5-load-increment-by-exercise-type. The 2.5% is an
 * ENGINEERING DEFAULT. This is the step VW-452 and VW-458 calibrated the stall rule
 * against. The goal ramp's smaller per-class steps sit inside the weekly noise at
 * light loads, and there `scripts/flatline-sim.mjs --ramp-class` calls a lifter who
 * is on pace stalled far more often.
 */
export const PLATEAU_REFERENCE_STEP = { percentOfLoad: 2.5, floorLbs: 2.5, capLbs: 10 } as const;

/** {@link PLATEAU_REFERENCE_STEP} at `loadLbs`, floored to the device's 1 lb step before the clamp. */
export function plateauReferenceStepLbs(loadLbs: number): number {
  const { percentOfLoad, floorLbs, capLbs } = PLATEAU_REFERENCE_STEP;
  return computePercentIncrement(loadLbs, percentOfLoad, floorLbs, capLbs);
}

/** The trailing run that is a flatline, with the evidence that made it one. */
export interface Flatline {
  days: number;
  points: number;
  slopeLbsPerWeek: number;
  flatBelowLbsPerWeek: number;
  reasoning: string;
}

/** The flat run a rate-mode `detectPlateau` found, or `null` when it found none. */
export function flatlineOf(found: RatePlateauDetection): Flatline | null {
  if (!found.isPlateau || found.slopePerWeek === null) return null;
  return {
    days: found.plateauDays,
    points: found.points,
    slopeLbsPerWeek: found.slopePerWeek,
    flatBelowLbsPerWeek: found.flatBelowPerWeek,
    reasoning: found.reasoning,
  };
}
