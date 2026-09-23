// Measure where the effort resolver and the old velocity-loss gate disagree
// (VW-448 slice 6, VW-543).
//
// The old gate compares PEAK concentric velocity against the watch's percent;
// the resolver measures loss on MEAN concentric velocity from the fastest
// eligible rep, against its own goal or guard. Until #474 or slice 8 they will
// disagree. This logs each rep where they do, at debug level, so how often is a
// number rather than a guess. It changes nothing: no event, no state.

import type { SetEffort } from '@voltras/workout-analytics';

import { effortForSet } from '../analytics/effort-for-set.js';
import { log } from '../logger.js';
import type { ResolvedVelocityLossSpec } from '../schemas/set.js';
import { velocityLossBaseline } from './channel-payloads.js';
import type { ActiveSet, DeviceSnapshot } from './live-state.js';
import { velocityLossWatchSuppressed, velocityLossWindow } from './velocity-loss-gate.js';

/** Log the finalized rep when the two readings disagree. Never throws into the frame handler. */
export function logEffortGateDisagreement(
  set: ActiveSet,
  finalizedIndex: number,
  device: DeviceSnapshot,
): void {
  try {
    compareOnRep(set, finalizedIndex, device);
  } catch (err) {
    log.debug('effort: the disagreement check failed; nothing else is affected', err);
  }
}

function compareOnRep(set: ActiveSet, finalizedIndex: number, device: DeviceSnapshot): void {
  const spec = set.watch?.notifyOn.find(
    (s): s is ResolvedVelocityLossSpec => s.type === 'velocity_loss_exceeded',
  );
  if (spec === undefined || velocityLossWatchSuppressed(set)) return;
  const finalized = set.reps.slice(0, finalizedIndex + 1);
  const oldLossPct = oldGateLossPct(finalized, device);
  const effort = effortForSet({ ...set, reps: finalized, status: 'ended' }, device);
  const resolverLossPct = effort.reps.at(-1)?.lossPct ?? null;
  const oldGate = oldLossPct >= spec.pct;
  const resolver = resolverLossConditionTrue(effort, resolverLossPct);
  if (oldGate === resolver) return;
  log.debug('effort: the resolver and the old gate disagree on velocity loss', {
    repNumber: finalized.at(-1)?.repNumber,
    oldGate,
    oldLossPct,
    oldThresholdPct: spec.pct,
    resolver,
    resolverLossPct,
  });
}

/** The old gate's reading: peak loss from the eligible windowed baseline, 0 when undefined. */
function oldGateLossPct(finalized: ActiveSet['reps'], device: DeviceSnapshot): number {
  const baseline = velocityLossBaseline(velocityLossWindow(finalized, device).reps).velocity;
  const current = finalized.at(-1)?.concentric.peakVelocity ?? 0;
  return baseline <= 0 || current >= baseline ? 0 : (100 * (baseline - current)) / baseline;
}

/** Whether any velocity-loss marker, goal or guard, is met on this rep's loss. */
function resolverLossConditionTrue(effort: SetEffort, lossPct: number | null): boolean {
  if (lossPct === null) return false;
  const markers = [effort.markers.goal, ...effort.markers.guards];
  return markers.some(
    (m) => m?.condition === 'velocity_loss' && m.lossPct !== null && lossPct >= m.lossPct,
  );
}
