// Expected rep RANGE for a velocity-loss-terminated set, from a lifter's own
// history at one exercise and one load (VW-301) — never a point estimate.
//
// WHY A RANGE, NOT A NUMBER
// -------------------------
// Jukic et al. 2023 (Sports Medicine - Open, doi 10.1186/s40798-023-00626-z)
// measured how many reps it took to reach a FIXED velocity-loss threshold at a
// FIXED load (70% 1RM) across repeated sessions, and found 95% limits of
// agreement of roughly -5.4 to +5.5 reps between sessions at the identical
// threshold and load. That is the test-retest noise floor for this exact
// measurement, in a population, not a property of any one lifter's technique.
// A single predicted rep count for a VL-terminated set therefore overstates
// how precisely it can be known; the honest output is the spread this
// lifter's own history has actually shown at this load.
//
// PURE. Every input is already-fetched, already-derived rep/set data; nothing
// here touches the store, the device, or the clock.

import { repsToVelocityLossThreshold } from './rest-defaults.js';
import { normaliseVelocityToMps } from '../store/velocity-units.js';
import type { StoredSet } from '../store/types.js';

export const JUKIC_2023_CITATION =
  'Jukic et al. 2023 (Sports Medicine - Open, doi 10.1186/s40798-023-00626-z) — reps ' +
  'completed to a FIXED velocity-loss threshold at a FIXED load (70% 1RM) carried 95% ' +
  'limits of agreement of roughly -5.4 to +5.5 reps between sessions, so a single ' +
  'predicted rep count overstates how precisely this can be known.';

/**
 * Minimum qualifying historical sets before a range is reported.
 *
 * Matches the 3-set floor this repo already treats as the minimum evidence for
 * a personalised statistical claim (`exercise-baselines.ts`'s
 * `minCalibratedAnchors`, `rir-velocity.ts`'s `RIR_VELOCITY_MINIMUMS.minSets`)
 * — the same reasoning applies here: fewer than three observations is one or
 * two numbers, not a spread that has had a chance to show itself. Below it,
 * `null` is the honest answer, not a range built on too little to mean
 * anything.
 */
export const MIN_HISTORY_SETS = 3;

/** The expected rep range for a VL-terminated set, derived from history. */
export interface RepsToThresholdRange {
  /** Lowest reps-to-threshold count seen in the qualifying history. */
  expectedLow: number;
  /** Highest reps-to-threshold count seen in the qualifying history. */
  expectedHigh: number;
  /** Median reps-to-threshold count across the qualifying history. */
  median: number;
  /** Qualifying historical sets the range was built from. */
  n: number;
  /** Plain-language basis for the range, naming the evidence and the citation. */
  basis: string;
}

/**
 * The expected rep range, from a lifter's own reps-to-threshold history —
 * the observed min/max/median across `history`, once there is enough of it to
 * mean something (see {@link MIN_HISTORY_SETS}). `null` below that floor.
 */
export function repsToThresholdRange(history: readonly number[]): RepsToThresholdRange | null {
  if (history.length < MIN_HISTORY_SETS) return null;
  const sorted = [...history].sort((a, b) => a - b);
  return {
    expectedLow: sorted[0],
    expectedHigh: sorted[sorted.length - 1],
    median: medianOf(sorted),
    n: sorted.length,
    basis:
      `observed range across ${String(sorted.length)} historical sets reaching this ` +
      `exercise's velocity-loss threshold at this load. ${JUKIC_2023_CITATION}`,
  };
}

/**
 * One lifter's historical reps-to-threshold counts for one exercise at one
 * load — the array {@link repsToThresholdRange} is built from.
 *
 * A "load band" here is an EXACT match on `weightLbs`: the load a lifter
 * actually trained at is the load band that matters, and widening to a
 * percentage tolerance would need an invented constant this module has no
 * evidence to pick (the same reasoning `rir-velocity.ts`'s soft-edges note
 * gives for not widening ITS band).
 *
 * Reuses `repsToVelocityLossThreshold` (VW-297) — which already runs
 * `selectEligibleReps` over the set's reps — rather than re-deriving
 * eligibility, so a rep that rule excludes cannot quietly count here and not
 * there. Sets with no `weightLbs` or that never reach the threshold
 * contribute nothing.
 */
export function historicalRepsToThreshold(
  sets: readonly StoredSet[],
  loadLbs: number,
  thresholdPct: number,
): number[] {
  const out: number[] = [];
  for (const set of sets) {
    if (set.weightLbs !== loadLbs) continue;
    const reps = repsToVelocityLossThreshold(normaliseVelocityToMps(set).reps, thresholdPct);
    if (reps !== null) out.push(reps);
  }
  return out;
}

function medianOf(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
