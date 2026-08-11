// Shared confidence vocabulary for values whose trustworthiness varies (VW-151).
//
// WHY THIS IS NOT `baseline-gate.ts`.
// ----------------------------------
// B57's `FeatureGateVerdict` grades ONE axis: how well we know THIS user on
// THIS exercise (`BaselineState`, COLD -> CALIBRATED). It improves as the user
// logs sessions. That axis is unchanged and still owns its own shape.
//
// This module adds the vocabulary for OTHER axes that vary independently of
// the user's history — most immediately a model's own calibration status. The
// two must never be collapsed into one number: "we don't know YOU yet" and
// "this MODEL is uncalibrated for anyone" have different causes, different
// fixes, and different messages, and averaging them tells the user neither.
//
// A value and its indicator always travel together in the same response
// (VW-124's output-shape standard) — never a second tool call to learn whether
// to trust the number you already have.

/** How much to trust an accompanying value. Drives a subtle label/colour in UI. */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * A confidence reading on ONE named axis, attached to one value.
 *
 * `userMessage` and `improvementPath` are populated at EVERY level, not just
 * the bad ones — the same rule B57 follows. "Why you can trust this" is as
 * useful to a reader as "why you can't".
 */
export interface ConfidenceIndicator {
  /** Which axis this reading is about — always named, never implied. */
  axis: string;
  level: ConfidenceLevel;
  /** Internal-facing: why this level, for logs and debugging. */
  reasoning: string;
  /** User-facing hover-tip body: why confidence is what it is RIGHT NOW. */
  userMessage: string;
  /** User-facing: what would raise it, and on what timescale. */
  improvementPath: string;
}

/**
 * The model-calibration axis for `estimateRIRWithProfile`.
 *
 * TIME-INVARIANT BY CONSTRUCTION. Every default profile in
 * `@voltras/workout-analytics`'s `rir-exercise-specific.ts` is marked
 * `@experimental` with placeholder coefficients ("calibration deferred pending
 * real-device session data"). That is a property of the shipped model, not of
 * any user's history — so this reads `low` for every caller, every set, and
 * does NOT improve as someone trains more. Only a calibration effort against
 * real device data moves it.
 *
 * Exported as a constant rather than computed because there is nothing to
 * compute: deriving it per-call would imply a variability that does not exist.
 */
export const RIR_MODEL_CALIBRATION_CONFIDENCE: ConfidenceIndicator = {
  axis: 'model-calibration',
  level: 'low',
  reasoning:
    'estimateRIRWithProfile uses DEFAULT_CABLE_COMPOUND_PROFILE / ' +
    'DEFAULT_CABLE_ISOLATION_PROFILE, whose regression coefficients are documented ' +
    'placeholders pending calibration against real-device session data',
  userMessage:
    "This RIR estimate comes from a model that hasn't been calibrated against real " +
    'Voltra data yet, so treat it as a rough directional read rather than a precise ' +
    'rep count.',
  improvementPath:
    'Improves when calibrated coefficients are fitted from real-device session data ' +
    'and shipped — not by logging more sessions yourself.',
};

/**
 * The input-domain axis: whether this particular estimate's inputs land inside
 * the regression's calibration window.
 *
 * Distinct from model calibration: even a perfectly calibrated model is being
 * extrapolated when asked about a rep whose velocity ratio or velocity loss
 * sits outside the range it was fitted over. `@voltras/workout-analytics`
 * already computes this per estimate and returns it as
 * `ExerciseRIREstimate.confidence`; this wraps that bare label in the shared
 * shape so a consumer renders it the same way as every other axis.
 */
export function rirInputDomainConfidence(level: ConfidenceLevel): ConfidenceIndicator {
  const why: Record<ConfidenceLevel, string> = {
    high: 'this rep’s velocity ratio and velocity loss both sit inside the range the model was fitted over',
    medium:
      'this rep’s velocity ratio or velocity loss sits near the edge of the range the model was fitted over',
    low: 'this rep’s velocity ratio or velocity loss falls outside the range the model was fitted over, so the estimate is an extrapolation',
  };
  return {
    axis: 'input-domain',
    level,
    reasoning: `workout-analytics graded the inputs '${level}': ${why[level]}`,
    userMessage:
      level === 'high'
        ? 'This rep sits squarely in the range the estimate works best over.'
        : level === 'medium'
          ? 'This rep is near the edge of the range the estimate works best over.'
          : 'This rep is outside the range the estimate works best over, so the number is a stretch.',
    improvementPath:
      'Rises on its own for reps taken closer to failure with a clean, fast first rep ' +
      'to anchor against — it reflects THIS set, so it changes set to set.',
  };
}
