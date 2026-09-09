// Tests for the read-side position normaliser (VW-203).
//
// The load-bearing property is that a device-native row and a metres row of the
// same movement produce the SAME absolute ROM after normalisation — that is
// what makes every cross-set ROM comparison downstream sound. The second is
// that a row already in metres comes back untouched, because rescaling it would
// be the same 1000x error in the other direction.

import { describe, expect, it } from 'vitest';
import { getRepRangeOfMotion, type Phase } from '@voltras/workout-analytics';

import { normalisePositionsToMetres } from '../position-units.js';
import type { StoredRep, StoredSet } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** A rep whose concentric travels `travel` in whatever scale the set declares. */
function makeRep(travel: number): StoredRep {
  return {
    repNumber: 1,
    concentric: {
      ...EMPTY_PHASE,
      endTime: 1500,
      endPosition: travel,
      _movementSampleCount: 4,
      samples: [
        { sequence: 0, timestamp: 0, phase: 1, position: 0, velocity: 0.8, force: 50 },
        { sequence: 1, timestamp: 25, phase: 1, position: travel, velocity: 0.8, force: 50 },
      ] as Phase['samples'],
    },
    eccentric: { ...EMPTY_PHASE, startTime: 1500, endTime: 3000, startPosition: travel },
    id: 'r0',
    setId: 's',
    index: 0,
  };
}

function makeSet(travel: number, positionUnits?: StoredSet['positionUnits']): StoredSet {
  return {
    id: 's',
    sessionId: 'sess',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:30.000Z',
    partial: false,
    reps: [makeRep(travel)],
    ...(positionUnits !== undefined ? { positionUnits } : {}),
  };
}

describe('normalisePositionsToMetres', () => {
  it('reads a device-native set and a metres set of the same movement as the same ROM', () => {
    const deviceNative = normalisePositionsToMetres(makeSet(600, 'device_native'));
    const metres = normalisePositionsToMetres(makeSet(0.6, 'meters'));

    expect(getRepRangeOfMotion(deviceNative.reps[0])).toBeCloseTo(
      getRepRangeOfMotion(metres.reps[0]),
      5,
    );
    expect(getRepRangeOfMotion(deviceNative.reps[0])).toBeCloseTo(0.6, 5);
  });

  it('scales the sample stream alongside the phase endpoints', () => {
    const normalised = normalisePositionsToMetres(makeSet(600, 'device_native'));

    expect(normalised.reps[0].concentric.samples.map((s) => s.position)).toEqual([0, 0.6]);
    expect(normalised.reps[0].eccentric.startPosition).toBeCloseTo(0.6, 5);
  });

  it('restates the marker so a normalised set cannot be scaled a second time', () => {
    const once = normalisePositionsToMetres(makeSet(600, 'device_native'));
    const twice = normalisePositionsToMetres(once);

    expect(once.positionUnits).toBe('meters');
    expect(twice).toBe(once);
  });

  it('returns a metres set unchanged, by identity', () => {
    const set = makeSet(0.6, 'meters');

    expect(normalisePositionsToMetres(set)).toBe(set);
  });

  it('treats an absent marker as the store default rather than as device-native', () => {
    const set = makeSet(0.6);

    expect(normalisePositionsToMetres(set)).toBe(set);
  });

  it('scales the derived per-rep ROM, which predates the bridge conversion', () => {
    const set = makeSet(600, 'device_native');
    set.reps[0].derived = {
      rep_number: 1,
      concentric: emptyPhaseVbt(),
      eccentric: emptyPhaseVbt(),
      rom_m: 600,
      impulse_lb_s: null,
      mean_power_lb_mps: null,
      tempo_ratio: 1,
      hold_top_ms: 0,
    };

    expect(normalisePositionsToMetres(set).reps[0].derived?.rom_m).toBeCloseTo(0.6, 5);
  });
});

function emptyPhaseVbt(): NonNullable<StoredRep['derived']>['concentric'] {
  return {
    peak_velocity: 0,
    mean_velocity: 0,
    time_to_peak_velocity_ms: 0,
    velocity_drop_pct: 0,
    velocity_envelope_mps: [0, 0, 0, 0],
  };
}
