// Per-rep corrections applied once, at set finalize, to the analytics-derived
// rep array before it feeds BOTH the persisted `StoredSet` and the `set_ended`
// channel payload. Runs at the single finalize chokepoint (`finalizeSet`) so
// the persisted block and the live event never disagree.
//
// Three corrections. The first two are movement-class-dependent and gated OFF
// by default behind `VMCP_REP_CORRECTIONS` (passed as `segmentationCorrections`)
// until the VW-16 bench parity run validates them across movement classes; the
// third always runs. They apply in dependency order (each builds on the
// previous):
//
//   1. VMCP-02.66 (gated) — drop mis-segmented reps. The un-rack that precedes the
//      first real rep segments as a phantom rep whose concentric moves the
//      load the WRONG way (it ends below where it started). A real working
//      concentric always nets positive displacement, so a strictly-negative
//      net concentric displacement is the un-rack signature. Dropping it fixes
//      rep-count inflation and stops the phantom from poisoning
//      `vbt_summary.first_rep_v`.
//
//   2. VMCP-02.65 (gated) — truncate the final rep's eccentric idle tail. When the set
//      ends the cable sits parked, and those idle samples land on the last
//      rep's eccentric, inflating its duration (tempo_ratio blows up) and
//      diluting its mean velocity. Trim trailing non-movement samples back to
//      the last real movement and rebuild the phase.
//
//   3. VMCP-02.69a (always on) — recompute each phase's peak velocity from its own
//      samples. The analytics running-aggregate `peakVelocity` can go stale
//      relative to the samples it holds, so a first rep can persist a peak that
//      contradicts its samples. Re-derive it as the MAGNITUDE of the
//      largest-magnitude sample.
//
//      Canonical sign convention (VMCP-05.14): phase peak velocity is UNSIGNED.
//      `Phase.peakVelocity` is a magnitude by upstream contract —
//      `addSampleToPhase` runs `Math.abs` on every incoming sample velocity
//      precisely so a signed decoder value cannot corrupt the aggregate, and
//      every derived helper is built on that assumption
//      (`getPhaseVelocityDropPct` returns 0 outright when `peakVelocity <= 0`;
//      `getPhaseVelocityEnvelope` reports `|velocity|`). Direction is already
//      carried by which phase slot the value sits in — an eccentric peak is
//      descending by definition — so a sign is redundant there and load-bearing
//      nowhere.
//
//      This correction originally kept the sign, which made the same rep report
//      `eccentric.peak_velocity` as +1.137 on the live `rep_finalized` event
//      (raw analytics rep) and -1.137 on `set_ended` (post-finalize rep), and
//      dragged that rep's `velocity_drop_pct` from 97.2 to 0 through the guard
//      above. Both symptoms are this one root cause. Anything that genuinely
//      needs direction reads the signed sample velocities, which stay on the
//      phase untouched.
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

export interface RepFinalizeOptions {
  /**
   * Apply the movement-class-dependent segmentation corrections (VMCP-02.66
   * un-rack drop + VMCP-02.65 eccentric idle-tail truncation). Gated OFF by
   * default via `VMCP_REP_CORRECTIONS` — see {@link RepCorrectionsMode} — until
   * the VW-16 bench parity run validates them across movement classes. The
   * VMCP-02.69a peak recompute always runs regardless of this flag.
   */
  segmentationCorrections?: boolean;
}

/**
 * Apply the finalize-time rep corrections. Pure: returns a new array; never
 * mutates the input reps or phases. Rep numbers are left as-is — `repNumber` is
 * the analytics-canonical identifier (consumers already tolerate non-1-based
 * values), and set-level rep counts derive from array length, not the max rep
 * number.
 *
 * When `segmentationCorrections` is set, the movement-class-dependent
 * corrections run first in dependency order (VMCP-02.66 filter → 02.65
 * truncate) so the samples the peak-recompute pass sees are already
 * de-artifacted and trimmed. VMCP-02.69a (sample-derived peaks) then runs
 * unconditionally.
 */
export function finalizeReps(reps: readonly Rep[], opts: RepFinalizeOptions = {}): Rep[] {
  const segmented =
    opts.segmentationCorrections === true
      ? truncateFinalEccentricIdleTail(reps.filter(isNotUnrackArtifact))
      : reps;
  return segmented.map(withSampleDerivedPeaks);
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
 * VMCP-02.69a. Overrides each phase's `peakVelocity` with the magnitude of its
 * largest-magnitude sample, so the persisted peak reflects the samples it
 * actually holds. Phases with no samples keep their existing peak (nothing to
 * recompute from).
 *
 * Unsigned by the convention documented at the top of this file (VMCP-05.14):
 * `Phase.peakVelocity` is a magnitude everywhere else in the pipeline, and a
 * signed value here silently zeroed `getPhaseVelocityDropPct`.
 */
function withSampleDerivedPeaks(rep: Rep): Rep {
  return {
    ...rep,
    concentric: withPeakVelocityMagnitude(rep.concentric),
    eccentric: withPeakVelocityMagnitude(rep.eccentric),
  };
}

function withPeakVelocityMagnitude(phase: Phase): Phase {
  const peak = peakVelocityMagnitude(phase.samples);
  if (peak === undefined) {
    return phase;
  }
  return { ...phase, peakVelocity: peak };
}

function peakVelocityMagnitude(samples: readonly WorkoutSample[]): number | undefined {
  let best: number | undefined;
  for (const sample of samples) {
    const magnitude = Math.abs(sample.velocity);
    if (best === undefined || magnitude > best) {
      best = magnitude;
    }
  }
  return best;
}
