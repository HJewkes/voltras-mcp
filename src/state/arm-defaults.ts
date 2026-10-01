// Server-side defaults for an auto-armed set (VW-718, slice S1 of VW-501).
//
// Auto-arm opens a set inside the frame handler, where no store read can run,
// so the set starts with no watch. This set-start subscriber reads the plan row
// the set is training and, when one resolves, attaches the velocity-loss watch
// that row implies. It never stamps `upgradedAt`: the agent's one `set.start`
// upgrade still applies afterwards and replaces whatever landed here.
//
// A set with no resolvable plan row is left exactly as it was.

import type { ResolvedVelocityLossSpec, ResolvedWatchConfig } from '../schemas/set.js';
import { findPlannedExerciseForSession } from '../store/planned-exercise-for-session.js';
import type { StoredPlannedExercise } from '../store/types.js';
import { buildSetUpdatedPayload } from './channel-payloads.js';
import { repinEffortContext } from './effort-pin.js';
import { getSlot, type ServerState } from './server-state.js';
import type { SetStartEvent } from './set-start-seam.js';
import { publishVelocityLossSuppression } from './velocity-loss-gate.js';
import { resolveVelocityLossSpec } from './velocity-loss-intent.js';

/** Where an auto-armed set's server-applied watch came from. Later slices add more. */
export type ArmDefaultsSource = 'plan_row';

export interface ArmDefaults {
  watch: ResolvedWatchConfig;
  source: ArmDefaultsSource;
}

/**
 * The watch a plan row implies: its own loss target when it states one, else its
 * intent's default. `undefined` when there is no row or the row names neither.
 */
export function resolveArmDefaults(
  planned: StoredPlannedExercise | undefined,
): ArmDefaults | undefined {
  if (planned === undefined) return undefined;
  const intent = planned.trainingIntent;
  const spec = resolveVelocityLossSpec(
    { type: 'velocity_loss_exceeded', pct: planned.targetVelocityLossPct },
    intent,
  );
  if (spec === undefined) return undefined;
  const pinned: ResolvedVelocityLossSpec = intent === undefined ? spec : { ...spec, intent };
  return { watch: { notifyOn: [pinned] }, source: 'plan_row' };
}

/** Set-start subscriber: attach the plan row's watch to an auto-armed set. */
export async function applyAutoArmDefaults(
  state: ServerState,
  event: SetStartEvent,
): Promise<void> {
  const live = getSlot(state, event.slotId).live;
  const set = live.set;
  if (set?.setId !== event.setId || set.autoCreatedBy !== 'idle_rep') return;
  if (set.exerciseId === undefined) return;
  const planned = await findPlannedExerciseForSession(state.store, set.sessionId, set.exerciseId);
  const defaults = resolveArmDefaults(planned);
  if (defaults === undefined) return;
  const applied = live.applyArmDefaults(event.setId, defaults);
  if (applied === undefined) return;
  const channels = state.channels.forSlot(event.slotId);
  const device = live.snapshotDevice();
  channels.publish(buildSetUpdatedPayload(applied, device));
  publishVelocityLossSuppression(channels, applied, device);
  await repinEffortContext(state, live, event.setId);
}
