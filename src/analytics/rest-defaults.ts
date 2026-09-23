// Rest-timer defaults by training goal, and the auto-extension when a set's
// reps-to-VL-threshold fall versus the prior set of the same exercise
// (VW-297).
//
// Two citations carry the whole module:
//
//   * Grgic, Schoenfeld, Skrepnik, Davies & Mikulic, Sports Medicine 48(1),
//     2018 (10.1007/s40279-017-0788-x): across 23 studies, rest over 2
//     minutes is necessary to maximise strength gains in TRAINED lifters;
//     60-120s suffices untrained.
//   * Singer, Scott, Deprez, Piponnier, Verhulst & Rabasa, Frontiers in
//     Sports and Active Living, 2024 (10.3389/fspor.2024.1429789): for
//     hypertrophy, a small benefit to rest over 60s, no further benefit
//     beyond 90s. Its proposed mechanism is volume-load preservation --
//     directly observable on Voltra as reps-to-threshold holding steady set
//     to set -- which is what makes a rep-count DROP the extension trigger.
//
// `intent` is `undefined` for a set training against no plan, or a plan whose
// exercise carries no `trainingIntent`. That is silence, not a claim of
// "strength" or any other goal, so it gets its own named default rather than
// folding into one of the two literature-backed buckets.

import { getRepPeakVelocity, type Rep } from '@voltras/workout-analytics';

import { selectEligibleReps } from '../state/rep-eligibility.js';
import type { TrainingIntent } from '../schemas/set.js';
import { DEFAULT_STOP_INTENT, VELOCITY_LOSS_DEFAULT_PCT } from '../state/velocity-loss-intent.js';

/** >=120s floor; sits comfortably inside Grgic 2018's "over 2 minutes" trained-lifter finding. */
export const STRENGTH_REST_SECONDS = 150;

/** Midpoint of the 90-120s hypertrophy window Singer 2024 finds no further benefit past. */
export const HYPERTROPHY_REST_SECONDS = 105;

/**
 * Absent a resolvable goal, rest at least as long as the untrained-sufficient
 * floor from Grgic 2018 -- long enough to be safe for an unknown strength
 * goal without assuming one.
 */
export const DEFAULT_REST_SECONDS = 120;

/** Added to the next rest per rep of reps-to-threshold drop (Singer 2024's volume-load-preservation read). */
export const REST_EXTENSION_STEP_SECONDS = 30;

/** Ceiling on the auto-extension, so one noisy reading can't propose a runaway rest. */
export const MAX_REST_EXTENSION_SECONDS = 60;

/**
 * Default rest, in seconds, by training goal. `undefined` and any intent this
 * table doesn't special-case both fall to {@link DEFAULT_REST_SECONDS}.
 */
export function defaultRestSeconds(intent: TrainingIntent | undefined): number {
  if (intent === 'strength') return STRENGTH_REST_SECONDS;
  if (intent === 'hypertrophy') return HYPERTROPHY_REST_SECONDS;
  return DEFAULT_REST_SECONDS;
}

/**
 * Extra rest (seconds) to layer onto the next set's rest when
 * `currRepsToThreshold` fell versus `prevRepsToThreshold` -- the prior set of
 * the same exercise reaching its velocity-loss threshold in fewer reps, the
 * observable Singer 2024 ties to insufficient rest. Zero when either set
 * never reached its threshold (nothing to compare) or the count held/grew.
 *
 * Scales with the size of the drop, bounded by {@link MAX_REST_EXTENSION_SECONDS}
 * so a single outlier set can't propose an unreasonable rest.
 */
export function restExtensionSeconds(
  prevRepsToThreshold: number | null,
  currRepsToThreshold: number | null,
): number {
  if (prevRepsToThreshold === null || currRepsToThreshold === null) return 0;
  if (currRepsToThreshold >= prevRepsToThreshold) return 0;
  const drop = prevRepsToThreshold - currRepsToThreshold;
  return Math.min(MAX_REST_EXTENSION_SECONDS, drop * REST_EXTENSION_STEP_SECONDS);
}

/**
 * The 1-indexed rep number at which `reps`' velocity loss first reaches
 * `thresholdPct`, or `null` when the set never reached it.
 *
 * Loss basis is peak-concentric-vs-baseline, over ELIGIBLE reps only --
 * {@link selectEligibleReps} and `getRepPeakVelocity` are the same two
 * primitives `report.session_results`' RIR line and `vbt.rir` compose this
 * exact formula from, reused here rather than re-derived so a rep this rule
 * excludes cannot quietly be the baseline in one surface and not another.
 */
export function repsToVelocityLossThreshold(
  reps: readonly Rep[],
  thresholdPct: number,
): number | null {
  if (reps.length === 0) return null;
  const eligible = selectEligibleReps(reps);
  const baselineMax = Math.max(...eligible.map((rep) => getRepPeakVelocity(rep)));
  if (!(baselineMax > 0)) return null;
  for (const rep of eligible) {
    const lossPct = Math.max(0, ((baselineMax - getRepPeakVelocity(rep)) / baselineMax) * 100);
    if (lossPct >= thresholdPct) return rep.repNumber;
  }
  return null;
}

/** Where a resolved rest length came from; `explicit_plan` is the coach's number, the other two are derived. */
export type RestSource = 'explicit_plan' | 'intent_default' | 'intent_default_extended';

/** A rest length with its provenance, shared by `timer.start` and the dashboard snapshot. */
export interface ResolvedRest {
  readonly seconds: number;
  readonly source: RestSource;
  readonly intent: TrainingIntent | null;
  readonly prevRepsToThreshold: number | null;
  readonly currRepsToThreshold: number | null;
  readonly extensionSeconds: number;
}

/** What {@link resolveRestLength} reads: the plan row (if any) and the exercise's completed sets. */
export interface RestLengthInput {
  readonly planned?: { restSec?: number; trainingIntent?: TrainingIntent } | undefined;
  /** Completed sets of the active exercise, oldest first; only the last two are compared. */
  readonly exerciseSets: readonly { readonly reps: readonly Rep[] }[];
}

/**
 * The rest to count down after a set: the plan's `restSec` when the coach set one, else
 * the intent default plus the reps-to-threshold extension. A coach-set rest is never extended.
 *
 * The extension's threshold is the goal-keyed stop default for this exercise, falling to
 * `DEFAULT_STOP_INTENT` with no intent — the same fallback the session summary uses.
 */
export function resolveRestLength(input: RestLengthInput): ResolvedRest {
  const intent = input.planned?.trainingIntent;
  const thresholdPct = VELOCITY_LOSS_DEFAULT_PCT[intent ?? DEFAULT_STOP_INTENT];
  const sets = input.exerciseSets;
  const currSet = sets[sets.length - 1];
  const prevSet = sets[sets.length - 2];
  const currRepsToThreshold = currSet
    ? repsToVelocityLossThreshold(currSet.reps, thresholdPct)
    : null;
  const prevRepsToThreshold = prevSet
    ? repsToVelocityLossThreshold(prevSet.reps, thresholdPct)
    : null;
  const common = { intent: intent ?? null, prevRepsToThreshold, currRepsToThreshold };
  const plannedRest = input.planned?.restSec;
  if (plannedRest !== undefined) {
    return { ...common, seconds: plannedRest, source: 'explicit_plan', extensionSeconds: 0 };
  }
  const extensionSeconds = restExtensionSeconds(prevRepsToThreshold, currRepsToThreshold);
  return {
    ...common,
    seconds: defaultRestSeconds(intent) + extensionSeconds,
    source: extensionSeconds > 0 ? 'intent_default_extended' : 'intent_default',
    extensionSeconds,
  };
}

/**
 * The completed, non-empty sets of `exerciseId`, oldest first. A set with no exercise of
 * its own inherits the session's (matches `report-tools.ts`'s `groupByExercise`).
 */
export function completedSetsForExercise<T extends CompletedSetShape>(
  sets: readonly T[],
  sessionExerciseId: string | undefined,
  exerciseId: string,
): T[] {
  return sets.filter(
    (set) =>
      set.endedAt !== undefined &&
      set.reps.length > 0 &&
      (set.exerciseId ?? sessionExerciseId) === exerciseId,
  );
}

interface CompletedSetShape {
  readonly exerciseId?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly reps: readonly Rep[];
}
