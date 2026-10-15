// Synthetic set events for the tone and proximity tests, built with the real payload builders.

import type { EffortMarker, EffortRep, Rep, SetEffort } from '@voltras/workout-analytics';

import {
  buildEffortTargetReachedPayload,
  buildRepFinalizedPayload,
  buildSetStartedPayload,
  buildVelocityLossExceededPayload,
} from '../../../state/channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from '../../../state/live-state.js';
import { NO_VELOCITY_LOSS_EXCLUSION } from '../../../state/rep-eligibility.js';
import type { ChannelEvent } from '../proximity.js';

export const SET_ID = 'set-tone';

const device: DeviceSnapshot = { connected: true, weightLbs: 60, trainingMode: 'WeightTraining' };

function makePhase(
  peakVelocity: number,
  startPosition: number,
  endPosition: number,
): Rep['concentric'] {
  const samples: Rep['concentric']['samples'] = [0, 1, 2, 3].map((i) => ({
    sequence: i,
    timestamp: 1000 + i * 50,
    phase: 1 as Rep['concentric']['samples'][number]['phase'],
    position: 0,
    velocity: 0,
    force: 0,
  }));
  return {
    samples,
    startTime: 1000,
    endTime: 1400,
    startPosition,
    endPosition,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: samples.length,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: 0,
    peakVelocity,
    peakForce: 0,
    peakLoad: 0,
  };
}

/** One rep with a concentric peak in m/s and a concentric range in metres. */
export function makeRep(repNumber: number, peakVelocity: number, rom = 0.5): Rep {
  return {
    repNumber,
    concentric: makePhase(peakVelocity, 0, rom),
    eccentric: makePhase(peakVelocity * 0.8, rom, 0),
  };
}

export function activeSet(reps: Rep[] = [], setId = SET_ID): ActiveSet {
  return {
    setId,
    sessionId: 'sess-tone',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps,
    status: 'active',
  };
}

/** `rep_finalized` events for each peak, numbered from `firstRepNumber`. */
export function repEvents(
  peaks: readonly number[],
  firstRepNumber = 1,
  setId = SET_ID,
): ChannelEvent[] {
  const reps = peaks.map((peak, i) => makeRep(firstRepNumber + i, peak));
  return reps.map((rep, i) =>
    buildRepFinalizedPayload(
      rep,
      firstRepNumber - 1 + i,
      activeSet(reps.slice(0, i + 1), setId),
      device,
      i + 2,
    ),
  );
}

export function setStartedEvent(): ChannelEvent {
  return buildSetStartedPayload(activeSet(), device, 1, null);
}

export function velocityLossEvent(thresholdPct: number, lossPct: number): ChannelEvent {
  return buildVelocityLossExceededPayload(
    activeSet(),
    device,
    { type: 'velocity_loss_exceeded', pct: thresholdPct },
    lossPct,
    1,
    1 - lossPct / 100,
    1,
    6,
    NO_VELOCITY_LOSS_EXCLUSION,
  );
}

export function effortTargetEvent(): ChannelEvent {
  const rep: EffortRep = {
    repNumber: 6,
    velocityMps: 0.4,
    lossPct: 20,
    rir: 2,
    rirRange: { low: 1, high: 3 },
    rpe: 8,
    band: 2,
    confidence: 'high',
    cueState: 'reached',
    cueFiredHere: true,
  };
  const marker: EffortMarker = {
    role: 'goal',
    condition: 'effort',
    axis: 'rep',
    repsLow: 6,
    repsHigh: 8,
    velocityMps: null,
    lossPct: null,
    targetRpe: 8,
    band: 2,
    source: 'plan',
    reached: true,
    reachedAtRep: 6,
  };
  const effort = { basis: 'profile', policyId: 'p', policyVersion: '1', goal: null } as SetEffort;
  return buildEffortTargetReachedPayload(activeSet(), effort, rep, marker);
}
