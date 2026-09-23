// The effort cue (VW-448 slice 7, VW-544), behind VOLTRAS_EFFORT_CUE.
//
// After each finalized rep, the effort resolver decides whether the set's one
// ending cue fires on this rep. It publishes AT MOST ONE of three events per set:
// `set_target_reached` (the rep count), `velocity_loss_exceeded` (the loss) or
// `effort_target_reached` (the effort). The resolver owns the latch and the tie
// rules (the goal beats a guard, effort beats loss); this file only maps its answer
// onto an event. Every one of the three gains `goal_kind` and `cue_reason`.
//
// Advice only: nothing here ends, closes or writes a set. With the flag off the
// bridge runs the watch's own triggers exactly as before and this file is not
// reached.

import type { EffortMarker, EffortRep, SetEffort } from '@voltras/workout-analytics';

import { effortForSet, effortRepInputs } from '../analytics/effort-for-set.js';
import type { JsonObject } from '../store/types.js';
import {
  buildEffortTargetReachedPayload,
  buildSetTargetReachedPayload,
  buildVelocityLossExceededPayload,
} from './channel-payloads.js';
import type { ChannelPublisher } from './channel-publisher.js';
import type { ActiveSet, DeviceSnapshot, LiveState } from './live-state.js';
import { velocityLossWindow } from './velocity-loss-gate.js';

type Payload = { meta: Record<string, string>; content: string };

/** Publish the set's ending cue if the resolver fires it on the rep just finalized. */
export function evaluateEffortCue(
  live: LiveState,
  channels: ChannelPublisher,
  set: ActiveSet,
  finalizedIndex: number,
  device: DeviceSnapshot,
): void {
  const finalized = {
    ...set,
    reps: set.reps.slice(0, finalizedIndex + 1),
    status: 'ended' as const,
  };
  const effort = effortForSet(finalized, device);
  const rep = effort.reps.at(-1);
  const marker = firingMarker(effort);
  if (rep?.cueFiredHere !== true || marker === null) return;
  if (!live.latchEffortCue(rep.repNumber)) return;
  channels.publish(cuePayload(finalized, device, effort, rep, marker));
}

/** The goal or guard marker whose condition latched the cue. */
function firingMarker(effort: SetEffort): EffortMarker | null {
  const markers = [effort.markers.goal, ...effort.markers.guards];
  return markers.find((m) => m?.condition === effort.cue.reason && m.reached) ?? null;
}

function cuePayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  effort: SetEffort,
  rep: EffortRep,
  marker: EffortMarker,
): Payload {
  if (marker.condition === 'effort')
    return buildEffortTargetReachedPayload(set, effort, rep, marker);
  const payload =
    marker.condition === 'reps'
      ? buildSetTargetReachedPayload(set, device, marker.repsHigh ?? rep.repNumber, rep.repNumber)
      : lossPayload(set, device, rep, marker);
  return withCueMeta(payload, effort, marker);
}

/** `velocity_loss_exceeded` on the resolver's numbers: MEAN velocity, against the marker. */
function lossPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  rep: EffortRep,
  marker: EffortMarker,
): Payload {
  const baseline = fastestEligible(set, device);
  const spec = { type: 'velocity_loss_exceeded' as const, pct: marker.lossPct ?? 0 };
  const exclusion = velocityLossWindow(set.reps, device).exclusion;
  return buildVelocityLossExceededPayload(
    set,
    device,
    spec,
    rep.lossPct ?? 0,
    baseline.velocityMps,
    rep.velocityMps,
    baseline.repNumber,
    rep.repNumber,
    exclusion,
  );
}

/** The fastest eligible like-for-like rep: the loss baseline the resolver measured from. */
function fastestEligible(
  set: ActiveSet,
  device: DeviceSnapshot,
): { velocityMps: number; repNumber: number } {
  let best = { velocityMps: 0, repNumber: 0 };
  for (const input of effortRepInputs(set, device)) {
    if (input.eligible && input.sameSettingAsSetStart && input.meanVelocityMps > best.velocityMps) {
      best = { velocityMps: input.meanVelocityMps, repNumber: input.repNumber };
    }
  }
  return best;
}

/** The two keys every cue event carries, and the loss threshold's true source. */
function withCueMeta(payload: Payload, effort: SetEffort, marker: EffortMarker): Payload {
  return {
    ...payload,
    meta: {
      ...payload.meta,
      ...(marker.condition === 'velocity_loss' ? { threshold_source: marker.source } : {}),
      goal_kind: effort.goal?.kind ?? 'none',
      cue_reason: marker.condition,
    },
  };
}

/**
 * What the cue decided over the whole set, stored with it at set end. Carries the
 * policy's id and version so a later reader knows which table judged the set.
 */
export function cueRecordFor(set: ActiveSet, device: DeviceSnapshot): JsonObject {
  const effort = effortForSet({ ...set, status: 'ended' }, device);
  const { cue } = effort;
  return {
    policyId: effort.policyId,
    policyVersion: effort.policyVersion,
    basis: effort.basis,
    goalKind: effort.goal?.kind ?? null,
    reason: cue.reason,
    reachedAtRep: cue.reachedAtRep,
    repsPastCue: cue.repsPastCue,
    alsoTrue: cue.alsoTrue.map(({ reason, atRep }: { reason: string; atRep: number }) => ({
      reason,
      atRep,
    })),
    fallback: cue.fallback,
    degradedReason: effort.degradedReason,
    set: { rir: effort.set.rir, rpe: effort.set.rpe, band: effort.set.band },
  };
}
