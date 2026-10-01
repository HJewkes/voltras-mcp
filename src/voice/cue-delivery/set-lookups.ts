// Live-state reads the delivery emitter needs per set (VW-140 plan slice S6).
//
// `set_started` carries no exercise id and `rep_finalized` no effort fields, so the
// emitter asks the slot's live state for them by set id instead.

import type { Rep } from '@voltras/workout-analytics';

import { effortForSet } from '../../analytics/effort-for-set.js';
import { readRomIntegrity } from '../../analytics/rom-integrity.js';
import type { ActiveSet, DeviceSnapshot, LiveState } from '../../state/live-state.js';
import { velocityLossWindow } from '../../state/velocity-loss-gate.js';
import type { SetSignals } from './delivery-emitter.js';

export type SetLookupLive = Pick<
  LiveState,
  'set' | 'snapshotDevice' | 'snapshotSession' | 'snapshotCompletedSets' | 'setRiskReadingFor'
>;

interface TrackedSet {
  set: ActiveSet;
  device: DeviceSnapshot;
}

/** The active set with this id, else the session's finished set with it, else `null`. */
export function findSet(live: SetLookupLive, setId: string): TrackedSet | null {
  if (live.set?.setId === setId) return { set: live.set, device: live.snapshotDevice() };
  return live.snapshotCompletedSets().find((record) => record.set.setId === setId) ?? null;
}

/** The set's own exercise snapshot, falling back to the session's current exercise. */
export function exerciseOf(live: SetLookupLive, setId: string): string | null {
  return findSet(live, setId)?.set.exerciseId ?? live.snapshotSession()?.exerciseId ?? null;
}

export function repsOf(live: SetLookupLive, setId: string): readonly Rep[] {
  return findSet(live, setId)?.set.reps ?? [];
}

/** The lifter label the set was snapshotted with, or `undefined` for the owner. */
export function lifterOf(live: SetLookupLive, setId: string): string | undefined {
  return findSet(live, setId)?.set.lifter;
}

/** Effort, loss threshold, lead-in and ROM decay, measured the way the live watch measures them. */
export function signalsOf(live: SetLookupLive, setId: string): SetSignals {
  const tracked = findSet(live, setId);
  if (tracked === null) return {};
  const { set, device } = tracked;
  return {
    effort: effortForSet(set, device).reps.at(-1) ?? null,
    lossThresholdPct: lossThresholdOf(set),
    leadInReps: velocityLossWindow(set.reps, device).exclusion.leadInReps,
    romDecayVerdict: readRomIntegrity(set.reps).decay.verdict,
  };
}

function lossThresholdOf(set: ActiveSet): number | null {
  const spec = set.watch?.notifyOn.find((entry) => entry.type === 'velocity_loss_exceeded');
  return spec?.type === 'velocity_loss_exceeded' ? spec.pct : null;
}
