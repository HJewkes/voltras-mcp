// Movement-class gate on the `velocity_loss_exceeded` watch (VMCP-02.63).
//
// One predicate, read by the bridge before it evaluates a `velocity_loss_exceeded`
// spec, and by the set-start paths that announce the suppression. It introduces
// NO numeric threshold: the spec's own `pct` still decides when the trigger
// fires, and the gate only decides whether the trigger is evaluated at all.

import { velocityLossIsValidFor } from '../exercises/movement-class.js';

import { buildVelocityLossWatchSuppressedPayload } from './channel-payloads.js';
import type { ChannelPublisher } from './channel-publisher.js';
import type { ActiveSet, DeviceSnapshot } from './live-state.js';

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
export function velocityLossWatchSuppressed(set: ActiveSet): boolean {
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
