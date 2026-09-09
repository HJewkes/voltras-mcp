// VMCP-06.11 / B10 — bounce / dive-bomb turnaround-dwell detector.
//
// Synthetic phases only, built directly so each test controls hold duration
// and peak velocity independently of a real sample stream.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';
import { detectBounce } from '../rep-faults.js';

function makePhase(overrides: Partial<Phase>): Phase {
  return {
    samples: [],
    startTime: 0,
    endTime: 2000,
    startPosition: 0,
    endPosition: 1,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: 0,
    peakVelocity: 1,
    peakForce: 0,
    peakLoad: 0,
    ...overrides,
  };
}

function makeRep(concentric: Partial<Phase>, eccentric: Partial<Phase>): Rep {
  return {
    repNumber: 1,
    concentric: makePhase(concentric),
    eccentric: makePhase(eccentric),
  };
}

describe('detectBounce', () => {
  it('measures a controlled-tempo rep (1 s bottom pause) with no flags', () => {
    const rep = makeRep(
      { _totalHoldDuration: 0, peakVelocity: 1.0 },
      { _totalHoldDuration: 1000, peakVelocity: 0.8 },
    );

    const reading = detectBounce(rep);

    expect(reading.dwellLengthenedMs).toBeCloseTo(1000);
    expect(reading.dwellShortenedMs).toBeCloseTo(0);
    expect(reading.eccentricPeakOverConcentricPeak).toBeCloseTo(0.8);
    expect(reading.bounce).toBeNull();
    expect(reading.diveBomb).toBeNull();
  });

  it('reports a high ratio with zero bottom dwell for a zero-dwell fast turnaround', () => {
    const rep = makeRep(
      { _totalHoldDuration: 0, peakVelocity: 1.0 },
      { _totalHoldDuration: 0, peakVelocity: 2.5 },
    );

    const reading = detectBounce(rep);

    expect(reading.dwellLengthenedMs).toBe(0);
    expect(reading.eccentricPeakOverConcentricPeak).toBeCloseTo(2.5);
    expect(reading.bounce).toBeNull();
  });

  it('reports a ratio above 1 when the eccentric is faster than the concentric', () => {
    const rep = makeRep(
      { _totalHoldDuration: 500, peakVelocity: 1.0 },
      { _totalHoldDuration: 200, peakVelocity: 1.6 },
    );

    const reading = detectBounce(rep);

    expect(reading.eccentricPeakOverConcentricPeak).toBeGreaterThan(1);
    expect(reading.diveBomb).toBeNull();
  });

  it('reads dwell from the correct phase end — lengthened (eccentric) vs shortened (concentric)', () => {
    const rep = makeRep(
      { _totalHoldDuration: 300, peakVelocity: 1.0 }, // top dwell
      { _totalHoldDuration: 700, peakVelocity: 1.0 }, // bottom dwell
    );

    const reading = detectBounce(rep);

    expect(reading.dwellLengthenedMs).toBeCloseTo(700);
    expect(reading.dwellShortenedMs).toBeCloseTo(300);
    expect(reading.dwellLengthenedMs).not.toBeCloseTo(reading.dwellShortenedMs);
  });

  it('returns 0 for the ratio when the concentric phase never moved', () => {
    const rep = makeRep(
      { _totalHoldDuration: 0, peakVelocity: 0 },
      { _totalHoldDuration: 0, peakVelocity: 1.2 },
    );

    const reading = detectBounce(rep);

    expect(reading.eccentricPeakOverConcentricPeak).toBe(0);
  });
});
