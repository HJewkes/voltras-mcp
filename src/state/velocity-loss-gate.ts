// Movement-class gate on the `velocity_loss_exceeded` watch (VMCP-02.63).
//
// One predicate, read by the bridge before it evaluates a `velocity_loss_exceeded`
// spec, and by the set-start paths that announce the suppression. It introduces
// NO numeric threshold: the spec's own `pct` still decides when the trigger
// fires, and the gate only decides whether the trigger is evaluated at all.

import type { Rep } from '@voltras/workout-analytics';

import { velocityLossIsValidFor } from '../exercises/movement-class.js';

import { getPhaseMeanVelocity } from '@voltras/workout-analytics';

import {
  buildVelocityLossWatchSuppressedPayload,
  velocityLossBaseline,
} from './channel-payloads.js';
import type { ChannelPublisher } from './channel-publisher.js';
import type { ActiveSet, DeviceSnapshot } from './live-state.js';
import {
  eccentricOverloadLeadIn,
  NO_VELOCITY_LOSS_EXCLUSION,
  type VelocityLossExclusion,
} from './rep-eligibility.js';
import { readSettingsContext } from './set-capture.js';

/** Why the watch is held back. One value today: the VMCP-02.63 finding. */
export type SuppressionReason = 'ballistic_pull';

export const BALLISTIC_PULL: SuppressionReason = 'ballistic_pull';

/**
 * Whether this set's `velocity_loss_exceeded` triggers are suppressed.
 *
 * True only for a set stamped `pull` whose watch did not opt back in via
 * `watch.velocityLoss.force`. Any other class, an unstamped set, and a forced
 * set all evaluate the trigger exactly as they did before this gate.
 */
export function velocityLossWatchSuppressed(
  set: Pick<ActiveSet, 'watch' | 'movementClass'>,
): boolean {
  if (set.watch?.velocityLoss?.force === true) return false;
  return !velocityLossIsValidFor(set.movementClass ?? 'unknown');
}

/**
 * Announce the suppression once, at set start, on any set that registered a
 * `velocity_loss_exceeded` trigger the gate will never let fire. Silence would
 * be indistinguishable from "the lifter never slowed down", which is the wrong
 * conclusion to leave a coaching surface holding.
 *
 * A no-op when the set is not gated, or when it registered no such trigger —
 * there is nothing to suppress.
 */
export function publishVelocityLossSuppression(
  channels: ChannelPublisher,
  set: ActiveSet,
  device: DeviceSnapshot,
): void {
  if (!velocityLossWatchSuppressed(set)) return;
  const specs = set.watch?.notifyOn ?? [];
  if (!specs.some((spec) => spec.type === 'velocity_loss_exceeded')) return;
  channels.publish(buildVelocityLossWatchSuppressedPayload(set, device, BALLISTIC_PULL));
}

/**
 * The reps a set's velocity-loss baseline and comparison may be taken over,
 * and what was left out of them (VW-268).
 *
 * The lead-in is dropped here, BEFORE `velocityLossBaseline` applies the
 * eligibility filter: a rep that is not in the comparison is also not a fair
 * comparator for the reps that are. The window is allowed to come back empty —
 * a set that has not yet reached rep 3 under eccentric overload has no
 * baseline, which is exactly the answer, and nothing fires on a zero baseline.
 *
 * The eccentric setting is read through {@link readSettingsContext} — the one
 * place the device snapshot's eccentric field becomes a set-level observation —
 * so the gate and the persisted set row cannot disagree about whether a set ran
 * with eccentric overload.
 */
export function velocityLossWindow(
  reps: readonly Rep[],
  device: DeviceSnapshot,
): { reps: readonly Rep[]; exclusion: VelocityLossExclusion } {
  const leadInReps = eccentricOverloadLeadIn(readSettingsContext(device).eccentricPct);
  if (leadInReps === 0) return { reps, exclusion: NO_VELOCITY_LOSS_EXCLUSION };
  return {
    reps: reps.slice(leadInReps),
    exclusion: { leadInReps, reason: 'eccentric_overload' },
  };
}

/**
 * One rep's velocity-loss reading: what the gate compares against a threshold.
 *
 * MEAN concentric velocity throughout (VW-484). The thresholds come from
 * studies that measure mean or mean-propulsive velocity, and the wall, the
 * analytics library and the fitted RIR curve all read the mean, so a gate on
 * peaks was measuring one thing and comparing it against another.
 *
 * `lossPct` is null when there is nothing to compare: no baseline yet (an
 * empty window under an eccentric-overload lead-in), or a rep at or above the
 * baseline, which is a new fastest rep rather than a loss. Null never fires.
 */
export interface VelocityLossReading {
  /** Highest mean concentric velocity over the eligible reps of the window, m/s. */
  baseline: number;
  /** The finalized rep's mean concentric velocity, m/s. */
  current: number;
  lossPct: number | null;
  /** The set's own rep number for the rep the baseline came from. */
  baselineRepNumber: number;
  exclusion: VelocityLossExclusion;
}

/**
 * Read the loss at the just-finalized rep, over the reps finalized so far.
 *
 * `finalizedReps` INCLUDES the just-finalized rep, so a new fastest rep folds
 * itself into its own baseline and reads no loss.
 */
export function velocityLossReading(
  finalizedReps: readonly Rep[],
  finalizedRep: Rep,
  device: DeviceSnapshot,
): VelocityLossReading {
  const window = velocityLossWindow(finalizedReps, device);
  const { velocity: baseline, repNumber } = velocityLossBaseline(window.reps);
  const current = getPhaseMeanVelocity(finalizedRep.concentric);
  const comparable = baseline > 0 && current < baseline;
  return {
    baseline,
    current,
    lossPct: comparable ? (100 * (baseline - current)) / baseline : null,
    baselineRepNumber: repNumber,
    exclusion: window.exclusion,
  };
}
