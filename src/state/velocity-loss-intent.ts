// Goal-keyed velocity-loss thresholds (VW-266).
//
// The `velocity_loss_exceeded` threshold used to be whatever number the caller
// typed. There is no single right number: the same drop that is a sensible
// stop for a strength set is a badly truncated hypertrophy set. Pareja-Blanco
// 2020 ran VL0/10/20/40 for eight weeks and found NO between-group difference
// in strength despite wildly different volumes, while VL20 and VL40 maximised
// hypertrophy; Jukic 2023's 37-study meta reaches the same shape — velocity-loss
// magnitude does not meaningfully change strength gains, higher loss favours
// hypertrophy, lower loss better preserves jump, sprint and velocity.
//
// So the threshold is a GOAL DIAL, and this module is the one place the goal is
// turned into a number. Nothing here decides whether a set stops; it decides
// what number the existing gate compares against, and records which of the
// three inputs supplied it so the fired event can say.
//
// POPULATION CAVEAT, stated once. This literature is barbell squat and bench
// press in young trained men on a fixed external load. Voltra is an
// electromagnetic cable device with independently settable eccentric load, so
// these are defensible starting points, not transferable constants.

import type {
  ResolvedVelocityLossSpec,
  TrainingIntent,
  VelocityLossThresholdSource,
} from '../schemas/set.js';

/**
 * Default velocity-loss stop threshold per intent, in percent.
 *
 * Each is the top of its literature range rather than the middle, because
 * stopping a set is the intervention with a cost: a false stop takes training
 * away from a lifter who was fine, and the evidence that a lower threshold buys
 * more strength is exactly what Pareja-Blanco 2020 failed to find.
 *
 *   * `strength` — 20, top of the 10-20% band.
 *   * `hypertrophy` — 30, inside the 25-40% band; VL20 and VL40 both maximised
 *     hypertrophy in the four-arm trial, and VL40 alone slowed tensiomyography
 *     delay time, so the useful part of the band is its lower half.
 *   * `power` — 10. The band collapses to a point here: Rodríguez-Rosell 2021
 *     found VL10 produced the largest jump gain and the best sprint change, and
 *     the lower-limb meta-regression has jump and sprint improving monotonically
 *     as loss falls.
 */
export const VELOCITY_LOSS_DEFAULT_PCT: Readonly<Record<TrainingIntent, number>> = {
  strength: 20,
  hypertrophy: 30,
  power: 10,
};

/** The literature band each default sits in, for copy that must quote a range. */
export const VELOCITY_LOSS_RANGE_PCT: Readonly<Record<TrainingIntent, readonly [number, number]>> =
  {
    strength: [10, 20],
    hypertrophy: [25, 40],
    power: [10, 10],
  };

/**
 * Pin one `velocity_loss_exceeded` spec's threshold.
 *
 * Precedence, highest first:
 *   1. an explicit `pct` on the spec — a caller who typed a number meant it,
 *      and this is the path every pre-VW-266 caller is on, unchanged;
 *   2. an `intent` on the spec — this set's stated goal;
 *   3. the intent on the planned exercise this set is training.
 *
 * Returns undefined when none of the three is available. That is not a
 * default-shaped answer on purpose: there is no defensible constant to fall
 * back to, and inventing one is precisely what this rule exists to remove. The
 * caller refuses the set with {@link VELOCITY_LOSS_NO_THRESHOLD_MESSAGE}.
 */
export function resolveVelocityLossSpec(
  spec: {
    type: 'velocity_loss_exceeded';
    pct?: number | undefined;
    intent?: TrainingIntent | undefined;
  },
  planIntent: TrainingIntent | undefined,
): ResolvedVelocityLossSpec | undefined {
  if (spec.pct !== undefined) {
    return withProvenance(spec.pct, spec.intent, 'explicit');
  }
  if (spec.intent !== undefined) {
    return withProvenance(VELOCITY_LOSS_DEFAULT_PCT[spec.intent], spec.intent, 'set_intent');
  }
  if (planIntent !== undefined) {
    return withProvenance(VELOCITY_LOSS_DEFAULT_PCT[planIntent], planIntent, 'plan_intent');
  }
  return undefined;
}

/** What a caller is told when no threshold could be resolved. */
export const VELOCITY_LOSS_NO_THRESHOLD_MESSAGE =
  'A velocity_loss_exceeded trigger needs a threshold: pass `pct`, or pass `intent` ' +
  "(strength | hypertrophy | power) to take that goal's default, or train against a planned " +
  'exercise that carries a trainingIntent.';

function withProvenance(
  pct: number,
  intent: TrainingIntent | undefined,
  thresholdSource: VelocityLossThresholdSource,
): ResolvedVelocityLossSpec {
  return {
    type: 'velocity_loss_exceeded',
    pct,
    ...(intent !== undefined ? { intent } : {}),
    thresholdSource,
  };
}
