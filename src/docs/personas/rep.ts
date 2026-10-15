// The one stored rep shape every seeded store writes: per-phase aggregates over a
// fixed range of motion and no sample arrays. No dashboard read model reads
// samples (only the live page does, and it reads the in-process state, not the
// store), so a seeded rep renders on every stored-data page without them.
//
// Confidentiality: velocities and durations only — derived fitness metadata.

import { EMPTY_PHASE } from '@voltras/workout-analytics';

import type { StoredRep, StoredRepPhaseVbt, StoredRepVbt } from '../../store/types.js';

const REP_DURATION_MS = 3_000;
const RANGE_OF_MOTION_M = 0.5;

/** Rep `index`, three seconds long, at `velocityMps` over a fixed range of motion. */
export function rep(setId: string, index: number, velocityMps: number): StoredRep {
  const startTime = index * REP_DURATION_MS;
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime,
      endTime: startTime + REP_DURATION_MS,
      startPosition: 0,
      endPosition: RANGE_OF_MOTION_M,
      _totalVelocity: velocityMps,
      _movementSampleCount: 1,
      _lastMovementVelocity: velocityMps,
      peakVelocity: velocityMps,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

/**
 * The derived VBT block a finalized rep carries, read off the same aggregates as
 * {@link rep}: one movement reading, so peak equals mean and nothing drops.
 */
export function derivedVbt(repNumber: number, velocityMps: number, loadLbs: number): StoredRepVbt {
  return {
    rep_number: repNumber,
    concentric: phaseVbt(velocityMps),
    eccentric: phaseVbt(0),
    rom_m: RANGE_OF_MOTION_M,
    impulse_lb_s: null,
    mean_power_lb_mps: Number((loadLbs * velocityMps).toFixed(3)),
    tempo_ratio: 0,
    hold_top_ms: 0,
  };
}

function phaseVbt(velocityMps: number): StoredRepPhaseVbt {
  return {
    peak_velocity: velocityMps,
    mean_velocity: velocityMps,
    time_to_peak_velocity_ms: velocityMps > 0 ? REP_DURATION_MS / 2 : 0,
    velocity_drop_pct: 0,
    velocity_envelope_mps: [velocityMps, velocityMps, velocityMps, velocityMps],
  };
}
