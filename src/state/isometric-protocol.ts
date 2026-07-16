// Pure analysis functions for the isometric assessment protocol.
//
// This module owns the math + decision logic for `isometric.measure_max`
// and `isometric.measure_imbalance`. Side-effect free: every function takes
// data in, returns data out — no SDK access, no I/O, no timers. The tool
// layer (src/tools/isometric-tools.ts) drives the protocol, captures
// telemetry samples, and calls these helpers to produce the final shape.
//
// Protocol references — coordination/research/isometric-protocol-2026-05-09.md:
//   * Hold duration: 5s default (clamp 3–10s)
//   * Trials per side: 3 default (clamp 2–5)
//   * Rest between trials (same side): 90s
//   * Rest between sides: 120s
//   * Test non-dominant side first
//   * Trial validity gates (continuous rise, peak after 1s, plateau ≥90% peak)
//   * Reported value: mean plateau force of the best 2 of 3 trials
//   * CV across the best 2 trials (sd / mean × 100)
//   * Asymmetry: (stronger − weaker) / stronger × 100
//   * Flagged ≥ 10%; meaningful ≥ 15%
//   * Inferred working weight: 70% of mean plateau, rounded to nearest 5 lb

/** A single force sample captured during an isometric trial. */
export interface ForceSample {
  /** Milliseconds since the start of the trial (`0` for the first sample). */
  tMs: number;
  /** Cable force in pounds (converted from the SDK's tenths-of-a-pound frame force). */
  forceLbs: number;
}

/** Per-trial validity outcome and computed metrics. */
export interface TrialAnalysis {
  /** 1-indexed trial number within the side. */
  index: number;
  /** Instantaneous peak force across the entire trial. */
  peakForceLbs: number;
  /** Mean force across the 500 ms window centered on peak. */
  plateauForceLbs: number;
  /** Trial-relative milliseconds at which the plateau window starts. */
  plateauStartMs: number;
  /** Trial-relative milliseconds at which the plateau window ends. */
  plateauEndMs: number;
  /** True when all per-trial validity gates pass. */
  valid: boolean;
  /** Set when `valid === false`; explains which gate failed. */
  invalidReason?: string;
}

/** Aggregate analysis across all trials for one side. */
export interface SideAnalysis {
  trials: TrialAnalysis[];
  validTrialCount: number;
  /** Mean of the best 2 valid trials by plateauForceLbs; null if fewer than 2 valid. */
  meanPlateauForceLbs: number | null;
  /** Coefficient of variation across the 2 best trials' plateau forces. */
  cvPct: number | null;
  /**
   * 0.70 × meanPlateauForceLbs, rounded to nearest 5 lb and clamped up to the
   * device minimum (5 lb) so it is always a settable target; null when no mean.
   */
  inferredWorkingWeightLbs: number | null;
}

/** Asymmetry report between two sides. */
export interface ImbalanceReport {
  /** (stronger − weaker) / stronger × 100; null if either side missing a mean. */
  asymmetryPct: number | null;
  /** Which side scored higher; 'tie' when within 1% of each other. */
  strongerSide: 'left' | 'right' | 'tie' | null;
  /** True when asymmetryPct >= 10 (noteworthy). */
  flagged: boolean;
  /** True when asymmetryPct >= 15 (meaningful). */
  meaningful: boolean;
}

/** Window length (ms) used for the plateau-around-peak mean force calculation. */
const PLATEAU_WINDOW_MS = 500;

/** Trials with peak before this time fail the "peak after first second" gate. */
const PEAK_AFTER_MS = 1000;

/** Plateau mean must be at least this fraction of instantaneous peak. */
const PLATEAU_PEAK_RATIO = 0.9;

/** A trial whose peak is more than this CV vs. session mean is discarded. */
const SESSION_OUTLIER_CV_THRESHOLD = 15;

/** Asymmetry threshold (%) for flagging as noteworthy. */
const ASYMMETRY_FLAGGED_PCT = 10;

/** Asymmetry threshold (%) for flagging as a meaningful deficit. */
const ASYMMETRY_MEANINGFUL_PCT = 15;

/** Within this absolute %, the two sides are reported as a tie. */
const ASYMMETRY_TIE_PCT = 1;

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
    };
  }

  return {
    index,
    peakForceLbs: peakForce,
    plateauForceLbs: plateauForce,
    plateauStartMs,
    plateauEndMs,
    valid: true,
  };
}

/**
 * Aggregate per-trial analyses into the side-level summary. Picks the best
 * 2 valid trials by plateau force, computes their mean and CV, and infers
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
      meanPlateauForceLbs: null,
      cvPct: null,
      inferredWorkingWeightLbs: null,
    };
  }

  const sorted = [...validTrials].sort((a, b) => b.plateauForceLbs - a.plateauForceLbs);
  const best2 = [sorted[0].plateauForceLbs, sorted[1].plateauForceLbs];
  const meanPlateau = mean(best2);
  const cvPct = coefficientOfVariation(best2);
  const inferredWorkingWeightLbs = Math.max(
    DEVICE_MIN_WORKING_WEIGHT_LBS,
    roundToStep(meanPlateau * WORKING_WEIGHT_RATIO, WORKING_WEIGHT_ROUND_STEP),
  );

  return {
    trials: filtered,
    validTrialCount,
    meanPlateauForceLbs: meanPlateau,
    cvPct,
    inferredWorkingWeightLbs,
  };
}

/**
 * Compute the asymmetry report between two sides. Sides are labeled
 * 'left' / 'right' by the caller; the math is symmetric.
 *
 * Tie semantics: when both sides have a valid mean and the absolute
 * asymmetry is within 1%, `strongerSide` is 'tie'. Otherwise the side
 * with the higher mean wins.
 *
 * When either side lacks a mean (validTrialCount < 2), `asymmetryPct` is
 * null and `strongerSide` is null.
 */
export function computeImbalance(
  left: { meanPlateauForceLbs: number | null },
  right: { meanPlateauForceLbs: number | null },
): ImbalanceReport {
  const lMean = left.meanPlateauForceLbs;
  const rMean = right.meanPlateauForceLbs;
  if (lMean === null || rMean === null) {
    return {
      asymmetryPct: null,
      strongerSide: null,
      flagged: false,
      meaningful: false,
    };
  }
  const stronger = Math.max(lMean, rMean);
  const weaker = Math.min(lMean, rMean);
  const asymmetryPct = stronger > 0 ? ((stronger - weaker) / stronger) * 100 : 0;
  let strongerSide: 'left' | 'right' | 'tie';
  if (asymmetryPct <= ASYMMETRY_TIE_PCT) {
    strongerSide = 'tie';
  } else {
    strongerSide = lMean > rMean ? 'left' : 'right';
  }
  return {
    asymmetryPct,
    strongerSide,
    flagged: asymmetryPct >= ASYMMETRY_FLAGGED_PCT,
    meaningful: asymmetryPct >= ASYMMETRY_MEANINGFUL_PCT,
  };
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
  let sqSum = 0;
  for (const x of xs) {
    const d = x - m;
    sqSum += d * d;
  }
  // Sample standard deviation (n-1) when n>1; fallback to 0 otherwise.
  const variance = xs.length > 1 ? sqSum / (xs.length - 1) : 0;
  const sd = Math.sqrt(variance);
  return (sd / m) * 100;
}

function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
