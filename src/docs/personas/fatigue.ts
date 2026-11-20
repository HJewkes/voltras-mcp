// The fatigue shape behind a persona's rep velocities, ported from the
// adaptive-rest simulation's lifter model (VW-516) because src never imports
// scripts. A test pins it to the sim's numbers for the same seed, so the two
// cannot drift apart unnoticed.
//
// The shape: a set costs fatigue in proportion to how close it went to failure,
// fatigue decays exponentially during rest, and within a set velocity falls in a
// straight line from the opening velocity to a fixed failure velocity. Fatigue
// lowers the opening velocity and the reps available, never the failure velocity.
// Each measured velocity carries multiplicative noise.

import { gaussian, type Rng } from './rng.js';

/** One synthetic lifter at one exercise and load. */
export interface LifterParams {
  /** Opening mean concentric velocity when completely fresh, m/s. */
  readonly v0: number;
  /** Mean concentric velocity of the last rep before failure, m/s. */
  readonly vFail: number;
  /** Reps to failure at this load when completely fresh. */
  readonly n0: number;
  /** Fatigue decay time constant, seconds. */
  readonly tauSec: number;
  /** Fatigue a single set taken all the way to failure adds. */
  readonly fatigueCost: number;
  /** Share of the available reps one unit of fatigue removes. */
  readonly repsPenalty: number;
  /** Share of the opening velocity one unit of fatigue removes. */
  readonly velocityPenalty: number;
  /** Between-rep multiplicative noise, as a coefficient of variation. */
  readonly cv: number;
}

export interface SimulatedSet {
  /** Measured mean concentric velocity of each rep, in order. */
  readonly velocities: readonly number[];
  readonly repsDone: number;
  /** How close the set went to failure, 0 to 1. */
  readonly proximity: number;
  /** Fatigue after the set, before any rest. */
  readonly fatigueAfter: number;
}

export interface SetProtocol {
  readonly targetReps?: number;
  /** Stop when a measured rep falls below this velocity. */
  readonly velocityCutoff?: number;
}

const MAX_REPS_PER_SET = 60;

export function repsAvailable(params: LifterParams, fatigue: number): number {
  return Math.max(1, params.n0 * (1 - params.repsPenalty * fatigue));
}

export function openingVelocity(params: LifterParams, fatigue: number): number {
  return params.v0 * (1 - params.velocityPenalty * fatigue);
}

/** Noiseless velocity of rep `repNumber`, falling straight to failure. */
export function trueRepVelocity(params: LifterParams, fatigue: number, repNumber: number): number {
  const available = repsAvailable(params, fatigue);
  const vOpen = openingVelocity(params, fatigue);
  const span = available <= 1 ? 1 : available - 1;
  const travelled = Math.min(1, (repNumber - 1) / span);
  return vOpen - (vOpen - params.vFail) * travelled;
}

export function afterRest(params: LifterParams, fatigue: number, restSec: number): number {
  return fatigue * Math.exp(-restSec / params.tauSec);
}

/** One set at `fatigue`: noise lands on what is measured, failure on the true state. */
export function performSet(
  params: LifterParams,
  fatigue: number,
  protocol: SetProtocol,
  rng: Rng,
): SimulatedSet {
  const available = repsAvailable(params, fatigue);
  const limit = Math.min(MAX_REPS_PER_SET, protocol.targetReps ?? MAX_REPS_PER_SET);
  const velocities: number[] = [];
  for (let rep = 1; rep <= limit; rep += 1) {
    if (rep > available) break;
    const measured = trueRepVelocity(params, fatigue, rep) * (1 + params.cv * gaussian(rng));
    velocities.push(Math.max(0.01, measured));
    if (protocol.velocityCutoff !== undefined && measured < protocol.velocityCutoff) break;
  }
  const proximity = Math.min(1, velocities.length / available);
  return {
    velocities,
    repsDone: velocities.length,
    proximity,
    fatigueAfter: Math.min(1, fatigue + params.fatigueCost * proximity),
  };
}
