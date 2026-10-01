// Server-side defaults for an auto-armed set (VW-718 and VW-719, slices S1 and S2 of VW-501).
//
// Auto-arm opens a set inside the frame handler, where no store read can run,
// so the set starts with no watch. This set-start subscriber reads the plan row
// the set is training and attaches the velocity-loss watch that row implies.
// When no row resolves a threshold, it attaches the labelled assumed stop
// instead (owner decision 2026-09-30, overriding "no intent, no watch"). It never
// stamps `upgradedAt`: the agent's one `set.start` upgrade still applies
// afterwards and replaces whatever landed here.

import type { ResolvedVelocityLossSpec, ResolvedWatchConfig } from '../schemas/set.js';
import { findPlannedExerciseForSession } from '../store/planned-exercise-for-session.js';
import type { StoredPlannedExercise } from '../store/types.js';
import { buildSetUpdatedPayload } from './channel-payloads.js';
import { repinEffortContext } from './effort-pin.js';
import { getSlot, type ServerState } from './server-state.js';
import type { SetStartEvent } from './set-start-seam.js';
import { publishVelocityLossSuppression } from './velocity-loss-gate.js';
import { assumedVelocityLossSpec, resolveVelocityLossSpec } from './velocity-loss-intent.js';

/** Where an auto-armed set's server-applied watch came from. Later slices add more. */
export type ArmDefaultsSource = 'plan_row' | 'default';

export interface ArmDefaults {
  watch: ResolvedWatchConfig;
  source: ArmDefaultsSource;
}

/**
 * The watch a plan row implies: its own loss target when it states one, else its
 * intent's default. With no row, or a row that names neither, the assumed stop.
 */
export function resolveArmDefaults(planned: StoredPlannedExercise | undefined): ArmDefaults {
  const fromPlan = planned === undefined ? undefined : planRowSpec(planned);
  if (fromPlan === undefined) {
    return { watch: { notifyOn: [assumedVelocityLossSpec()] }, source: 'default' };
  }
  return { watch: { notifyOn: [fromPlan] }, source: 'plan_row' };
}

function planRowSpec(planned: StoredPlannedExercise): ResolvedVelocityLossSpec | undefined {
  const intent = planned.trainingIntent;
  const spec = resolveVelocityLossSpec(
    { type: 'velocity_loss_exceeded', pct: planned.targetVelocityLossPct },
    intent,
  );
  if (spec === undefined) return undefined;
  return intent === undefined ? spec : { ...spec, intent };
}

/** Set-start subscriber: attach the plan row's watch, else the assumed stop, to an auto-armed set. */
export async function applyAutoArmDefaults(
  state: ServerState,
  event: SetStartEvent,
): Promise<void> {
  const live = getSlot(state, event.slotId).live;
  const set = live.set;
  if (set?.setId !== event.setId || set.autoCreatedBy !== 'idle_rep') return;
  const planned =
    set.exerciseId === undefined
      ? undefined
      : await findPlannedExerciseForSession(state.store, set.sessionId, set.exerciseId);
  const applied = live.applyArmDefaults(event.setId, resolveArmDefaults(planned));
  if (applied === undefined) return;
  const channels = state.channels.forSlot(event.slotId);
  const device = live.snapshotDevice();
  channels.publish(buildSetUpdatedPayload(applied, device));
  publishVelocityLossSuppression(channels, applied, device);
  await repinEffortContext(state, live, event.setId);
}
