// effortForSet (VW-543): the rep inputs the resolver is handed, the tier a read
// of a set with no pinned context, and the contract between the server's own
// curve read and the resolver's. Every value is synthetic.

import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import {
  rirForVelocity,
  RIR_VELOCITY_MODEL_VERSION,
  type RirModelVelocityMps,
  type RirVelocityModel,
} from '../rir-velocity.js';
import { effortForSet, effortRepInputs, type EffortSet } from '../effort-for-set.js';
import { buildEffortContext, profileToPin } from '../../state/effort-context.js';
import type { DeviceSnapshot } from '../../state/live-state.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

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

/** A rep whose mean concentric velocity reads back as exactly `mps`. */
function repAt(repNumber: number, mps: number): Rep {
  const concentric = {
    ...EMPTY_PHASE,
    _totalVelocity: mps,
    _movementSampleCount: 1,
    peakVelocity: mps,
  };
  return { repNumber, concentric, eccentric: EMPTY_PHASE } as Rep;
}

function closedSet(overrides: Partial<EffortSet> = {}): EffortSet {
  return { reps: [repAt(1, 0.5), repAt(2, 0.45), repAt(3, 0.4)], status: 'ended', ...overrides };
}

describe('the rep inputs', () => {
  it('hands the resolver ascending, unique reps, keeping the latest of a repeated number', () => {
    const set = closedSet({ reps: [repAt(3, 0.4), repAt(1, 0.5), repAt(2, 0.45), repAt(2, 0.44)] });

    const inputs = effortRepInputs(set, DEVICE);

    expect(inputs.map((rep) => rep.repNumber)).toEqual([1, 2, 3]);
    expect(inputs[1]?.meanVelocityMps).toBeCloseTo(0.44, 6);
  });

  it('leaves out the rep an active set is still performing', () => {
    const inputs = effortRepInputs(closedSet({ status: 'active' }), DEVICE);

    expect(inputs.map((rep) => rep.repNumber)).toEqual([1, 2]);
  });

  it('marks the eccentric-overload lead-in ineligible, as the gate does', () => {
    const inputs = effortRepInputs(closedSet(), { ...DEVICE, eccentricPercentTenths: 200 });

    expect(inputs.map((rep) => rep.eligible)).toEqual([false, false, true]);
  });

  it('suspends like-for-like from the first rep under changed settings', () => {
    const inputs = effortRepInputs(closedSet({ settingChangedAtRep: 2 }), DEVICE);

    expect(inputs.map((rep) => rep.sameSettingAsSetStart)).toEqual([true, false, false]);
  });
});

describe('effortForSet', () => {
  it('reads a set with no pinned context in tier a from its own watch percent', () => {
    const set = closedSet({
      watch: {
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25, thresholdSource: 'explicit' }],
      },
    });

    const effort = effortForSet(set, DEVICE);

    expect(effort.basis).toBe('velocity_loss_table');
    expect(effort.goal).toEqual({ kind: 'velocity_loss', lossPct: 25, source: 'explicit' });
    expect(effort.set.rpe).toBeNull();
    expect(effort.policyId).toBe('effort/v1');
  });

  // The library does not export its inverse read, so the two must be held together here.
  it("agrees with the server's own curve read on a rep's reps in reserve", () => {
    const model: RirVelocityModel = {
      form: 'linear',
      version: RIR_VELOCITY_MODEL_VERSION,
      resistanceFamily: 'constant',
      interceptMps: 0.2,
      slopeMpsPerRir: 0.05,
      r2: 0.9,
      seeMps: 0.05,
      rirErrorReps: 1,
      pointCount: 30,
      setCount: 6,
      sessionCount: 3,
      rirRange: [0, 6],
      intensityRange: [0.6, 0.85],
      anchorSources: { failure: 2, selfReport: 4 },
      observedFrom: '2026-09-10T12:00:00.000Z',
      observedTo: '2026-09-20T12:00:00.000Z',
      heldOutErrorReps: 1,
    };
    const profile = profileToPin(model, 'constant', new Date('2026-09-21T12:00:00.000Z'));
    if (typeof profile === 'string') throw new Error(`fixture curve withheld: ${profile}`);
    const context = buildEffortContext({
      set: {},
      device: DEVICE,
      planned: undefined,
      profile: { profile, relativeIntensity: 0.7 },
    });

    const effort = effortForSet(closedSet({ effortContext: context }), DEVICE);

    for (const rep of effort.reps) {
      const server = rirForVelocity(model, rep.velocityMps as RirModelVelocityMps);
      expect(rep.rir).toBeCloseTo(server.rir, 2);
    }
    expect(effort.basis).toBe('profile');
  });
});
