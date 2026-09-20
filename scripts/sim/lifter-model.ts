// The simulated lifter behind the adaptive-rest simulation (VW-516, design s.10.2).
//
// The smallest model that can be fitted to the published rest literature:
//
//   1. A set at a fixed load costs fatigue in proportion to how close it went
//      to failure.
//   2. Fatigue decays during rest with one time constant per lifter.
//   3. Rep velocity falls along a straight line from the opening velocity to
//      the failure velocity, and fatigue lowers both the opening velocity and
//      the reps available. The FAILURE velocity does not move: the minimum
//      velocity threshold at a given exercise is the one quantity the velocity
//      literature reports as stable within a lifter.
//   4. Each measured rep velocity carries multiplicative noise.
//
// The model is INFERENCE. It is worth exactly as much as its fit to the three
// baselines in `stage1-baselines.ts`, and stage 2 means nothing until that fit
// passes. Nothing in this file is production code; nothing imports it from
// `src/`.

/** One simulated lifter at one exercise and load. */
export interface LifterParams {
  /** Opening mean concentric velocity when completely fresh, m/s. */
  readonly v0: number;
  /** Mean concentric velocity of the last rep before failure, m/s. */
  readonly vFail: number;
  /** Reps to failure at this load when completely fresh. */
  readonly n0: number;
  /** Fatigue decay time constant, seconds. The one parameter a population varies. */
  readonly tauSec: number;
  /** Fatigue a single set taken all the way to failure adds. */
  readonly fatigueCost: number;
  /** Share of the available reps one unit of fatigue removes. */
  readonly repsPenalty: number;
  /** Share of the opening velocity one unit of fatigue removes. */
  readonly velocityPenalty: number;
  /** Between-rep multiplicative measurement noise, as a coefficient of variation. */
  readonly cv: number;
}

/** What one simulated set produced. */
export interface SimulatedSet {
  /** Measured mean concentric velocity of each rep, in order. */
  readonly velocities: readonly number[];
  readonly repsDone: number;
  /** How close the set went to failure, 0 to 1. */
  readonly proximity: number;
  /** Fatigue after the set, before any rest. */
  readonly fatigueAfter: number;
}

/** How a set is terminated. */
export interface SetProtocol {
  /** Stop at this many reps, whatever the velocity. */
  readonly targetReps?: number;
  /** Stop when a MEASURED rep falls below this velocity, as a device would. */
  readonly velocityCutoff?: number;
  /** Stop only at failure. */
  readonly toFailure?: boolean;
}

/** A seeded uniform generator (mulberry32), so every run of the simulation is reproducible. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw, Box-Muller, from a seeded uniform. */
export function gaussian(rng: () => number): number {
  const u = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Reps this lifter could complete at this fatigue before failing. */
export function repsAvailable(params: LifterParams, fatigue: number): number {
  return Math.max(1, params.n0 * (1 - params.repsPenalty * fatigue));
}

/** Opening velocity at this fatigue. */
export function openingVelocity(params: LifterParams, fatigue: number): number {
  return params.v0 * (1 - params.velocityPenalty * fatigue);
}

/** True (noiseless) velocity of rep `repNumber`, falling straight to failure. */
export function trueRepVelocity(params: LifterParams, fatigue: number, repNumber: number): number {
  const available = repsAvailable(params, fatigue);
  const vOpen = openingVelocity(params, fatigue);
  const span = available <= 1 ? 1 : available - 1;
  const travelled = Math.min(1, (repNumber - 1) / span);
  return vOpen - (vOpen - params.vFail) * travelled;
}

/** Fatigue left after resting `restSec`. */
export function afterRest(params: LifterParams, fatigue: number, restSec: number): number {
  return fatigue * Math.exp(-restSec / params.tauSec);
}

const MAX_REPS_PER_SET = 60;

/**
 * Perform one set at `fatigue` under `protocol`. Noise is applied to what the
 * DEVICE reads, so a velocity cut-off fires on the measured number the way it
 * does on the wall, while failure is decided by the true state.
 */
export function performSet(
  params: LifterParams,
  fatigue: number,
  protocol: SetProtocol,
  rng: () => number,
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

/** Whether the lifter completed the reps asked of them. */
export function completedTarget(set: SimulatedSet, targetReps: number): boolean {
  return set.repsDone >= targetReps;
}

/** The mean of a sample. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The sample standard deviation. */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Relative error of `observed` against `expected`, as a fraction. */
export function relativeError(observed: number, expected: number): number {
  return Math.abs(observed - expected) / Math.abs(expected);
}
