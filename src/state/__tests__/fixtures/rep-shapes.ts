// Rep fixtures shaped by ROM and peak concentric velocity — the two signals
// `rep-eligibility.ts` judges. Values are already in fitness units (metres,
// m/s), matching what the bridge hands workout-analytics post-VW-160.
//
// `POSITIONING_PULL` and `WORKING_REP` are the 2026-09-07 dogfood shape: the
// rope-positioning pull ran about a metre of cable at ~1.6 m/s against working
// reps of ~0.5 m at ~0.85 m/s.

import type { Rep } from '@voltras/workout-analytics';

export const POSITIONING_PULL = { romM: 1.0, peakMps: 1.6 };
export const WORKING_REP = { romM: 0.5, peakMps: 0.85 };

interface RepShape {
  romM: number;
  peakMps: number;
  /** Movement samples in the concentric; 1 marks an in-progress rep. */
  movementSamples?: number;
}

export function makeShapedRep(repNumber: number, shape: RepShape): Rep {
  const movementSampleCount = shape.movementSamples ?? 4;
  return {
    repNumber,
    concentric: makePhase(shape.romM, shape.peakMps, movementSampleCount, 1000),
    eccentric: makePhase(shape.romM, shape.peakMps * 0.6, movementSampleCount, 1400),
  };
}

/** A set of `count` working reps whose velocity decays gently, as a real set does. */
export function makeWorkingSet(count: number): Rep[] {
  return Array.from({ length: count }, (_, i) =>
    makeShapedRep(i + 1, {
      romM: WORKING_REP.romM,
      peakMps: WORKING_REP.peakMps - i * 0.05,
    }),
  );
}

function makePhase(
  romM: number,
  peakMps: number,
  movementSampleCount: number,
  startTime: number,
): Rep['concentric'] {
  const samples: Rep['concentric']['samples'] = Array.from(
    { length: movementSampleCount },
    (_, i) => ({
      sequence: i,
      timestamp: startTime + i * 50,
      phase: 1 as Rep['concentric']['samples'][number]['phase'],
      position: (romM * i) / Math.max(1, movementSampleCount - 1),
      velocity: peakMps,
      force: 50,
    }),
  );
  return {
    samples,
    startTime,
    endTime: startTime + movementSampleCount * 50,
    startPosition: 0,
    endPosition: romM,
    _totalVelocity: peakMps * movementSampleCount,
    _totalForce: 50 * movementSampleCount,
    _totalLoad: 0,
    _movementSampleCount: movementSampleCount,
    _totalHoldDuration: 0,
    _peakVelocityTime: startTime,
    _lastMovementVelocity: peakMps,
    peakVelocity: peakMps,
    peakForce: 50,
    peakLoad: 0,
  };
}
