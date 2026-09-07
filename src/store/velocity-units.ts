// Read-side normalisation for `StoredSet.velocityUnits` (VW-160).
//
// The store deliberately keeps rows in the scale they were captured at. Every
// row written before the bridge became the single mm/s→m/s conversion point
// holds device-native velocities, roughly 1000x the m/s `WorkoutSample.velocity`
// is documented as. Rescaling those numbers on disk would erase the evidence of
// which scale they came from, so the correction happens HERE, on read, for
// every consumer of an ABSOLUTE stored velocity.
//
// Ratio consumers (velocity loss %, `vbt.rir`, fatigue verdicts) were never
// wrong — a consistent scale error cancels — and calling this on their inputs
// changes nothing. They may still route through it so no call site has to
// reason about which of the two it is.

import type { Phase, WorkoutSample } from '@voltras/workout-analytics';
import type { StoredRep, StoredSet } from './types.js';

/** Device-native units per m/s. The device reports cable velocity in mm/s. */
const DEVICE_NATIVE_PER_MPS = 1000;

/**
 * Scale of `WorkoutSample.velocity` on newly-written sets.
 *
 * `'meters_per_second'` as of VW-160: `event-bridge.ts` converts
 * `frame.velocity` once when it builds each `WorkoutSample`, next to the
 * `mmToM` position conversion and the tenths→lb force conversion.
 */
export const CURRENT_VELOCITY_UNITS: NonNullable<StoredSet['velocityUnits']> = 'meters_per_second';

/**
 * Return `set` with every absolute velocity on its reps expressed in m/s.
 *
 * Returns the input UNCHANGED (same object identity) unless the set is
 * explicitly marked `'device_native'`. An absent marker reads as current: the
 * v10→v11 migration stamps every row that predates the bridge conversion, and
 * every write since carries `CURRENT_VELOCITY_UNITS`, so the only sets without
 * one are in-memory sets that never round-tripped through SQLite. Guessing
 * `'device_native'` there would divide a correct value by 1000.
 *
 * The per-phase private aggregates are rescaled alongside `peakVelocity`
 * rather than rebuilt from the samples, because a stored rep may legitimately
 * carry a phase summary with no sample stream (summary-only reps, a driver
 * that reports counts but not curves) and rebuilding would zero its peak.
 *
 * `derived` is deliberately untouched — that block was already m/s on every
 * row ever written. See {@link StoredRepPhaseVbt}.
 */
export function normaliseVelocityToMps(set: StoredSet): StoredSet {
  if (set.velocityUnits !== 'device_native') return set;
  return { ...set, velocityUnits: CURRENT_VELOCITY_UNITS, reps: set.reps.map(scaleRep) };
}

function scaleRep(rep: StoredRep): StoredRep {
  return {
    ...rep,
    concentric: scalePhase(rep.concentric),
    eccentric: scalePhase(rep.eccentric),
  };
}

function scalePhase(phase: Phase): Phase {
  return {
    ...phase,
    samples: phase.samples.map((s: WorkoutSample) => ({ ...s, velocity: toMps(s.velocity) })),
    _totalVelocity: toMps(phase._totalVelocity),
    _lastMovementVelocity: toMps(phase._lastMovementVelocity),
    peakVelocity: toMps(phase.peakVelocity),
  };
}

function toMps(deviceNative: number): number {
  return deviceNative / DEVICE_NATIVE_PER_MPS;
}
