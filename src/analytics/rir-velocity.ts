// The per-lifter, per-exercise RIR-velocity curve (VW-298).
//
// WHY AN INDIVIDUAL CURVE AND NOT A CONSTANT
// ------------------------------------------
// Jukic, Prnjak, Helms & McGuigan (Physiological Reports 12(5), 2024 (10.14814/phy2.15955))
// built individual RIR-velocity models in one session and used them to predict
// reps in reserve in a LATER session: mean error under 2 repetitions across
// 70%, 80% and 90% 1RM. General (group) models were only acceptable at 80% and
// 90% and FAILED at 70%; the individual fits were roughly twice as good. A
// single model spanning 70-90% performed as well as load-specific ones, which
// is why one curve per lifter per exercise is the right grain — not one per
// load.
//
// That result is what makes an RP-corpus RIR prescription convertible into a
// velocity target at all. Without a fitted curve there is no defensible
// conversion, and this module says so rather than falling back to a group
// number (see {@link GENERAL_MODEL_CAVEAT}).
//
// WHY LINEAR, NOT LOG-LINEAR
// --------------------------
// Velocity is regressed on reps in reserve as a straight line, v = intercept +
// slope * rir. Two reasons. The band this fit is drawn from spans roughly RIR
// 0 to 6, and over that range a log-linear form differs from a straight line
// by less than the residual scatter the fit already carries — the curvature is
// not identifiable from the data, so choosing it would be asserting a shape
// the evidence cannot support. And a log-linear form needs a fixed asymptote
// (the velocity approached at large RIR), which no source in this repo states
// for a cable device; picking one would put an invented constant inside every
// target this module emits. The straight line has two parameters, both
// estimated from the lifter's own reps, and its residual standard error
// converts directly into the units Jukic reports (`rirErrorReps`), so the fit
// can be compared against that paper's sub-2-rep figure rather than graded on
// an R² with no benchmark.
//
// PURE. Every input is already-shaped observation data; nothing here touches
// the store, the device, or the clock.

import { getRepMeanVelocity, type Rep } from '@voltras/workout-analytics';

/** Stamped onto every model this module fits. Bump on any change below. */
export const RIR_VELOCITY_MODEL_VERSION = 'rir-velocity@1.0.0';

declare const rirModelVelocityBrand: unique symbol;

/**
 * A velocity on the measure the curve is fitted on: a rep's MEAN concentric
 * velocity, m/s. Only {@link rirModelVelocity} makes one, so a peak cannot be
 * handed to {@link rirForVelocity} by mistake (VW-483).
 */
export type RirModelVelocityMps = number & { readonly [rirModelVelocityBrand]: true };

/** The one velocity the curve is fitted on and read with (VW-483). */
export function rirModelVelocity(rep: Rep): RirModelVelocityMps {
  return getRepMeanVelocity(rep) as RirModelVelocityMps;
}

/**
 * The fit error, in reps in reserve, below which a curve is trusted to state effort:
 * Jukic 2024's individual models predicted a later session within under 2 reps.
 */
export const TRUSTED_RIR_ERROR_REPS = 2;

/**
 * Whether a stored curve is trusted to state reps in reserve or RPE (VW-485). The one
 * trust gate: the effort resolver (VW-448) replaces this function, not its callers.
 */
export function isTrustedRirModel(model: RirVelocityModel | undefined): model is RirVelocityModel {
  return model !== undefined && model.rirErrorReps < TRUSTED_RIR_ERROR_REPS;
}

/** The source of a set's reps-in-reserve anchor. */
export type RirAnchorSource = 'failure' | 'self_report';

/** One rep's place in the curve: its velocity and how many reps were left. */
export interface RirVelocityPoint {
  /** Reps in reserve at this rep. 0 is the last rep of a set taken to failure. */
  rir: number;
  /** Mean concentric velocity, m/s, from {@link rirModelVelocity}. */
  velocityMps: number;
}

/**
 * One candidate set, already reduced to points. `relativeIntensity` is the
 * set's load over the lifter's own reference 1RM for the exercise; the caller
 * computes it, because what counts as a reference is a store question.
 */
export interface RirVelocityObservation {
  setId: string;
  sessionId: string;
  /** ISO-8601 start of the set. */
  performedAt: string;
  relativeIntensity: number;
  anchorSource: RirAnchorSource;
  points: readonly RirVelocityPoint[];
}

/**
 * Every threshold a fit has to clear. Each one is named so a caller can say
 * WHICH minimum a lifter has not met, rather than reporting a bare null.
 */
export const RIR_VELOCITY_MINIMUMS = {
  /**
   * The intensity band, from Jukic 2024's own design: individual models held
   * across 70/80/90% 1RM and one model spanning the band did as well as
   * load-specific ones. Below 70% the paper's general models failed outright
   * and no individual result is reported, so a lighter set is outside what the
   * evidence covers.
   *
   * The EDGES ARE SOFT and deliberately not widened. The reference 1RM this
   * ratio is taken against is an estimate carrying roughly 10% standard error
   * (see `tools/e1rm-band.ts`), so a set sitting near an edge may fall either
   * side of it. Widening the band to absorb that would silently import the
   * 65% sets the paper says nothing about; the honest move is to keep the
   * published band and let the estimate's error be the estimate's error.
   */
  minRelativeIntensity: 0.7,
  maxRelativeIntensity: 0.9,
  /**
   * Qualifying sets. Three, matching the failure-anchor floor the baseline
   * state machine already uses for CALIBRATED (`exercise-baselines.ts`): the
   * same evidence backs both, so requiring different amounts of it in two
   * places would be two answers to one question.
   */
  minSets: 3,
  /**
   * Distinct sessions. Jukic fitted within ONE session and validated against a
   * later one, so a single-session fit is what that paper licenses. Two is a
   * deliberate step past it: a curve fitted inside one bout carries that day's
   * readiness with no chance to disagree with itself, and this model is used
   * to set a target rather than to make a research claim.
   */
  minSessions: 2,
  /**
   * Points. Not an independent threshold — it is `minSets` times the four-rep
   * shape floor the rest of this repo already applies to any set a velocity
   * trajectory is read from (`exercise-baselines.ts`, `failure-harvest.ts`).
   */
  minPoints: 12,
  /**
   * Reps-in-reserve spread the points must cover. RP prescriptions land in the
   * RIR 0-4 range, so a fit over a narrower spread than this would be
   * extrapolating into the range it is asked about rather than interpolating
   * across it.
   */
  minRirSpread: 3,
  /**
   * Slope floor, m/s per RIR. A curve is only usable if velocity actually
   * RISES with reps in reserve; a flat or inverted fit means the points carry
   * no RIR signal, whatever their R². Exclusive: the check is `slope > 0`.
   */
  minSlopeMpsPerRir: 0,
} as const;

/**
 * The finding, in the short form TOOL DESCRIPTIONS carry.
 *
 * `et al.` rather than the full author list, and no DOI, because a description
 * is rendered onto the published capability reference and the confidentiality
 * guard reads an internal-capital surname and a DOI fragment as
 * identifier-shaped tokens. The full citation lives in
 * {@link JUKIC_2024_CITATION}, which travels on result payloads rather than on
 * a page, and in this module's header.
 */
export const JUKIC_2024_FINDING =
  'Jukic et al. 2024 (Physiological Reports) — individual RIR-velocity models predicted a ' +
  'later session within under 2 repetitions of mean error across 70/80/90% 1RM; general ' +
  '(group) models failed at 70% and were only acceptable at 80-90%, and individual fits were ' +
  'roughly twice as good.';

/** The full citation, carried on results rather than on a published page. */
export const JUKIC_2024_CITATION =
  'Jukic, Prnjak, Helms & McGuigan, Physiological Reports 12(5), 2024, ' +
  'doi 10.14814/phy2.15955 — individual RIR-velocity models predicted a later session within ' +
  'under 2 repetitions of mean error across 70/80/90% 1RM; general (group) models failed at ' +
  '70% and were only acceptable at 80-90%, and individual fits were roughly twice as good.';

/**
 * What a caller gets INSTEAD of a velocity target when the lifter has no
 * fitted curve. Deliberately not a group number: Jukic's general models failed
 * at 70% 1RM, so a fallback constant would be wrong in exactly the part of the
 * band most working sets sit in.
 */
export const GENERAL_MODEL_CAVEAT =
  'No velocity target: this lifter has no fitted RIR-velocity curve for this exercise, and ' +
  'this server does not substitute a general one. ' +
  JUKIC_2024_CITATION +
  ' A group model would therefore be wrong in the part of the band most working sets sit in. ' +
  'Coach the RIR prescription as stated and read velocity as a within-set loss figure, not as ' +
  'a proximity-to-failure estimate. To fit a curve, record at least ' +
  `${String(RIR_VELOCITY_MINIMUMS.minSets)} working sets at ` +
  `${String(Math.round(RIR_VELOCITY_MINIMUMS.minRelativeIntensity * 100))}-` +
  `${String(Math.round(RIR_VELOCITY_MINIMUMS.maxRelativeIntensity * 100))}% of estimated 1RM, ` +
  `across at least ${String(RIR_VELOCITY_MINIMUMS.minSessions)} sessions, each ending at ` +
  'failure or carrying a self-reported reps-in-reserve.';

/** A fitted curve for one lifter on one exercise. */
export interface RirVelocityModel {
  form: 'linear';
  version: string;
  /** Fitted velocity at RIR 0, m/s — the lifter's own terminal velocity. */
  interceptMps: number;
  /** Velocity gained per rep in reserve, m/s. Positive by construction. */
  slopeMpsPerRir: number;
  /** Coefficient of determination of the fit. */
  r2: number;
  /** Residual standard error of the fit, m/s. */
  seeMps: number;
  /**
   * `seeMps` divided by the slope: the fit's error expressed in reps in
   * reserve, which is the unit Jukic 2024 reports (under 2 reps).
   */
  rirErrorReps: number;
  pointCount: number;
  setCount: number;
  sessionCount: number;
  /** Lowest and highest RIR the fit actually saw. */
  rirRange: readonly [number, number];
  /** Lowest and highest relative intensity the fit actually saw. */
  intensityRange: readonly [number, number];
  anchorSources: { failure: number; selfReport: number };
  /** ISO-8601 of the earliest and latest qualifying set. */
  observedFrom: string;
  observedTo: string;
}

/** Counts behind a fit, reported whether or not a model came out of it. */
export interface RirVelocityQualification {
  observedSets: number;
  qualifyingSets: number;
  qualifyingSessions: number;
  qualifyingPoints: number;
  rirSpread: number;
}

/** A fit attempt: the model when one stands, and always why. */
export interface RirVelocityFit {
  model: RirVelocityModel | null;
  qualification: RirVelocityQualification;
  /** One phrase naming the minimum that was not met, or what the fit stands on. */
  reason: string;
}

/**
 * Fit one lifter's RIR-velocity curve for one exercise.
 *
 * `model` is null under any unmet minimum in {@link RIR_VELOCITY_MINIMUMS},
 * and `reason` names which one. Never a partial model and never a group
 * fallback — see {@link GENERAL_MODEL_CAVEAT}.
 */
export function fitRirVelocityModel(
  observations: readonly RirVelocityObservation[],
): RirVelocityFit {
  const qualifying = observations.filter(inBand);
  const points = qualifying.flatMap((o) => o.points);
  const sessions = new Set(qualifying.map((o) => o.sessionId));
  const rirs = points.map((p) => p.rir);
  const qualification: RirVelocityQualification = {
    observedSets: observations.length,
    qualifyingSets: qualifying.length,
    qualifyingSessions: sessions.size,
    qualifyingPoints: points.length,
    rirSpread: rirs.length === 0 ? 0 : Math.max(...rirs) - Math.min(...rirs),
  };
  const shortfall = firstUnmetMinimum(qualification);
  if (shortfall !== null) return { model: null, qualification, reason: shortfall };

  const line = leastSquares(
    rirs,
    points.map((p) => p.velocityMps),
  );
  if (line.slope <= RIR_VELOCITY_MINIMUMS.minSlopeMpsPerRir) {
    return {
      model: null,
      qualification,
      reason:
        'velocity does not rise with reps in reserve across these sets, so the points carry no ' +
        'RIR signal to fit',
    };
  }
  return {
    model: buildModel(line, qualifying, points, sessions.size),
    qualification,
    reason: `fitted over ${String(points.length)} reps from ${String(qualifying.length)} sets`,
  };
}

/** The velocity this curve puts on a reps-in-reserve prescription. */
export interface RirVelocityTarget {
  velocityMps: number;
  /**
   * Whether `rir` sits inside the RIR range the curve was fitted over. False
   * means the answer is an extrapolation and should be read as one.
   */
  withinFittedRange: boolean;
}

/**
 * The velocity target for a reps-in-reserve prescription — the inverse read of
 * the curve, and the whole point of fitting it.
 *
 * Extrapolation is REPORTED, NOT REFUSED. A lifter whose sets all ran to RIR
 * 0-3 asked about RIR 4 gets a number with `withinFittedRange: false`, because
 * a straight line one rep past its data is a weaker claim than the fit, not a
 * meaningless one. Callers that need the stronger claim can check the flag.
 */
export function velocityForRir(model: RirVelocityModel, rir: number): RirVelocityTarget {
  const [low, high] = model.rirRange;
  return {
    velocityMps: round3(model.interceptMps + model.slopeMpsPerRir * rir),
    withinFittedRange: rir >= low && rir <= high,
  };
}

/** The reps in reserve this curve reads off an observed velocity (VW-310). */
export interface RirVelocityReading {
  rir: number;
  /** 95% CI band from `rirErrorReps`, half-rep resolution — same convention as `ExerciseRIREstimate.range`. */
  range: { low: number; high: number };
  /**
   * Whether the OBSERVED velocity implies a RIR inside the range the curve was
   * fitted over. False means the reading is an extrapolation past the fitted
   * curve, the mirror image of {@link RirVelocityTarget.withinFittedRange}.
   */
  withinFittedRange: boolean;
}

/**
 * The reps-in-reserve this curve puts on an OBSERVED velocity — the inverse
 * read of {@link velocityForRir}. Solves the same line, `v = intercept + slope
 * * rir`, for `rir` instead of `v`.
 *
 * Every input this module fits on is the lifter's own recorded velocity
 * against a known RIR anchor (never a velocity-LOSS percentage), and this
 * read stays on that same footing: the caller hands a raw velocity, not a
 * loss figure.
 */
export function rirForVelocity(
  model: RirVelocityModel,
  velocityMps: RirModelVelocityMps,
): RirVelocityReading {
  const [low, high] = model.rirRange;
  const rawRir = (velocityMps - model.interceptMps) / model.slopeMpsPerRir;
  const halfWidth = roundToHalf(1.96 * model.rirErrorReps);
  return {
    rir: round2(Math.max(0, rawRir)),
    range: {
      low: Math.max(0, roundToHalf(rawRir - halfWidth)),
      high: roundToHalf(rawRir + halfWidth),
    },
    withinFittedRange: rawRir >= low && rawRir <= high,
  };
}

function inBand(observation: RirVelocityObservation): boolean {
  return (
    observation.points.length > 0 &&
    observation.relativeIntensity >= RIR_VELOCITY_MINIMUMS.minRelativeIntensity &&
    observation.relativeIntensity <= RIR_VELOCITY_MINIMUMS.maxRelativeIntensity
  );
}

/** The first minimum `q` fails, phrased for a caller to relay, or null. */
function firstUnmetMinimum(q: RirVelocityQualification): string | null {
  const m = RIR_VELOCITY_MINIMUMS;
  if (q.qualifyingSets < m.minSets) {
    return `only ${String(q.qualifyingSets)} of ${String(m.minSets)} sets in the 70-90% band`;
  }
  if (q.qualifyingSessions < m.minSessions) {
    return `qualifying sets span ${String(q.qualifyingSessions)} of ${String(m.minSessions)} sessions`;
  }
  if (q.qualifyingPoints < m.minPoints) {
    return `only ${String(q.qualifyingPoints)} of ${String(m.minPoints)} reps to fit`;
  }
  if (q.rirSpread < m.minRirSpread) {
    return `reps in reserve span ${String(q.rirSpread)}, under the ${String(m.minRirSpread)} needed`;
  }
  return null;
}

function buildModel(
  line: Line,
  qualifying: readonly RirVelocityObservation[],
  points: readonly RirVelocityPoint[],
  sessionCount: number,
): RirVelocityModel {
  const times = qualifying.map((o) => o.performedAt).sort();
  const intensities = qualifying.map((o) => o.relativeIntensity);
  const rirs = points.map((p) => p.rir);
  return {
    form: 'linear',
    version: RIR_VELOCITY_MODEL_VERSION,
    interceptMps: round3(line.intercept),
    slopeMpsPerRir: round3(line.slope),
    r2: round3(line.r2),
    seeMps: round3(line.see),
    rirErrorReps: round2(line.see / line.slope),
    pointCount: points.length,
    setCount: qualifying.length,
    sessionCount,
    rirRange: [Math.min(...rirs), Math.max(...rirs)],
    intensityRange: [round3(Math.min(...intensities)), round3(Math.max(...intensities))],
    anchorSources: {
      failure: qualifying.filter((o) => o.anchorSource === 'failure').length,
      selfReport: qualifying.filter((o) => o.anchorSource === 'self_report').length,
    },
    observedFrom: times[0],
    observedTo: times[times.length - 1],
  };
}

interface Line {
  intercept: number;
  slope: number;
  r2: number;
  /** Residual standard error, with the two fitted parameters spent. */
  see: number;
}

/**
 * Ordinary least squares of `ys` on `xs`. Callers guarantee at least
 * `minPoints` pairs and a non-zero spread in `xs` via
 * {@link firstUnmetMinimum}, so no degenerate case reaches here.
 */
function leastSquares(xs: readonly number[], ys: readonly number[]): Line {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [i, x] of xs.entries()) {
    sxy += (x - meanX) * (ys[i] - meanY);
    sxx += (x - meanX) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const ssRes = residuals.reduce((sum, r) => sum + r * r, 0);
  const ssTot = ys.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
  return {
    intercept,
    slope,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    see: Math.sqrt(ssRes / (n - 2)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Nearest 0.5 — the CI resolution `ExerciseRIREstimate.range` also uses. */
function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}
