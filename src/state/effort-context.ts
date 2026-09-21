// The effort context pinned at set start (VW-448 slice 5, VW-540).
//
// Everything the effort resolver needs that it cannot know itself: the goal the
// prescription or the typed watch states, the guard that may cue before it, the
// resistance the set meets, and the lifter's fitted curve when it is trusted. It
// is PINNED once, from what was true when the set opened, and stored with the
// set, so a later reading of the set judges it against the rules it began under.
//
// A LOCAL shape of the library's `EffortSetContext`. Nothing here may import from
// `@voltras/workout-analytics`'s effort module until 3.1.0 is published; slice 6
// adds the compile-time check that this shape is assignable to it.
//
// NOTHING READS THE CONTEXT YET. The velocity-loss gate fires exactly as before.

import type { RirVelocityModel, TrustReason } from '../analytics/rir-velocity.js';
import { profileTrust } from '../analytics/rir-velocity.js';
import { resistanceFamilyOf, type ResistanceFamily } from '../analytics/resistance-family.js';
import type {
  ResolvedVelocityLossSpec,
  ResolvedWatchConfig,
  TrainingIntent,
} from '../schemas/set.js';
import type { StoredPlannedExercise } from '../store/types.js';
import type { ActiveSet, DeviceSnapshot } from './live-state.js';
import { hashSettingsContext, readSettingsContext } from './set-capture.js';
import { velocityLossWatchSuppressed } from './velocity-loss-gate.js';
import {
  exerciseFatigueStop,
  resolveVelocityLossSpec,
  VELOCITY_LOSS_DEFAULT_PCT,
} from './velocity-loss-intent.js';

export type EffortGoalSource = 'plan' | 'last_time' | 'explicit' | 'set_intent' | 'plan_intent';
export type EffortLossSource = 'explicit' | 'set_intent' | 'plan_intent';

export type EffortGoal =
  | { kind: 'rep_range'; repsLow: number; repsHigh: number; source: EffortGoalSource }
  | {
      kind: 'target_rpe';
      targetRpe: number;
      repsLow: number | null;
      repsHigh: number | null;
      source: EffortGoalSource;
    }
  | { kind: 'velocity_loss'; lossPct: number; source: EffortGoalSource };

export type EffortGuardInput = {
  /** The row's RPE cap. `null` takes the library policy's default cap; never a literal here. */
  effortCapRpe: number | null;
  effortCapSource: 'plan' | 'policy_default' | null;
  /** A resolved loss percent, or `null`. Never the wall's fallback default. */
  lossPct: number | null;
  lossSource: EffortLossSource | null;
};

export type EffortProfile = {
  interceptMps: number;
  slopeMpsPerRir: number;
  rirErrorReps: number;
  rirRange: [number, number];
  intensityRange: [number, number];
  resistanceFamily: ResistanceFamily;
  modelVersion: string;
};

/** Why no profile was pinned: a trust gate's id, or a reason the curve was never asked. */
export type ProfileWithheldReason =
  | TrustReason
  | 'guest_lifter'
  | 'no_exercise'
  | 'no_model'
  | 'family_mismatch';

/** The library's `EffortSetContext`, plus the one thing kept beside it for the wall. */
export type PinnedEffortContext = {
  /** Carried for the record. The class mapping is task 10, so this is always `unknown`. */
  exerciseClass: 'unknown';
  intent: TrainingIntent | null;
  goal: EffortGoal | null;
  guard: EffortGuardInput;
  bandReferenceLossPct: number;
  relativeIntensity: number | null;
  /** `signature` is the stored settings hash: opaque, never a setting value. */
  resistance: { family: ResistanceFamily; signature: string };
  velocitySignalValid: boolean;
  profile: EffortProfile | null;
  /** `null` exactly when `profile` is pinned; the wall's "calibrating" note reads it. */
  profileWithheld: ProfileWithheldReason | null;
};

/** Everything the pure builder reads, already fetched. */
export interface EffortContextInputs {
  set: Pick<ActiveSet, 'watch' | 'movementClass'>;
  device: DeviceSnapshot;
  planned: StoredPlannedExercise | undefined;
  profile: { profile: EffortProfile; relativeIntensity: number | null } | ProfileWithheldReason;
}

/** Stands in for an unrecorded settings context, which hashes to nothing. */
const NO_SETTINGS_SIGNATURE = 'none';

/** The opaque signature of a device's settings: the same hash the stored set carries. */
export function settingsSignature(device: DeviceSnapshot): string {
  return hashSettingsContext(readSettingsContext(device)) ?? NO_SETTINGS_SIGNATURE;
}

/** The family of resistance a device snapshot describes. */
export function deviceResistanceFamily(device: DeviceSnapshot): ResistanceFamily {
  return resistanceFamilyOf({ trainingMode: device.trainingMode, ...readSettingsContext(device) });
}

/** PURE. Build the context from inputs fetched at set start. */
export function buildEffortContext(inputs: EffortContextInputs): PinnedEffortContext {
  const watchLoss = watchLossSpec(inputs.set.watch);
  const planIntent = inputs.planned?.trainingIntent;
  const goal = goalFromPlan(inputs.planned) ?? goalFromWatch(inputs.set.watch);
  const guard = guardFor(inputs.planned, goal, watchLoss, planIntent);
  const pinned = typeof inputs.profile === 'string' ? null : inputs.profile;
  return {
    exerciseClass: 'unknown',
    intent: planIntent ?? watchLoss?.intent ?? null,
    goal,
    guard,
    bandReferenceLossPct: bandReferenceLossPct(goal, guard, planIntent),
    relativeIntensity: pinned?.relativeIntensity ?? null,
    resistance: {
      family: deviceResistanceFamily(inputs.device),
      signature: settingsSignature(inputs.device),
    },
    velocitySignalValid: !velocityLossWatchSuppressed(inputs.set),
    profile: pinned?.profile ?? null,
    profileWithheld: typeof inputs.profile === 'string' ? inputs.profile : null,
  };
}

function watchLossSpec(
  watch: ResolvedWatchConfig | undefined,
): ResolvedVelocityLossSpec | undefined {
  return watch?.notifyOn.find(
    (spec): spec is ResolvedVelocityLossSpec => spec.type === 'velocity_loss_exceeded',
  );
}

/** The planned row's stated goal. The kind is read from the column (v38), never re-derived. */
function goalFromPlan(planned: StoredPlannedExercise | undefined): EffortGoal | null {
  if (planned === undefined) return null;
  const low = planned.targetRepsLow;
  switch (planned.goalKind) {
    case 'rep_range':
      return low === undefined
        ? null
        : {
            kind: 'rep_range',
            repsLow: low,
            repsHigh: planned.targetRepsHigh ?? low,
            source: 'plan',
          };
    case 'target_rpe':
      return planned.targetRpe === undefined
        ? null
        : {
            kind: 'target_rpe',
            targetRpe: planned.targetRpe,
            repsLow: low ?? null,
            repsHigh: planned.targetRepsHigh ?? low ?? null,
            source: 'plan',
          };
    case 'velocity_loss':
      return planVelocityLossGoal(planned);
    default:
      return null;
  }
}

function planVelocityLossGoal(planned: StoredPlannedExercise): EffortGoal | null {
  if (planned.targetVelocityLossPct !== undefined) {
    return { kind: 'velocity_loss', lossPct: planned.targetVelocityLossPct, source: 'plan' };
  }
  if (planned.trainingIntent === undefined) return null;
  const lossPct = VELOCITY_LOSS_DEFAULT_PCT[planned.trainingIntent];
  return { kind: 'velocity_loss', lossPct, source: 'plan_intent' };
}

/** A typed rep count is the goal; a typed loss is the goal only when no rep count was typed. */
function goalFromWatch(watch: ResolvedWatchConfig | undefined): EffortGoal | null {
  const reps = watch?.notifyOn.find((spec) => spec.type === 'rep_count_reached');
  if (reps !== undefined) {
    return { kind: 'rep_range', repsLow: reps.value, repsHigh: reps.value, source: 'explicit' };
  }
  const loss = watchLossSpec(watch);
  if (loss === undefined) return null;
  return { kind: 'velocity_loss', lossPct: loss.pct, source: loss.thresholdSource ?? 'explicit' };
}

/** The loss guard is the watch's resolved spec, else the plan intent's; never a default. */
function guardFor(
  planned: StoredPlannedExercise | undefined,
  goal: EffortGoal | null,
  watchLoss: ResolvedVelocityLossSpec | undefined,
  planIntent: TrainingIntent | undefined,
): EffortGuardInput {
  const cap = planned?.targetRpe;
  const loss =
    goal?.kind === 'velocity_loss'
      ? undefined
      : (watchLoss ?? resolveVelocityLossSpec({ type: 'velocity_loss_exceeded' }, planIntent));
  return {
    effortCapRpe: cap ?? null,
    effortCapSource: cap === undefined ? null : 'plan',
    lossPct: loss?.pct ?? null,
    lossSource: loss === undefined ? null : (loss.thresholdSource ?? 'explicit'),
  };
}

/** The goal's percent, else the guard's, else the named per-exercise default. */
function bandReferenceLossPct(
  goal: EffortGoal | null,
  guard: EffortGuardInput,
  planIntent: TrainingIntent | undefined,
): number {
  if (goal?.kind === 'velocity_loss') return goal.lossPct;
  return guard.lossPct ?? exerciseFatigueStop(planIntent).pct;
}

/**
 * The curve to pin, or why none is: it must pass every trust gate AND have been
 * fitted under the family this set meets.
 */
export function profileToPin(
  model: RirVelocityModel | undefined,
  family: ResistanceFamily,
  now: Date,
): EffortProfile | ProfileWithheldReason {
  if (model === undefined) return 'no_model';
  const trust = profileTrust(model, now);
  if (trust.reason !== null) return trust.reason;
  if (model.resistanceFamily !== family) return 'family_mismatch';
  return {
    interceptMps: model.interceptMps,
    slopeMpsPerRir: model.slopeMpsPerRir,
    rirErrorReps: model.rirErrorReps,
    rirRange: [model.rirRange[0], model.rirRange[1]],
    intensityRange: [model.intensityRange[0], model.intensityRange[1]],
    resistanceFamily: model.resistanceFamily,
    modelVersion: model.version,
  };
}
