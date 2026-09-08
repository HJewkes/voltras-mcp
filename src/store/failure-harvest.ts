// Failure-anchor harvest filter (VW-174 / B59).
//
// HARVEST, NEVER PRESCRIBE.
// -------------------------
// The product does not ask anyone to train to failure. §1.3 of the RP review
// puts the training benefit of true failure at trivial-to-nil (ES 0.12, CI
// crossing zero), so prescribing it would buy approximately nothing at real
// risk, for our model's convenience. What this module does instead is LABEL a
// failure that already happened, retrospectively, from reps that were recorded
// anyway. Nothing here reads as a recommendation, and nothing downstream may
// turn a harvested anchor into a streak, a badge, or a target.
//
// THE HAZARD: INJURY LOOKS LIKE FAILURE.
// --------------------------------------
// A lifter cutting a set short because something hurt produces a short-ROM
// termination that matches a naive stall criterion exactly — and yields a
// spuriously FAST anchor, which then tells them they have reps left when they
// do not. That is the one failure direction the protocol calls dangerous, so
// the decay trajectory is a HARD FILTER, not a weight: a candidate with no
// plausible preceding velocity decay is stored as `'abort'` and never counts.
//
// PURE. Every input is an already-fetched row; nothing here touches the DB,
// the device, or the clock.

import { getPhaseMeanVelocity, getRepRangeOfMotion, type Rep } from '@voltras/workout-analytics';

import { setPurposeOf } from './set-purpose.js';
import type { SetPurpose, StoredSet } from './types.js';
import { normaliseVelocityToMps } from './velocity-units.js';

/**
 * Version stamped onto every anchor this filter writes, and the identity of
 * the threshold block below. Bump on ANY threshold or rule change: a stored
 * verdict is only interpretable against the rules that produced it, and a new
 * version adds a row beside the old one rather than overwriting history.
 */
export const FAILURE_FILTER_VERSION = 'failure-harvest@1.0.0';

/**
 * Criterion v1. Every threshold carries the one line that justifies it; none
 * of them is a round number picked for looking tidy.
 */
export const HARVEST_THRESHOLDS = {
  /**
   * Reps a set needs before it can be a candidate at all. Matches the shape
   * floor in `exercise-baselines.ts` for the same reason: below four reps
   * there is no velocity-decay trajectory to read, only noise.
   */
  minReps: 4,
  /**
   * Final-rep concentric velocity, as a fraction of the set's fastest
   * non-first rep, at or below which the set stalled. 0.70 is a 30 % velocity
   * loss — the proximity-to-failure band VBT work uses for cable/compound
   * movements, and the point past which the next rep is genuinely in doubt.
   */
  stallFraction: 0.7,
  /**
   * Reps of trajectory the failure verdict requires. One slow rep is noise;
   * three consecutive non-increasing reps are a lifter running out of rope.
   */
  decayWindow: 3,
  /**
   * Rep-to-rep noise allowed inside the decay window, as a fraction. BLE
   * telemetry and honest rep-to-rep variation produce small upticks inside a
   * real decay; 5 % keeps those from vetoing a genuine trajectory without
   * admitting a set that actually sped back up.
   */
  decayTolerance: 0.05,
  /**
   * How far the final rep's ROM may fall below the set's median before the
   * termination reads as cut short rather than ground out. A true failure rep
   * is slow but roughly complete; 0.35 is generous enough to keep a genuine
   * grinder (which does lose range) while catching the abrupt half-rep that a
   * pain-driven abort produces.
   */
  maxRomCollapse: 0.35,
} as const;

/** What the filter decided about one set. */
export type FailureVerdict = 'failure' | 'abort' | 'not_candidate';

/** Selection-bias context the evaluator records but does not judge on. */
export interface FailureCandidateContext {
  /** Ordinal of the set within its session, 1-based. */
  setIndexInSession?: number;
  /** Seconds from session start to this set's start. */
  sessionPositionSec?: number;
}

/**
 * The measurements behind a verdict, persisted verbatim so a later filter
 * version can re-score history instead of stranding it. The thresholds in
 * force are identified by {@link FAILURE_FILTER_VERSION}, not repeated here.
 */
export interface FailureFilterInputs extends FailureCandidateContext {
  repCount: number;
  /**
   * Why the set was performed (VMCP-02.84). Only `'working'` is scorable — a
   * probe is one deliberate heavy effort and a technique rung is light
   * practice, so neither is evidence of reaching failure.
   */
  setPurpose: SetPurpose;
  /** Derived from {@link setPurpose}; kept so stored rows stay comparable. */
  isWarmup: boolean;
  /** Concentric mean velocity of the final rep, m/s. */
  lastRepVelocityMps?: number;
  /** Fastest non-first rep's concentric mean velocity, m/s — the stall denominator. */
  referenceVelocityMps?: number;
  /** `lastRepVelocityMps / referenceVelocityMps`. */
  stallRatio?: number;
  /** The final `decayWindow` concentric mean velocities, oldest first, m/s. */
  decayWindowMps?: number[];
  /** Whether those velocities were non-increasing within tolerance. */
  decayTrajectory?: boolean;
  /**
   * Final-rep ROM over the set's median rep ROM. A RATIO on purpose: stored
   * positions are device-native on pre-VW-160 rows, and a ratio of two
   * same-set ROMs is unit-free either way.
   */
  romRatio?: number;
  /** One phrase naming why the verdict is what it is. */
  reason: string;
}

/** One set's filter result, ready for the writer to persist. */
export interface FailureCandidateEvaluation {
  verdict: FailureVerdict;
  inputs: FailureFilterInputs;
  /** Terminal concentric velocity at failure, m/s. Absent unless the set stalled. */
  terminalVelocityMps?: number;
  filterVersion: string;
}

/**
 * Classify one recorded set as a failure anchor, an abort, or neither.
 *
 * Velocities are normalised to m/s first, so a row captured before the bridge
 * conversion (device-native mm/s) and a row captured after it produce the same
 * verdict AND the same stored `terminalVelocityMps`.
 */
export function evaluateFailureCandidate(
  set: StoredSet,
  ctx: FailureCandidateContext = {},
): FailureCandidateEvaluation {
  const reps = normaliseVelocityToMps(set).reps;
  const setPurpose = setPurposeOf(set);
  const base: FailureFilterInputs = {
    repCount: reps.length,
    setPurpose,
    isWarmup: setPurpose === 'warmup',
    reason: '',
    ...ctx,
  };

  if (setPurpose === 'warmup') return notCandidate(base, 'warm-up set');
  if (setPurpose !== 'working') return notCandidate(base, `${setPurpose} set, not working`);
  if (reps.length < HARVEST_THRESHOLDS.minReps) {
    return notCandidate(base, `fewer than ${String(HARVEST_THRESHOLDS.minReps)} reps`);
  }

  const velocities = reps.map(concentricMeanMps);
  const measured = measureStall(velocities);
  if (measured === undefined) return notCandidate(base, 'no positive concentric velocity');

  const inputs: FailureFilterInputs = { ...base, ...measured };
  if (measured.stallRatio > HARVEST_THRESHOLDS.stallFraction) {
    return notCandidate(inputs, 'final rep never stalled');
  }
  return classifyStalledSet(reps, velocities, measured.lastRepVelocityMps, inputs);
}

/** Stall measurements for a set, or `undefined` when no rep produced one. */
function measureStall(
  velocities: number[],
): { lastRepVelocityMps: number; referenceVelocityMps: number; stallRatio: number } | undefined {
  const last = velocities[velocities.length - 1] ?? 0;
  // Rep 1 is routinely a cable-engagement artifact with a tiny ROM and a
  // meaninglessly low velocity, so it never sets the reference — the same
  // fastest-non-first baseline `peakConcentricBaseline` uses elsewhere.
  const reference = Math.max(...velocities.slice(1));
  if (!(reference > 0) || !(last > 0)) return undefined;
  return {
    lastRepVelocityMps: round3(last),
    referenceVelocityMps: round3(reference),
    stallRatio: round3(last / reference),
  };
}

/**
 * Split a stalled set into failure and abort. Failure needs BOTH a decay
 * trajectory and an intact final ROM; anything else is an abort, because the
 * two ways this goes wrong (a pain-driven cut-short, an abrupt stop with no
 * fatigue behind it) both produce anchors that read faster than the truth.
 */
function classifyStalledSet(
  reps: Rep[],
  velocities: number[],
  terminalVelocityMps: number,
  inputs: FailureFilterInputs,
): FailureCandidateEvaluation {
  const window = velocities.slice(-HARVEST_THRESHOLDS.decayWindow).map(round3);
  const decayTrajectory = isNonIncreasing(window);
  const romRatio = finalRomRatio(reps);
  const romIntact = romRatio === undefined || romRatio >= 1 - HARVEST_THRESHOLDS.maxRomCollapse;
  const full: FailureFilterInputs = { ...inputs, decayWindowMps: window, decayTrajectory };
  if (romRatio !== undefined) full.romRatio = romRatio;

  if (decayTrajectory && romIntact) {
    return {
      verdict: 'failure',
      inputs: { ...full, reason: 'stalled after a monotone-ish velocity decay, ROM intact' },
      terminalVelocityMps,
      filterVersion: FAILURE_FILTER_VERSION,
    };
  }
  const why = decayTrajectory
    ? 'final-rep ROM collapsed below the set median'
    : 'stalled with no preceding velocity decay';
  return {
    verdict: 'abort',
    inputs: { ...full, reason: why },
    terminalVelocityMps,
    filterVersion: FAILURE_FILTER_VERSION,
  };
}

function notCandidate(inputs: FailureFilterInputs, reason: string): FailureCandidateEvaluation {
  return {
    verdict: 'not_candidate',
    inputs: { ...inputs, reason },
    filterVersion: FAILURE_FILTER_VERSION,
  };
}

/** Non-increasing within `decayTolerance`, so noise cannot veto a real decay. */
function isNonIncreasing(values: number[]): boolean {
  if (values.length < HARVEST_THRESHOLDS.decayWindow) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1] * (1 + HARVEST_THRESHOLDS.decayTolerance)) return false;
  }
  return true;
}

/** Final rep's ROM over the set's median ROM; `undefined` when no rep has one. */
function finalRomRatio(reps: Rep[]): number | undefined {
  const roms: number[] = reps.map((rep) => getRepRangeOfMotion(rep)).filter((r) => r > 0);
  if (roms.length === 0) return undefined;
  const last = getRepRangeOfMotion(reps[reps.length - 1]);
  const median = medianOf(roms);
  if (!(median > 0)) return undefined;
  return round3(last / median);
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function concentricMeanMps(rep: Rep): number {
  return Math.abs(getPhaseMeanVelocity(rep.concentric));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
