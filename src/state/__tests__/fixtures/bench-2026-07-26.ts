// Fixtures rebuilt from the 2026-07-26 bench session that surfaced the two
// rep-telemetry defects fixed in VMCP-05.13 / VMCP-05.14: cable-single-arm-row,
// 20 lb, left slot, 8 reps.
//
// Phases are built through workout-analytics' own `rebuildPhaseFromSamples`
// rather than hand-assembled literals, so the fixtures carry the same running
// aggregates production reps do. That matters: the peak-sign defect only
// reproduces when `peakVelocity` is the magnitude aggregate WA actually
// computes from signed samples, and the mid-set defect only reproduces when the
// in-flight rep has the exact shape WA leaves it in.

import type { Rep, WorkoutSample } from '@voltras/workout-analytics';
import { MovementPhase, rebuildPhaseFromSamples } from '@voltras/workout-analytics';

import type { ActiveSet, DeviceSnapshot } from '../../live-state.js';

export const benchDevice: DeviceSnapshot = {
  connected: true,
  weightLbs: 20,
  trainingMode: 'WeightTraining',
};

export const benchSet: ActiveSet = {
  setId: 'set-2f13336d',
  sessionId: 'sess-feaa4114',
  startedAt: '2026-07-26T00:00:00.000Z',
  reps: [],
  status: 'active',
};

/**
 * Build a phase from raw sample velocities (WA's native mm/s) via WA's own
 * accumulator. Velocities are passed SIGNED — the device decoder emits negative
 * values on the eccentric — because the sign carried on the samples is
 * precisely what the finalize-time peak recompute reads.
 */
export function phaseFromVelocities(
  velocities: readonly number[],
  opts: { startTime: number; startPosition: number; endPosition: number },
): Rep['concentric'] {
  const span = opts.endPosition - opts.startPosition;
  const samples: WorkoutSample[] = velocities.map((velocity, i) => ({
    sequence: i,
    timestamp: opts.startTime + i * 90,
    phase: MovementPhase.CONCENTRIC,
    position: opts.startPosition + (span * (i + 1)) / velocities.length,
    velocity,
    force: 200,
  }));
  return rebuildPhaseFromSamples(samples);
}

/**
 * Rep 1 of the captured set: a complete rep whose eccentric samples run
 * negative and peak at 1137 mm/s magnitude, decaying to 31.8 mm/s at the end of
 * movement — which is what yields the captured 97.2% eccentric velocity drop.
 */
export function capturedRep1(): Rep {
  return {
    repNumber: 1,
    concentric: phaseFromVelocities([900, 1620, 1400, 700], {
      startTime: 1000,
      startPosition: 0,
      endPosition: 600,
    }),
    eccentric: phaseFromVelocities([-500, -1137, -700, -31.8], {
      startTime: 1400,
      startPosition: 600,
      endPosition: 0,
    }),
  };
}

/**
 * Peak concentric velocities (mm/s) of reps 1-5 of the captured set — still
 * accelerating, which is what made the mid-set velocity-loss figure so wrong.
 */
export const ACCELERATING_PEAKS = [1620, 1800, 1950, 2000, 2071];

export function completedRep(repNumber: number, concPeak: number): Rep {
  return {
    repNumber,
    concentric: phaseFromVelocities([concPeak * 0.6, concPeak, concPeak * 0.7], {
      startTime: 1000 + repNumber * 2000,
      startPosition: 0,
      endPosition: 600,
    }),
    eccentric: phaseFromVelocities([-600, -900, -400], {
      startTime: 1400 + repNumber * 2000,
      startPosition: 600,
      endPosition: 0,
    }),
  };
}

/**
 * The in-flight rep as WA leaves it mid-set: `addSampleToSet` opens rep N+1 on
 * the eccentric→concentric edge, so it holds a single partial concentric sample
 * and an eccentric that never started. ROM is 0 and the velocity envelope is
 * all-zero because a one-sample phase has no curve.
 */
export function inFlightRep(repNumber: number): Rep {
  return {
    repNumber,
    concentric: phaseFromVelocities([821], {
      startTime: 20000,
      startPosition: 0,
      endPosition: 0,
    }),
    eccentric: rebuildPhaseFromSamples([]),
  };
}
