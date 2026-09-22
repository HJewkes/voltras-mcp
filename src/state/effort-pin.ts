// Pin the effort context onto an active set (VW-540): the async half of
// `effort-context.ts`, which fetches what the pure builder reads.
//
// Runs AFTER the set is installed, because two of the three places that open a
// set do so inside a synchronous frame handler that cannot await a store read.
// Every input that describes the moment of set start (the watch, the exercise,
// the lifter, the start snapshot) is read when the pin begins, and the result is
// dropped if any of them changed while the store reads were in flight: a later
// pin with the newer inputs is already on its way.

import type { RirVelocityModel } from '../analytics/rir-velocity.js';
import { log } from '../logger.js';
import { constantLoadSets, referenceOneRepMax } from '../store/rir-velocity-candidates.js';
import { findPlannedExerciseForSession } from '../store/planned-exercise-for-session.js';
import { LOCAL_USER_ID, type SessionStore } from '../store/types.js';
import {
  buildEffortContext,
  deviceResistanceFamily,
  profileToPin,
  settingsSignature,
  type EffortContextInputs,
} from './effort-context.js';
import type { ActiveSet, DeviceSnapshot, LiveState } from './live-state.js';
import type { ServerState } from './server-state.js';

/** Build the context from the set's current start inputs and attach it, unless they moved. */
export async function pinEffortContext(
  state: ServerState,
  live: LiveState,
  setId: string,
): Promise<void> {
  const set = live.set;
  const device = state.setStartDeviceSnapshots.get(setId);
  if (set?.setId !== setId || device === undefined) return;
  const inputs = await loadEffortInputs(state.store, set, device, new Date());
  if (!sameStartInputs(set, live.set) || state.setStartDeviceSnapshots.get(setId) !== device)
    return;
  live.attachEffortContext(setId, buildEffortContext(inputs));
}

/**
 * Pin again after the start inputs moved (an upgrade, or the pre-first-rep snapshot refresh).
 * Never rejects: a context that could not be pinned leaves the set exactly as it was.
 */
export async function repinEffortContext(
  state: ServerState,
  live: LiveState,
  setId: string,
): Promise<void> {
  try {
    await pinEffortContext(state, live, setId);
  } catch (err) {
    log.warn('effort-pin: re-pin failed; the set is unaffected', err);
  }
}

function sameStartInputs(before: ActiveSet, after: ActiveSet | undefined): boolean {
  return (
    after?.setId === before.setId &&
    after.watch === before.watch &&
    after.exerciseId === before.exerciseId &&
    after.lifter === before.lifter
  );
}

async function loadEffortInputs(
  store: SessionStore,
  set: ActiveSet,
  device: DeviceSnapshot,
  now: Date,
): Promise<EffortContextInputs> {
  const planned =
    set.exerciseId === undefined
      ? undefined
      : await findPlannedExerciseForSession(store, set.sessionId, set.exerciseId);
  return { set, device, planned, profile: await loadProfile(store, set, device, now) };
}

/** The owner's own trusted curve for this exercise and family; a guest never gets it. */
async function loadProfile(
  store: SessionStore,
  set: ActiveSet,
  device: DeviceSnapshot,
  now: Date,
): Promise<EffortContextInputs['profile']> {
  if (set.lifter !== undefined) return 'guest_lifter';
  if (set.exerciseId === undefined) return 'no_exercise';
  const stored = await store.getRirVelocityModel(LOCAL_USER_ID, set.exerciseId);
  const model = stored?.model as unknown as RirVelocityModel | undefined;
  const profile = profileToPin(model, deviceResistanceFamily(device), now);
  if (typeof profile === 'string') return profile;
  const relativeIntensity = await relativeIntensityOf(store, set.exerciseId, device.weightLbs);
  return { profile, relativeIntensity };
}

/** Load over the same reference 1RM the curve was fitted against, or `null` when either is unknown. */
async function relativeIntensityOf(
  store: SessionStore,
  exerciseId: string,
  loadLbs: number | undefined,
): Promise<number | null> {
  if (loadLbs === undefined || loadLbs <= 0) return null;
  const sets = await store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId,
    purpose: ['working'],
  });
  const reference = referenceOneRepMax(constantLoadSets(sets));
  return reference === undefined ? null : loadLbs / reference;
}

/**
 * Mark the first finalized rep performed under settings other than the start snapshot's.
 * Called by the bridge for reps 1 to N-1 and by `finalizeSet` for the last rep.
 */
export function markSettingChange(
  state: ServerState,
  live: LiveState,
  setId: string,
  repNumber: number,
  device: DeviceSnapshot,
): void {
  if (live.set?.setId !== setId || live.set.settingChangedAtRep !== undefined) return;
  const start = state.setStartDeviceSnapshots.get(setId);
  if (start === undefined || settingsSignature(start) === settingsSignature(device)) return;
  live.markSettingChanged(repNumber);
}
