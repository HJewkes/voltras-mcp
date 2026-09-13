// Pure analysis functions for the isometric assessment protocol.
//
// This module owns the math + decision logic for `isometric.measure_max`
// and `isometric.measure_imbalance`. Side-effect free: every function takes
// data in, returns data out — no SDK access, no I/O, no timers. The tool
// layer (src/tools/isometric-tools.ts) drives the protocol, captures
// telemetry samples, and calls these helpers to produce the final shape.
//
// Assessment protocol this module implements:
//   * Hold duration: 5s default (clamp 3–10s)
//   * Trials per side: 3 default (clamp 2–5)
//   * Rest between trials (same side): 90s
//   * Rest between sides: 120s
//   * Test non-dominant side first
//   * Trial validity gates (continuous rise, peak after 1s, plateau ≥90% peak)
//   * Reported value: mean PEAK force of the best 2 of 3 trials (VW-271) — peak
//     force is the metric the reliability literature actually validated (ICC
//     0.73-0.99, CV 0.7-11.1%); plateau force stays in the trial record for the
//     validity gate only and is never the headline
//   * RFD and impulse-to-peak are computed per trial as DIAGNOSTIC-ONLY figures
//     (VW-271): early-phase force CV runs 5.5-23.3%, too noisy to monitor change
//   * CV across the best 2 trials (sd / mean × 100)
//   * Asymmetry: (stronger − weaker) / stronger × 100
//   * Asymmetry is REAL only above the athlete's own intra-limb CV (VW-270)
//   * Inferred working weight: 70% of mean peak force, rounded to nearest 5 lb
//   * A per-athlete peak-force baseline (mean + SEM + CV across past test
//     occasions) flags a new result as changed only when it clears the
//     ADJUSTED SEM (SEM × √2) — a single-occasion SEM understates the error in
//     a change score, which carries noise from both occasions (VW-271)

/** A single force sample captured during an isometric trial. */
export interface ForceSample {
  /** Milliseconds since the start of the trial (`0` for the first sample). */
  tMs: number;
  /** Cable force in pounds (converted from the SDK's tenths-of-a-pound frame force). */
  forceLbs: number;
}

/**
 * RFD and impulse-to-peak for one trial (VW-271). DIAGNOSTIC ONLY: Grgic et
 * al. (2022) found early-phase force CV of 5.5-23.3% and Weakley et al. (2024)
 * calls RFD "not recommended" for monitoring change because its variability
 * makes a real change undetectable. Computed for every trial regardless of
 * validity, the same as peak/plateau force.
 */
export interface TrialDiagnostic {
  /** Mean rate of force development from onset to peak: peak force / time-to-peak. */
  rfdLbPerS: number;
  /** Trapezoidal impulse (area under the force-time curve) from onset to peak. */
  impulseLbS: number;
}

/** Per-trial validity outcome and computed metrics. */
export interface TrialAnalysis {
  /** 1-indexed trial number within the side. */
  index: number;
  /** Instantaneous peak force across the entire trial. THE headline metric (VW-271). */
  peakForceLbs: number;
  /** Mean force across the 500 ms window centered on peak. Feeds the plateau validity gate only. */
  plateauForceLbs: number;
  /** Trial-relative milliseconds at which the plateau window starts. */
  plateauStartMs: number;
  /** Trial-relative milliseconds at which the plateau window ends. */
  plateauEndMs: number;
  /** True when all per-trial validity gates pass. */
  valid: boolean;
  /** Set when `valid === false`; explains which gate failed. */
  invalidReason?: string;
  /**
   * RFD and impulse-to-peak; diagnostic-only, see {@link TrialDiagnostic}.
   * Always populated by `analyzeTrial`. Optional only because it is not
   * persisted (VW-271 keeps it out of `StoredIsometricTrial` — it is never
   * used for monitoring, so there is nothing to trend), so a trial
   * reconstituted from storage for recomputation carries none.
   */
  diagnostic?: TrialDiagnostic;
}

/** Aggregate analysis across all trials for one side. */
export interface SideAnalysis {
  trials: TrialAnalysis[];
  validTrialCount: number;
  /** Mean of the best 2 valid trials by peakForceLbs; null if fewer than 2 valid (VW-271). */
  meanPeakForceLbs: number | null;
  /** Coefficient of variation across the 2 best trials' peak forces. */
  cvPct: number | null;
  /**
   * 0.70 × meanPeakForceLbs, rounded to nearest 5 lb and clamped up to the
   * device minimum (5 lb) so it is always a settable target; null when no mean.
   */
  inferredWorkingWeightLbs: number | null;
}

/**
 * The asymmetry equation this test type uses, named in the output.
 *
 * Bishop et al. (2018) showed nine equations are in circulation and that the
 * valid one is chosen by the TEST METHOD, so a percentage with no equation
 * behind it cannot be compared to anything. This protocol tests each limb
 * separately, which is the unilateral case, and the standard percentage
 * difference is its equation: (stronger − weaker) / stronger × 100. It is fixed
 * for this test type and is never a per-call option.
 */
export type AsymmetryEquation = 'standard-percentage-difference';

export const ASYMMETRY_EQUATION: AsymmetryEquation = 'standard-percentage-difference';

/**
 * Which measurement flow produced a stored row (VW-295) — the sole input to
 * {@link asymmetryEquationFor}. Named for the tool's own comparison shape
 * (two slots vs. one), not Bishop et al.'s "unilateral testing method" sense
 * the doc comment above already uses for a different distinction.
 */
export type IsometricTestType = 'bilateral-imbalance' | 'unilateral-max';

/**
 * The equation to stamp on a stored row for a given test type (VW-295) — fixed
 * by test type and never a per-call choice, the same rule `ASYMMETRY_EQUATION`
 * already states for the imbalance verdict. Persisting it lets a future read
 * refuse to compare a percentage against one computed under a different
 * equation.
 *
 * `bilateral-imbalance` (`isometric.measure_imbalance`) runs `computeImbalance`
 * over two sides and reuses `ASYMMETRY_EQUATION`. `unilateral-max`
 * (`isometric.measure_max`) computes no comparison at all — one side, no
 * asymmetry — so there is no equation to name, and this returns `null` rather
 * than a label that would describe nothing.
 */
export function asymmetryEquationFor(testType: IsometricTestType): AsymmetryEquation | null {
  return testType === 'bilateral-imbalance' ? ASYMMETRY_EQUATION : null;
}

/** Which limb produced the higher mean plateau force on one test. */
export type AsymmetryDirection = 'left' | 'right';

/**
 * Asymmetry report between two sides (VW-270).
 *
 * There is no fixed percentage in here. Bishop, de Keijzer, Turner & Beato
 * (2023) is explicit that a between-limb difference counts as real only when it
 * exceeds the intra-limb variability of that same test, and that group-level
 * cutoffs do not transfer to an individual — so the comparison is against the
 * athlete's own trial-to-trial CV from the very trials being compared, and the
 * CV is reported next to the verdict so the reader can see what it was judged
 * against.
 */
export interface ImbalanceReport {
  /** (stronger − weaker) / stronger × 100; null if either side is missing a mean. */
  asymmetryPct: number | null;
  /** The equation `asymmetryPct` came from; fixed for this test type. */
  equation: AsymmetryEquation;
  /** Which limb scored higher; null at an exact tie or when a side has no mean. */
  direction: AsymmetryDirection | null;
  /** Each side's own trial-to-trial CV across the trials that produced its mean. */
  intraLimbCvPct: { left: number | null; right: number | null };
  /**
   * The noise floor `asymmetryPct` was compared against: the HIGHER of the two
   * sides' CVs, because a difference smaller than either limb's own spread is
   * indistinguishable from that spread. Null when a side has no CV.
   */
  noiseFloorCvPct: number | null;
  /** True only when `asymmetryPct` exceeds `noiseFloorCvPct`. */
  real: boolean;
  /** Plain-language statement of what was compared and what it means. */
  interpretation: string;
}

/** One past test's direction, oldest or newest first — `summarizeDirectionHistory` does not care. */
export interface DirectionHistoryEntry {
  measuredAt: string;
  direction: AsymmetryDirection | null;
}

/** Whether limb dominance held across repeated tests (VW-270). */
export interface DirectionHistory {
  label: 'consistent-left' | 'consistent-right' | 'fluctuating' | 'insufficient-history';
  /** Tests that produced a direction at all; tests with no direction are not counted. */
  testsCompared: number;
  /** Share of `testsCompared` that agreed with the most common direction, or null. */
  agreementPct: number | null;
  /** The directions compared, newest first. */
  directions: AsymmetryDirection[];
  interpretation: string;
}

/**
 * Tests with a direction needed before dominance can be called consistent or
 * fluctuating. Two tests agreeing is a coin flip; Bishop et al. (2019) measured
 * limb dominance re-agreement as fair-to-substantial, never assured, so the
 * answer below this count is "not enough history", not a verdict.
 */
const MIN_TESTS_FOR_DIRECTION_LABEL = 3;

/** Window length (ms) used for the plateau-around-peak mean force calculation. */
const PLATEAU_WINDOW_MS = 500;

/**
 * Trials with peak before this time fail the "peak after first second" gate.
 * Exported because it is also the ramp-up window the tool layer signals over:
 * the `isometric_phase` `hold` push fires at the moment a peak first counts.
 */
export const PEAK_AFTER_MS = 1000;

/** Plateau mean must be at least this fraction of instantaneous peak. */
const PLATEAU_PEAK_RATIO = 0.9;

/** A trial whose peak is more than this CV vs. session mean is discarded. */
const SESSION_OUTLIER_CV_THRESHOLD = 15;

/** Inferred working weight ratio (70% for untrained / first session). */
const WORKING_WEIGHT_RATIO = 0.7;

/** Rounding step for inferred working weight (lbs). */
const WORKING_WEIGHT_ROUND_STEP = 5;

/**
 * Device firmware floor for a settable weight (lbs). `device.set_weight`
 * rejects anything below this (see DeviceSetWeightInput / SDK clamp), so a
 * low plateau that rounds to 0 must be clamped up — otherwise the
 * isometric→programming handoff emits a target the device cannot accept.
 */
const DEVICE_MIN_WORKING_WEIGHT_LBS = 5;

/**
 * Analyze a single trial's force samples against the per-trial validity
 * gates. Pure: same input always yields the same output.
 *
 * Validity gates:
 *   1. At least one sample (otherwise empty / no force at all).
 *   2. Force rises continuously from onset (no decreasing run before peak).
 *   3. Peak force occurs after the first second of the hold.
 *   4. The 500 ms plateau window centered on peak averages ≥ 90% of peak.
 */
export function analyzeTrial(samples: ForceSample[], index: number): TrialAnalysis {
  if (samples.length === 0) {
    return {
      index,
      peakForceLbs: 0,
      plateauForceLbs: 0,
      plateauStartMs: 0,
      plateauEndMs: 0,
      valid: false,
      invalidReason: 'no samples captured',
      diagnostic: { rfdLbPerS: 0, impulseLbS: 0 },
    };
  }

  let peakIdx = 0;
  let peakForce = samples[0].forceLbs;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].forceLbs > peakForce) {
      peakForce = samples[i].forceLbs;
      peakIdx = i;
    }
  }
  const diagnostic = computeDiagnostic(samples, peakIdx);

  const peakAtMs = samples[peakIdx].tMs;
  const halfWindow = PLATEAU_WINDOW_MS / 2;
  const plateauStartMs = peakAtMs - halfWindow;
  const plateauEndMs = peakAtMs + halfWindow;

  let sum = 0;
  let count = 0;
  for (const s of samples) {
    if (s.tMs >= plateauStartMs && s.tMs <= plateauEndMs) {
      sum += s.forceLbs;
      count += 1;
    }
  }
  const plateauForce = count > 0 ? sum / count : peakForce;

  // Gate 2: continuous rise from onset. Permit small noise dips by checking
  // the prefix of samples up to the peak — every value should be ≥ the prior
  // sample (within a small tolerance) to count as a continuous pull.
  const riseTolerance = Math.max(0.5, peakForce * 0.02);
  for (let i = 1; i <= peakIdx; i++) {
    if (samples[i].forceLbs < samples[i - 1].forceLbs - riseTolerance) {
      return {
        index,
        peakForceLbs: peakForce,
        plateauForceLbs: plateauForce,
        plateauStartMs,
        plateauEndMs,
        valid: false,
        invalidReason: 'force did not rise continuously from onset',
        diagnostic,
      };
    }
  }

  // Gate 3: peak after the first second.
  if (peakAtMs < PEAK_AFTER_MS) {
    return {
      index,
      peakForceLbs: peakForce,
      plateauForceLbs: plateauForce,
      plateauStartMs,
      plateauEndMs,
      valid: false,
      invalidReason: `peak occurred at ${peakAtMs}ms (expected > ${PEAK_AFTER_MS}ms)`,
      diagnostic,
    };
  }

  // Gate 4: plateau ≥ 90% of peak.
  if (peakForce > 0 && plateauForce / peakForce < PLATEAU_PEAK_RATIO) {
    return {
      index,
      peakForceLbs: peakForce,
      plateauForceLbs: plateauForce,
      plateauStartMs,
      plateauEndMs,
      valid: false,
      invalidReason: `plateau ${plateauForce.toFixed(1)} lb below 90% of peak ${peakForce.toFixed(1)} lb`,
      diagnostic,
    };
  }

  return {
    index,
    peakForceLbs: peakForce,
    plateauForceLbs: plateauForce,
    plateauStartMs,
    plateauEndMs,
    valid: true,
    diagnostic,
  };
}

/**
 * RFD and impulse from onset (`samples[0]`) to `peakIdx`, trapezoidal (VW-271).
 * Pure and gate-independent: computed the same way whether the trial ends up
 * valid or not, exactly like peak/plateau force above it.
 */
function computeDiagnostic(samples: ForceSample[], peakIdx: number): TrialDiagnostic {
  const onset = samples[0];
  const peak = samples[peakIdx];
  const riseMs = peak.tMs - onset.tMs;
  const rfdLbPerS = riseMs > 0 ? (peak.forceLbs - onset.forceLbs) / (riseMs / 1000) : 0;

  let impulseLbMs = 0;
  for (let i = 1; i <= peakIdx; i++) {
    const dtMs = samples[i].tMs - samples[i - 1].tMs;
    const avgForceLbs = (samples[i].forceLbs + samples[i - 1].forceLbs) / 2;
    impulseLbMs += avgForceLbs * dtMs;
  }
  return { rfdLbPerS, impulseLbS: impulseLbMs / 1000 };
}

/**
 * Aggregate per-trial analyses into the side-level summary. Picks the best
 * 2 valid trials by PEAK force (VW-271 — peak, not plateau, is the metric the
 * reliability literature validated), computes their mean and CV, and infers
 * a starting working weight.
 *
 * Session-level outlier discard (CV > 15% vs. session mean) is applied
 * BEFORE the best-2 selection so a trial with a wildly different peak gets
 * marked invalid in the returned trial array.
 */
export function aggregateSide(trials: TrialAnalysis[]): SideAnalysis {
  // Apply the session-mean CV gate to peakForce across all currently-valid
  // trials. A trial whose peak diverges by > 15% from the mean of the OTHER
  // trials (leave-one-out) is re-marked invalid before the best-2 pick.
  // Leave-one-out comparison avoids the case where a single outlier biases
  // the session mean enough to mark the genuine trials as outliers too.
  const filtered = trials.map((t) => ({ ...t }));
  const validForGate = filtered.filter((t) => t.valid);
  if (validForGate.length >= 3) {
    // Compare each trial's peak to the MEDIAN of the valid set. Median is
    // robust to a single wild outlier — a 50/200/200 set has median 200,
    // so the 50 is correctly flagged while the two 200s sit on the median.
    // Per the brief: "Trials with CV > 15% vs. session mean are discarded;
    // max 4 trials per side." We use median-divergence as the practical
    // robust-to-outliers proxy for "vs. session mean."
    const peakMedian = median(validForGate.map((t) => t.peakForceLbs));
    if (peakMedian > 0) {
      for (const t of filtered) {
        if (!t.valid) continue;
        const divergencePct = (Math.abs(t.peakForceLbs - peakMedian) / peakMedian) * 100;
        if (divergencePct > SESSION_OUTLIER_CV_THRESHOLD) {
          t.valid = false;
          t.invalidReason = `peak ${t.peakForceLbs.toFixed(1)} lb diverges ${divergencePct.toFixed(1)}% from session median ${peakMedian.toFixed(1)} lb`;
        }
      }
    }
  }

  const validTrials = filtered.filter((t) => t.valid);
  const validTrialCount = validTrials.length;
  if (validTrialCount < 2) {
    return {
      trials: filtered,
      validTrialCount,
      meanPeakForceLbs: null,
      cvPct: null,
      inferredWorkingWeightLbs: null,
    };
  }

  const sorted = [...validTrials].sort((a, b) => b.peakForceLbs - a.peakForceLbs);
  const best2 = [sorted[0].peakForceLbs, sorted[1].peakForceLbs];
  const meanPeak = mean(best2);
  const cvPct = coefficientOfVariation(best2);
  const inferredWorkingWeightLbs = Math.max(
    DEVICE_MIN_WORKING_WEIGHT_LBS,
    roundToStep(meanPeak * WORKING_WEIGHT_RATIO, WORKING_WEIGHT_ROUND_STEP),
  );

  return {
    trials: filtered,
    validTrialCount,
    meanPeakForceLbs: meanPeak,
    cvPct,
    inferredWorkingWeightLbs,
  };
}

/** What one side contributes to the asymmetry verdict. */
export interface ImbalanceSideInput {
  meanPeakForceLbs: number | null;
  cvPct: number | null;
}

/**
 * Compute the asymmetry report between two sides (VW-270). Sides are labeled
 * 'left' / 'right' by the caller; the math is symmetric.
 *
 * The verdict is `real` only when the between-limb percentage exceeds the
 * athlete's own intra-limb CV on the same test (Bishop et al., 2023). That
 * replaces the fixed 10%/15% pair this function used to apply: a 12% difference
 * on a limb whose own trials vary by 14% is a measurement, not a capacity gap,
 * and the old constants could not tell those apart.
 *
 * When either side lacks a mean (fewer than 2 valid trials), `asymmetryPct` is
 * null and there is no verdict to give — `real` is false because nothing was
 * shown, which is not the same as a difference shown to be absent.
 */
export function computeImbalance(
  left: ImbalanceSideInput,
  right: ImbalanceSideInput,
): ImbalanceReport {
  const intraLimbCvPct = { left: left.cvPct, right: right.cvPct };
  const lMean = left.meanPeakForceLbs;
  const rMean = right.meanPeakForceLbs;
  if (lMean === null || rMean === null) {
    const missing =
      lMean === null ? (rMean === null ? 'both sides' : 'the left side') : 'the right side';
    return {
      asymmetryPct: null,
      equation: ASYMMETRY_EQUATION,
      direction: null,
      intraLimbCvPct,
      noiseFloorCvPct: null,
      real: false,
      interpretation: `No asymmetry verdict: ${missing} produced fewer than 2 valid trials, so there is no mean to compare.`,
    };
  }

  const stronger = Math.max(lMean, rMean);
  const weaker = Math.min(lMean, rMean);
  const asymmetryPct = stronger > 0 ? ((stronger - weaker) / stronger) * 100 : 0;
  const direction: AsymmetryDirection | null =
    lMean === rMean ? null : lMean > rMean ? 'left' : 'right';
  const noiseFloorCvPct = higherCv(left.cvPct, right.cvPct);

  if (noiseFloorCvPct === null) {
    return {
      asymmetryPct,
      equation: ASYMMETRY_EQUATION,
      direction,
      intraLimbCvPct,
      noiseFloorCvPct: null,
      real: false,
      interpretation: `Asymmetry ${asymmetryPct.toFixed(1)}% measured, but at least one side has no trial-to-trial CV to judge it against, so it is not called real.`,
    };
  }

  const real = asymmetryPct > noiseFloorCvPct;
  const side = direction ?? 'neither side';
  const interpretation = real
    ? `Asymmetry ${asymmetryPct.toFixed(1)}% exceeds this athlete's own intra-limb CV of ${noiseFloorCvPct.toFixed(1)}% on the same test, so it is larger than the measurement's own spread. ${side === 'neither side' ? '' : `${side} produced more force. `}Direction across repeated tests is the interpretable signal; a single test is not.`
    : `Asymmetry ${asymmetryPct.toFixed(1)}% sits within this athlete's own intra-limb CV of ${noiseFloorCvPct.toFixed(1)}% on the same test, so it cannot be distinguished from trial-to-trial variation.`;

  return {
    asymmetryPct,
    equation: ASYMMETRY_EQUATION,
    direction,
    intraLimbCvPct,
    noiseFloorCvPct,
    real,
    interpretation,
  };
}

/**
 * Label limb dominance across repeated tests (VW-270).
 *
 * Direction, not magnitude, is what a series of asymmetry tests can support.
 * Bishop et al. (2019) re-tested limb dominance and found agreement only
 * fair-to-substantial (isometric squat peak force K = 0.64, impulse K = 0.29),
 * so one test's percentage says little while the same limb dominating every
 * time says something. `agreementPct` is that Kappa-style agreement in its
 * simplest honest form: the share of tests that named the most common limb.
 *
 * `consistent-*` requires UNANIMITY, not a majority. Two of three agreeing is
 * close to what a coin produces, and this label is read as a reason to look
 * closer at one limb.
 */
export function summarizeDirectionHistory(
  entries: readonly DirectionHistoryEntry[],
): DirectionHistory {
  const directions = [...entries]
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
    .map((e) => e.direction)
    .filter((d): d is AsymmetryDirection => d !== null);

  const testsCompared = directions.length;
  if (testsCompared < MIN_TESTS_FOR_DIRECTION_LABEL) {
    return {
      label: 'insufficient-history',
      testsCompared,
      agreementPct: null,
      directions,
      interpretation: `${testsCompared} test(s) with a direction; ${MIN_TESTS_FOR_DIRECTION_LABEL} are needed before limb dominance can be called consistent or fluctuating.`,
    };
  }

  const leftCount = directions.filter((d) => d === 'left').length;
  const rightCount = testsCompared - leftCount;
  const modalCount = Math.max(leftCount, rightCount);
  const agreementPct = (modalCount / testsCompared) * 100;

  if (modalCount === testsCompared) {
    const side = leftCount === testsCompared ? 'left' : 'right';
    return {
      label: side === 'left' ? 'consistent-left' : 'consistent-right',
      testsCompared,
      agreementPct,
      directions,
      interpretation: `The ${side} limb dominated all ${testsCompared} tests. A consistent direction over time may warrant a closer look at that limb; it is still not, on its own, a reason to prescribe corrective work.`,
    };
  }

  return {
    label: 'fluctuating',
    testsCompared,
    agreementPct,
    directions,
    interpretation: `Dominance changed limbs across ${testsCompared} tests (${agreementPct.toFixed(0)}% agreement with the more common side). A fluctuating direction is normal between-session variation and does not warrant attention.`,
  };
}

/**
 * Direction of one stored measurement, for the history series. Structurally
 * typed over the stored shape so this module keeps no dependency on the store.
 *
 * Recomputed from the persisted per-trial forces rather than read from a stored
 * verdict, for the reason the store's own note gives: a frozen verdict becomes
 * indistinguishable from a fresh one the day the rules move, and these rules
 * just moved.
 */
export function directionOfMeasurement(measurement: {
  sides: readonly { side?: string | undefined; trials: readonly TrialAnalysis[] }[];
}): AsymmetryDirection | null {
  const sideOf = (side: 'left' | 'right'): ImbalanceSideInput => {
    const stored = measurement.sides.find((s) => s.side === side);
    if (stored === undefined) return { meanPeakForceLbs: null, cvPct: null };
    const analysis = aggregateSide(stored.trials.map((t) => ({ ...t })));
    return { meanPeakForceLbs: analysis.meanPeakForceLbs, cvPct: analysis.cvPct };
  };
  return computeImbalance(sideOf('left'), sideOf('right')).direction;
}

function higherCv(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.max(left, right);
}

/**
 * Test occasions required before a peak-force baseline is established
 * (VW-271). Two occasions can only agree or disagree; three is the floor for
 * a variance-based spread, matching {@link MIN_TESTS_FOR_DIRECTION_LABEL}'s
 * reasoning.
 */
export const MIN_TESTS_FOR_PEAK_FORCE_BASELINE = 3;

/**
 * A per-athlete peak-force baseline derived from past test occasions
 * (VW-271). `semLbs` is the between-occasion standard deviation of this
 * athlete's own mean-peak-force results — a practical single-subject
 * stand-in for a measurement-theory SEM, which needs a controlled test-retest
 * reliability study this rig has never run. `cvPct` is the same spread
 * relative to the mean, comparable to the published between-day CV
 * references (IMTP peak force ~3.5%, Weakley et al. 2024).
 */
export interface PeakForceBaseline {
  sampleSize: number;
  meanLbs: number;
  semLbs: number;
  cvPct: number;
}

/**
 * Derive a peak-force baseline from past occasion means. `null` below
 * {@link MIN_TESTS_FOR_PEAK_FORCE_BASELINE} occasions or a non-positive mean —
 * not enough history to say what this athlete's own spread is.
 */
export function computePeakForceBaseline(
  occasionPeakForcesLbs: readonly number[],
): PeakForceBaseline | null {
  if (occasionPeakForcesLbs.length < MIN_TESTS_FOR_PEAK_FORCE_BASELINE) return null;
  const values = [...occasionPeakForcesLbs];
  const meanLbs = mean(values);
  if (meanLbs <= 0) return null;
  const semLbs = sampleStandardDeviation(values, meanLbs);
  return { sampleSize: values.length, meanLbs, semLbs, cvPct: (semLbs / meanLbs) * 100 };
}

/**
 * Whether a new peak-force result is distinguishable from this athlete's own
 * baseline noise (VW-271). The threshold is the ADJUSTED SEM — SEM × √2, per
 * Weakley et al. (2024) — because a change score carries measurement error
 * from BOTH occasions being compared, not just the new one.
 */
export interface PeakForceChangeVerdict {
  changed: boolean;
  deltaLbs: number;
  thresholdLbs: number;
  interpretation: string;
}

export function evaluatePeakForceChange(
  currentPeakLbs: number,
  baseline: PeakForceBaseline,
): PeakForceChangeVerdict {
  const thresholdLbs = baseline.semLbs * Math.SQRT2;
  const deltaLbs = currentPeakLbs - baseline.meanLbs;
  const changed = Math.abs(deltaLbs) > thresholdLbs;
  const interpretation = changed
    ? `Peak force ${currentPeakLbs.toFixed(1)} lb differs from this athlete's baseline mean ` +
      `${baseline.meanLbs.toFixed(1)} lb (n=${baseline.sampleSize}) by ${Math.abs(deltaLbs).toFixed(1)} lb, ` +
      `which exceeds the adjusted SEM (SEM x sqrt(2) = ${thresholdLbs.toFixed(1)} lb) — likely a real ` +
      'change, not measurement noise.'
    : `Peak force ${currentPeakLbs.toFixed(1)} lb is within ${thresholdLbs.toFixed(1)} lb (the adjusted ` +
      `SEM, SEM x sqrt(2)) of this athlete's baseline mean ${baseline.meanLbs.toFixed(1)} lb ` +
      `(n=${baseline.sampleSize}), so it cannot be distinguished from trial-to-trial variation.`;
  return { changed, deltaLbs, thresholdLbs, interpretation };
}

/**
 * Pooled per-side mean peak forces from stored isometric measurements, one
 * value per side per occasion that had a mean at all (VW-271).
 *
 * SCOPE LIMIT, same as {@link summarizeDirectionHistory}: `isometric_measurements`
 * carries no lifter, exercise or session key, so this pools every occasion in
 * the database, not this lifter tested on this joint. Callers must say so.
 */
export function occasionPeakForcesLbs(
  measurements: readonly { sides: readonly { trials: readonly TrialAnalysis[] }[] }[],
): number[] {
  const peaks: number[] = [];
  for (const measurement of measurements) {
    for (const side of measurement.sides) {
      const analysis = aggregateSide(side.trials.map((t) => ({ ...t })));
      if (analysis.meanPeakForceLbs !== null) peaks.push(analysis.meanPeakForceLbs);
    }
  }
  return peaks;
}

/**
 * Decide which side to test first given the dominance hint and whether the
 * caller wants non-dominant first. Returns the test order as an ordered
 * pair of side labels. Defaults to `[primary, secondary]`; when
 * `testNonDominantFirst` is true and the secondary side IS the
 * non-dominant side, swap so the non-dominant side (secondary) goes first.
 */
export function decideTestOrder(
  primarySide: 'left' | 'right',
  secondarySide: 'left' | 'right',
  testNonDominantFirst: boolean,
  dominantSide: 'left' | 'right' | 'unknown',
): ['left' | 'right', 'left' | 'right'] {
  if (!testNonDominantFirst || dominantSide === 'unknown') {
    return [primarySide, secondarySide];
  }
  // Non-dominant = whichever side ≠ dominantSide. If the primary side is
  // the dominant side, swap so secondary (the non-dominant) goes first.
  if (primarySide === dominantSide) {
    return [secondarySide, primarySide];
  }
  return [primarySide, secondarySide];
}

/**
 * The joint angle at which an exercise's DYNAMIC form peaks force, for the
 * exercises this table actually covers (VW-296). An isometric hold measures
 * one angle; what it predicts about the dynamic lift depends heavily on
 * whether that was the RIGHT angle — Lum, Haff & Barbosa (2020, Sports 8(5):63)
 * found an isometric squat predicted the full squat at r=0.864 held at 90
 * degrees of knee flexion, but only r=0.597 held at 120 degrees.
 *
 * DELIBERATELY SPARSE: the brief for this table is "the catalog's compound
 * lifts", not "every exercise", and a made-up angle is worse than an admitted
 * gap — {@link evaluateJointAngleGate} treats an exercise absent here exactly
 * like an unrecognised id, `angle_unverified`, never a silent pass. Extend
 * this table only from a cited source, the same standard the squat entry
 * meets.
 */
export interface ExercisePeakAngle {
  /** Degrees of joint flexion at which the exercise's dynamic form peaks force. */
  jointAngleDeg: number;
  /** The joint the angle is measured at (e.g. `'knee'`). */
  joint: string;
  /** Where `jointAngleDeg` comes from, quoted wherever the gate reports it. */
  citation: string;
}

export const EXERCISE_PEAK_ANGLES: Readonly<Partial<Record<string, ExercisePeakAngle>>> = {
  'cable-squat': {
    jointAngleDeg: 90,
    joint: 'knee',
    citation: 'Lum, Haff & Barbosa 2020, Sports 8(5):63',
  },
};

/**
 * How far a declared setup angle may sit from the exercise's known peak angle
 * before the two are judged a MATERIALLY different angle (VW-296).
 *
 * NOT read off {@link EXERCISE_PEAK_ANGLES}'s own citation: Lum et al. (2020)
 * compared exactly two angles, 90 and 120 degrees, 30 degrees apart, and found
 * the correlation had already dropped from a strong r=0.864 to a moderate
 * r=0.597 by then — evidence that SOME gap in that range matters, not a
 * measured threshold for where it starts. This value is a heuristic pending a
 * study with more than two angles to interpolate between; it sits inside that
 * 30-degree gap deliberately, so a hold near either published angle reads as
 * a match and one drifting toward the other reads as a mismatch.
 */
export const JOINT_ANGLE_MISMATCH_THRESHOLD_DEG = 15;

/** Whether a declared setup angle may be read against an exercise's known peak angle. */
export type JointAngleComparability = 'comparable' | 'angle_mismatch' | 'angle_unverified';

/** The joint-angle gate's answer: a verdict, why, and what it compared. */
export interface JointAngleGateVerdict {
  comparability: JointAngleComparability;
  reason: string;
  /** The exercise's known peak angle, or `null` when the gate could not look one up. */
  exercisePeakAngleDeg: number | null;
  /** The caller's declared setup angle, or `null` when none was given. */
  setupAngleDeg: number | null;
  /** `Math.abs(setupAngleDeg - exercisePeakAngleDeg)`, or `null` when either side is missing. */
  deltaDeg: number | null;
}

/**
 * Whether a hold's declared setup angle matches the angle its exercise's
 * dynamic form actually peaks at (VW-296).
 *
 * DEGRADE, NEVER REFUSE SILENTLY, the same posture {@link compareSetupSignatures}
 * takes on the equivalent cable-geometry question: no `exerciseId`, an
 * exercise absent from {@link EXERCISE_PEAK_ANGLES}, or no `setupAngleDeg`
 * are each `angle_unverified` — the gate did not run — never treated as a
 * match or a mismatch.
 */
export function evaluateJointAngleGate(
  exerciseId: string | undefined,
  setupAngleDeg: number | undefined,
): JointAngleGateVerdict {
  const declaredSetupAngleDeg = setupAngleDeg ?? null;
  if (exerciseId === undefined) {
    return {
      comparability: 'angle_unverified',
      reason:
        'no exerciseId was given, so there is no dynamic peak angle to check the setup against',
      exercisePeakAngleDeg: null,
      setupAngleDeg: declaredSetupAngleDeg,
      deltaDeg: null,
    };
  }
  const known = EXERCISE_PEAK_ANGLES[exerciseId];
  if (known === undefined) {
    return {
      comparability: 'angle_unverified',
      reason: `no known peak-force joint angle for exercise "${exerciseId}" — the angle gate did not run`,
      exercisePeakAngleDeg: null,
      setupAngleDeg: declaredSetupAngleDeg,
      deltaDeg: null,
    };
  }
  if (setupAngleDeg === undefined) {
    return {
      comparability: 'angle_unverified',
      reason:
        `"${exerciseId}" peaks at ${known.jointAngleDeg} degrees of ${known.joint} flexion ` +
        `(${known.citation}), but no setupAngleDeg was given to check the current setup against it`,
      exercisePeakAngleDeg: known.jointAngleDeg,
      setupAngleDeg: null,
      deltaDeg: null,
    };
  }
  const deltaDeg = Math.abs(setupAngleDeg - known.jointAngleDeg);
  if (deltaDeg > JOINT_ANGLE_MISMATCH_THRESHOLD_DEG) {
    return {
      comparability: 'angle_mismatch',
      reason:
        `setup angle ${setupAngleDeg} degrees is ${deltaDeg.toFixed(1)} degrees from "${exerciseId}"'s ` +
        `known peak-force angle, ${known.jointAngleDeg} degrees of ${known.joint} flexion ` +
        `(${known.citation}) — a hold at this setup measures a materially different angle than the one ` +
        'that predicts the dynamic lift',
      exercisePeakAngleDeg: known.jointAngleDeg,
      setupAngleDeg,
      deltaDeg,
    };
  }
  return {
    comparability: 'comparable',
    reason:
      `setup angle ${setupAngleDeg} degrees is within ${JOINT_ANGLE_MISMATCH_THRESHOLD_DEG} degrees of ` +
      `"${exerciseId}"'s known peak-force angle, ${known.jointAngleDeg} degrees of ${known.joint} ` +
      `flexion (${known.citation})`,
    exercisePeakAngleDeg: known.jointAngleDeg,
    setupAngleDeg,
    deltaDeg,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function coefficientOfVariation(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  if (m === 0) return 0;
  return (sampleStandardDeviation(xs, m) / m) * 100;
}

/** Sample standard deviation (n-1) when n>1; 0 for a single value. */
function sampleStandardDeviation(xs: number[], m: number): number {
  let sqSum = 0;
  for (const x of xs) {
    const d = x - m;
    sqSum += d * d;
  }
  const variance = xs.length > 1 ? sqSum / (xs.length - 1) : 0;
  return Math.sqrt(variance);
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
