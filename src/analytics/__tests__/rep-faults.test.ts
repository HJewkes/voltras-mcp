// VMCP-06.02 / B12 — mid-rep hesitation detector.
//
// Synthetic sample arrays only (per the ticket's own brief: capture-rate
// independence matters more here than realism), built directly from
// {position, velocity} points so each test controls exactly where a trough
// falls relative to the phase's own ROM.

import { describe, expect, it } from 'vitest';
import { MovementPhase } from '@voltras/workout-analytics';
import type { Phase, Rep, WorkoutSample } from '@voltras/workout-analytics';
import { detectHesitation, REP_FAULT_MARGINS } from '../rep-faults.js';

interface Point {
  position: number;
  velocity: number;
}

function makePhase(points: Point[], phaseKind: MovementPhase): Phase {
  const samples: WorkoutSample[] = points.map((p, i) => ({
    sequence: i,
    timestamp: i * 25,
    phase: phaseKind,
    position: p.position,
    velocity: p.velocity,
    force: 50,
  }));
  const velocities = points.map((p) => p.velocity);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    samples,
    startTime: 0,
    endTime: (points.length - 1) * 25,
    startPosition: first.position,
    endPosition: last.position,
    _totalVelocity: velocities.reduce((a, b) => a + b, 0),
    _totalForce: 50 * points.length,
    _totalLoad: 0,
    _movementSampleCount: points.length,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: last.velocity,
    peakVelocity: Math.max(...velocities),
    peakForce: 50,
    peakLoad: 0,
  };
}

function makeRep(concentric: Point[], eccentric: Point[]): Rep {
  return {
    repNumber: 1,
    concentric: makePhase(concentric, MovementPhase.CONCENTRIC),
    eccentric: makePhase(eccentric, MovementPhase.ECCENTRIC),
  };
}

/** A flat, uneventful eccentric — irrelevant to every test below except the last. */
const QUIET_ECCENTRIC: Point[] = [
  { position: 1, velocity: 0.5 },
  { position: 0.5, velocity: 0.4 },
  { position: 0, velocity: 0.1 },
];

describe('detectHesitation', () => {
  it('reports 0 crossings for a smooth bell-shaped concentric', () => {
    const rep = makeRep(
      [
        { position: 0, velocity: 0.1 },
        { position: 1 / 6, velocity: 0.4 },
        { position: 2 / 6, velocity: 0.7 },
        { position: 3 / 6, velocity: 1.0 },
        { position: 4 / 6, velocity: 0.7 },
        { position: 5 / 6, velocity: 0.4 },
        { position: 1, velocity: 0.1 },
      ],
      QUIET_ECCENTRIC,
    );

    const reading = detectHesitation(rep);

    expect(reading.crossings).toEqual([]);
    expect(reading.hesitated).toBeNull();
  });

  it('finds 1 crossing at ~0.5 ROM for a mid-ROM stall with recovery', () => {
    const rep = makeRep(
      [
        { position: 0, velocity: 0.1 },
        { position: 1 / 8, velocity: 0.4 },
        { position: 2 / 8, velocity: 0.7 },
        { position: 3 / 8, velocity: 0.9 },
        { position: 4 / 8, velocity: 0.2 }, // the stall
        { position: 5 / 8, velocity: 0.9 }, // the recovery
        { position: 6 / 8, velocity: 0.7 },
        { position: 7 / 8, velocity: 0.4 },
        { position: 1, velocity: 0.1 },
      ],
      QUIET_ECCENTRIC,
    );

    const reading = detectHesitation(rep);

    expect(reading.crossings).toHaveLength(1);
    expect(reading.crossings[0]!.atRomFraction).toBeCloseTo(0.5);
    expect(reading.crossings[0]!.velocityFractionOfPeak).toBeCloseTo(0.2 / 0.9);
    expect(reading.hesitated).toBeNull();
  });

  it('does not count a stall in the first 5% of ROM ("strictly inside")', () => {
    const rep = makeRep(
      [
        { position: 0, velocity: 0.1 },
        { position: 0.05, velocity: 0.02 }, // the stall — outside the 15% window
        { position: 0.1, velocity: 0.3 },
        { position: 0.5, velocity: 0.9 },
        { position: 1, velocity: 0.1 },
      ],
      QUIET_ECCENTRIC,
    );

    const reading = detectHesitation(rep);

    expect(reading.crossings).toEqual([]);
    expect(REP_FAULT_MARGINS.hesitation.romFractionMin).toBe(0.15);
  });

  it('does not count a pause in the eccentric phase (concentric only)', () => {
    const rep = makeRep(
      [
        { position: 0, velocity: 0.1 },
        { position: 0.5, velocity: 0.5 },
        { position: 1, velocity: 0.9 },
      ],
      [
        { position: 1, velocity: 0.8 },
        { position: 0.7, velocity: 0.1 }, // an obvious eccentric trough
        { position: 0.4, velocity: 0.8 },
        { position: 0, velocity: 0.2 },
      ],
    );

    const reading = detectHesitation(rep);

    expect(reading.crossings).toEqual([]);
  });
});
