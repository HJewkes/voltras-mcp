// Read the set-risk scorer's inputs for a set that is starting (VW-152 S3). Not wired: S4 pins it.

import type { SetRiskInputs } from '../analytics/set-risk.js';
import { riskClassOf } from '../exercises/risk-class.js';
import { setPurposeOf } from '../store/set-purpose.js';
import { scopeSessionSetsToExerciseId, scopeSetsToLifter } from '../store/set-scope.js';
import type { SessionStore, StoredRep, StoredSet } from '../store/types.js';
import { normaliseVelocityToMps } from '../store/velocity-units.js';
import { velocityLossBaseline } from './channel-payloads.js';
import { deviceResistanceFamily, type PinnedEffortContext } from './effort-context.js';
import type { DeviceSnapshot } from './live-state.js';
import { relativeIntensityOf } from './relative-intensity.js';
import { eccentricOverloadLeadIn } from './rep-eligibility.js';

/** What the readers need to know about the set that is starting. */
export interface SetRiskStart {
  readonly setId: string;
  readonly sessionId: string;
  readonly exerciseId?: string | undefined;
  /** Absent means the owner, as on `ActiveSet`. */
  readonly lifter?: string | undefined;
}

/** Every input the S1 scorer takes, read from the store and the start snapshot. */
export async function readSetRiskInputs(
  store: SessionStore,
  set: SetRiskStart,
  device: DeviceSnapshot,
): Promise<SetRiskInputs> {
  const earlier = await earlierWorkingSets(store, set);
  return {
    exerciseClass: riskClassOf(set.exerciseId),
    relativeIntensity: await ownerRelativeIntensity(store, set, device),
    loadLbs: device.weightLbs ?? null,
    setIndexInExercise: earlier === null ? null : earlier.length + 1,
    priorSetDecayed: earlier === null ? null : priorSetDecayed(earlier.at(-1)),
    resistanceFamily: deviceResistanceFamily(device) === 'constant' ? 'constant' : 'other',
    guestLifter: set.lifter !== undefined,
  };
}

/** The reference is the owner's history, so a guest has no relative intensity at all. */
async function ownerRelativeIntensity(
  store: SessionStore,
  set: SetRiskStart,
  device: DeviceSnapshot,
): Promise<number | null> {
  if (set.lifter !== undefined || set.exerciseId === undefined) return null;
  return relativeIntensityOf(store, set.exerciseId, device.weightLbs);
}

/** This lifter's stored working sets of the exercise in this session, oldest first; `null` with no exercise. */
async function earlierWorkingSets(
  store: SessionStore,
  set: SetRiskStart,
): Promise<StoredSet[] | null> {
  if (set.exerciseId === undefined) return null;
  const sessionSets = await store.getSetsForSession(set.sessionId);
  const sameExercise = scopeSessionSetsToExerciseId(sessionSets, set.exerciseId);
  return scopeSetsToLifter(sameExercise, set.lifter).filter(
    (stored) => stored.id !== set.setId && setPurposeOf(stored) === 'working',
  );
}

/** Whether the set's own velocity-loss watch fired; `null` when its watch threshold cannot be recovered. */
function priorSetDecayed(previous: StoredSet | undefined): boolean | null {
  if (previous === undefined) return false;
  const context = previous.effortContext as Partial<PinnedEffortContext> | undefined;
  if (context?.velocitySignalValid === false) return false;
  const thresholdPct = watchThresholdOf(context);
  if (thresholdPct === null) return null;
  const leadIn = eccentricOverloadLeadIn(previous.eccentricPct);
  return watchTripped(normaliseVelocityToMps(previous).reps, leadIn, thresholdPct);
}

// Only these sources prove the pinned percent is the watch spec's own; the band reference never does.
const WATCH_SOURCES: ReadonlySet<string> = new Set(['explicit', 'set_intent']);

/** The pct the live watch fired at, as far as the pinned context proves it; else `null`. */
function watchThresholdOf(context: Partial<PinnedEffortContext> | undefined): number | null {
  const goal = context?.goal;
  if (goal?.kind === 'velocity_loss' && WATCH_SOURCES.has(goal.source)) return goal.lossPct;
  const source = context?.guard?.lossSource;
  if (typeof source !== 'string' || !WATCH_SOURCES.has(source)) return null;
  return context?.guard?.lossPct ?? null;
}

/** Replays the live watch rep by rep: loss from the windowed peak so far against the threshold. */
function watchTripped(reps: readonly StoredRep[], leadIn: number, thresholdPct: number): boolean {
  return reps.some((rep, index) => {
    const baseline = velocityLossBaseline(reps.slice(leadIn, index + 1)).velocity;
    const current = rep.concentric.peakVelocity;
    return (
      baseline > 0 && current < baseline && (100 * (baseline - current)) / baseline >= thresholdPct
    );
  });
}
