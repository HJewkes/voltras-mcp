// Synthetic set events for the delivery emitter tests, built with the real payload builders.

import type { Rep } from '@voltras/workout-analytics';

import {
  buildSetEndedPayload,
  buildSetStartedPayload,
  buildSetTargetReachedPayload,
  buildVelocityLossExceededPayload,
} from '../../../state/channel-payloads.js';
import type { ChannelEvent } from '../../../state/channel-publisher.js';
import type { DeviceSnapshot } from '../../../state/live-state.js';
import { NO_VELOCITY_LOSS_EXCLUSION } from '../../../state/rep-eligibility.js';
import type { StoredSet } from '../../../store/types.js';
import { activeSet, makeRep, repEvents } from './proximity-fixtures.js';

const device: DeviceSnapshot = { connected: true, weightLbs: 60, trainingMode: 'WeightTraining' };

/** A set whose range shrinks rep over rep, so its debrief picks full_range. */
export const SHRINKING_RANGE_REPS: Rep[] = [0.5, 0.48, 0.45, 0.42, 0.38].map((rom, i) =>
  makeRep(i + 1, 0.8, rom),
);

/** A set that holds its range, so it reads clean for every focus. */
export const STEADY_REPS: Rep[] = [1, 2, 3, 4, 5].map((n) => makeRep(n, 0.8, 0.5));

export function started(setId: string): ChannelEvent {
  return buildSetStartedPayload(activeSet([], setId), device, 1, null);
}

/** `rep_finalized` events at a steady speed, so the stream alone never reads near failure. */
export function reps(setId: string, count: number, firstRepNumber = 1): ChannelEvent[] {
  return repEvents(Array<number>(count).fill(0.8), firstRepNumber, setId);
}

export function slowdown(setId: string, atRep: number): ChannelEvent {
  return buildVelocityLossExceededPayload(
    activeSet([], setId),
    device,
    { type: 'velocity_loss_exceeded', pct: 20 },
    30,
    1,
    0.7,
    1,
    atRep,
    NO_VELOCITY_LOSS_EXCLUSION,
  );
}

export function targetReached(setId: string, atRep: number): ChannelEvent {
  return buildSetTargetReachedPayload(activeSet([], setId), device, atRep, atRep);
}

export function ended(setId: string, setReps: readonly Rep[]): ChannelEvent {
  const stored: StoredSet = {
    id: setId,
    sessionId: 'sess-tone',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 60,
    reps: setReps.map((rep, i) => ({ ...rep, id: `${setId}-r${i}`, setId, index: i })),
  };
  return buildSetEndedPayload(stored);
}
