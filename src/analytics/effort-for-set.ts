// One set's effort, read through the library resolver (VW-448 slice 6, VW-543).
//
// Maps the context pinned at set start and the set's finalized reps onto
// `resolveSetEffort`. The reps carry MEAN concentric velocity, and their
// eligibility comes from the same two rules the velocity-loss gate reads: the
// eccentric-overload lead-in window, then `selectEligibleReps`.
//
// A set with no pinned context of its own (recorded before the pin existed, or
// whose pin failed) is read in tier a from its own watch: no profile, and the
// watch's loss percent as its reference.
//
// PURE. Nothing here touches the store, the clock or the device.

import {
  EFFORT_POLICY,
  resolveSetEffort,
  type EffortRepInput,
  type EffortSetContext,
  type Rep,
  type SetEffort,
} from '@voltras/workout-analytics';

import { buildEffortContext, type PinnedEffortContext } from '../state/effort-context.js';
import type { ActiveSet, DeviceSnapshot } from '../state/live-state.js';
import { selectEligibleReps } from '../state/rep-eligibility.js';
import { velocityLossWindow } from '../state/velocity-loss-gate.js';
import { rirModelVelocity } from './rir-velocity.js';

/** The parts of a live or just-closed set the resolver reads. */
export type EffortSet = Pick<
  ActiveSet,
  'reps' | 'status' | 'watch' | 'movementClass' | 'effortContext' | 'settingChangedAtRep'
>;

/** Resolve one set's effort against its pinned context and its finalized reps. */
export function effortForSet(set: EffortSet, device: DeviceSnapshot): SetEffort {
  return resolveSetEffort(
    effortContextFor(set, device),
    effortRepInputs(set, device),
    EFFORT_POLICY,
  );
}

/**
 * The set's pinned context, or a tier a context built from its own watch. The return type
 * is the compile-time proof that the local pinned shape is the library's context.
 */
export function effortContextFor(set: EffortSet, device: DeviceSnapshot): EffortSetContext {
  const pinned = set.effortContext as PinnedEffortContext | undefined;
  return pinned ?? buildEffortContext({ set, device, planned: undefined, profile: 'not_pinned' });
}

/**
 * The resolver's rep inputs, in ascending, unique rep order: the resolver folds in
 * array order and neither sorts nor de-duplicates. An active set's last rep is still
 * in progress, so it is left out until the next rep closes it.
 */
export function effortRepInputs(set: EffortSet, device: DeviceSnapshot): EffortRepInput[] {
  const reps = ascendingUnique(set.status === 'active' ? set.reps.slice(0, -1) : set.reps);
  const eligible = new Set(selectEligibleReps(velocityLossWindow(reps, device).reps));
  return reps.map((rep) => ({
    repNumber: rep.repNumber,
    meanVelocityMps: rirModelVelocity(rep),
    eligible: eligible.has(rep),
    sameSettingAsSetStart:
      set.settingChangedAtRep === undefined || rep.repNumber < set.settingChangedAtRep,
  }));
}

/** Ascending by rep number; a repeated number keeps its latest rep. */
function ascendingUnique(reps: readonly Rep[]): Rep[] {
  const byNumber = new Map<number, Rep>();
  for (const rep of reps) byNumber.set(rep.repNumber, rep);
  return [...byNumber.values()].sort((a, b) => a.repNumber - b.repNumber);
}
