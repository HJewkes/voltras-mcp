// Per-rep corrections applied once, at set finalize, to the analytics-derived
// rep array before it feeds BOTH the persisted `StoredSet` and the `set_ended`
// channel payload. Runs at the single finalize chokepoint (`finalizeSet`) so
// the persisted block and the live event never disagree.
//
// Three corrections, in dependency order (each builds on the previous):
//
//   1. VMCP-02.66 — drop mis-segmented reps. The un-rack that precedes the
//      first real rep segments as a phantom rep whose concentric moves the
//      load the WRONG way (it ends below where it started). A real working
//      concentric always nets positive displacement, so a strictly-negative
//      net concentric displacement is the un-rack signature. Dropping it fixes
//      rep-count inflation and stops the phantom from poisoning
//      `vbt_summary.first_rep_v`.
//
//   2. VMCP-02.65 — truncate the final rep's eccentric idle tail. When the set
//      ends the cable sits parked, and those idle samples land on the last
//      rep's eccentric, inflating its duration (tempo_ratio blows up) and
//      diluting its mean velocity. Trim trailing non-movement samples back to
//      the last real movement and rebuild the phase.
//
//   3. VMCP-02.69a — recompute each phase's peak velocity from its own samples,
//      KEEPING SIGN. The analytics running-aggregate `peakVelocity` can go
//      stale relative to the samples it holds (and is magnitude-only), so a
//      first rep can persist a peak that contradicts its samples. Re-derive it
//      as the signed velocity of the largest-magnitude sample.
//
// Load channel (VMCP-02.69b): `Phase.peakLoad` / `Phase._totalLoad` stay at
// their upstream-default 0. The bridge builds `WorkoutSample`s without the
// optional `load` channel, so load is not present in the captured stream at
// this layer, and no channel payload or persisted `derived` block surfaces it.
// See the ticket note in the finalize path — computing per-frame load would be
// a sample-construction concern, not a finalize correction.

import type { Phase, Rep, WorkoutSample } from '@voltras/workout-analytics';
import { rebuildPhaseFromSamples } from '@voltras/workout-analytics';

/**
 * VMCP-02.65: velocity magnitude (workout-analytics' native mm/s scale) at or
 * below which a trailing eccentric sample is treated as idle parking rather
 * than real movement. The racked-cable idle tail sits at ~0; a real eccentric
 * descent runs well above this. Tunable threshold — see the ticket note on the
 * bench-observed "3 samples > 50u" real-movement window.
 */
const ECCENTRIC_IDLE_VELOCITY_THRESHOLD = 50;

/**
 * Apply the finalize-time rep corrections (VMCP-02.66 → 02.65 → 02.69a) in
 * dependency order. Pure: returns a new array; never mutates the input reps or
 * phases. Rep numbers are left as-is — `repNumber` is the analytics-canonical
 * identifier (consumers already tolerate non-1-based values), and set-level rep
 * counts derive from array length, not the max rep number.
 */
export function finalizeReps(reps: readonly Rep[]): Rep[] {
  const segmented = reps.filter(isNotUnrackArtifact);
  const truncated = truncateFinalEccentricIdleTail(segmented);
  return truncated.map(withSignedSamplePeaks);
}

/**
 * VMCP-02.66 predicate. Keeps every rep except the un-rack artifact, whose
 * concentric nets a STRICTLY negative displacement (ends below its start). A
 * zero-displacement rep — a no-movement or single-sample rep — is preserved:
 * requiring strictly-positive ROM here would incorrectly discard legitimate
 * single-sample or terminal reps whose start and end position coincide.
 */
function isNotUnrackArtifact(rep: Rep): boolean {
  return netConcentricDisplacement(rep.concentric) >= 0;
}

function netConcentricDisplacement(concentric: Phase): number {
  return concentric.endPosition - concentric.startPosition;
}

/**
 * VMCP-02.65. Rebuilds only the LAST rep's eccentric from its samples up to and
 * including the last real-movement sample, dropping the trailing idle run. No-op
 * when there is no last rep, no eccentric samples, no trailing idle run, or no
 * movement sample to anchor on (all-idle eccentric is left intact rather than
 * emptied — we don't discard a phase we can't confidently classify).
 */
function truncateFinalEccentricIdleTail(reps: readonly Rep[]): Rep[] {
  if (reps.length === 0) {
    return [...reps];
  }
  const lastIndex = reps.length - 1;
  const last = reps[lastIndex];
  const samples = last.eccentric.samples;
  const lastMovementIndex = lastMovementSampleIndex(samples);
  if (lastMovementIndex < 0 || lastMovementIndex >= samples.length - 1) {
    return [...reps];
  }
  const trimmed = samples.slice(0, lastMovementIndex + 1);
  const next = [...reps];
  next[lastIndex] = { ...last, eccentric: rebuildPhaseFromSamples(trimmed) };
  return next;
}

function lastMovementSampleIndex(samples: readonly WorkoutSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i].velocity) > ECCENTRIC_IDLE_VELOCITY_THRESHOLD) {
      return i;
    }
  }
  return -1;
}

/**
 * VMCP-02.69a. Overrides each phase's `peakVelocity` with the signed velocity
 * of its largest-magnitude sample, so the persisted peak reflects the samples
 * it actually holds and keeps its direction sign. Phases with no samples keep
 * their existing peak (nothing to recompute from).
 */
function withSignedSamplePeaks(rep: Rep): Rep {
  return {
    ...rep,
    concentric: withSignedPeakVelocity(rep.concentric),
    eccentric: withSignedPeakVelocity(rep.eccentric),
  };
}

function withSignedPeakVelocity(phase: Phase): Phase {
  const peak = signedPeakVelocity(phase.samples);
  if (peak === undefined) {
    return phase;
  }
  return { ...phase, peakVelocity: peak };
}

function signedPeakVelocity(samples: readonly WorkoutSample[]): number | undefined {
  let best: number | undefined;
  let bestMagnitude = -1;
  for (const sample of samples) {
    const magnitude = Math.abs(sample.velocity);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      best = sample.velocity;
    }
  }
  return best;
}
