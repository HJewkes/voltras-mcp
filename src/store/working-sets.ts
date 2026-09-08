// Which of an exercise's sets describe the WORK (VW-progression / coach-loop).
//
// Extracted from `plan-tools.ts` so the progression heuristic and the coach
// report render the same set list. Two copies of a warm-up rule that drift
// apart would mean the report shows sets the progression suggestion ignored.

import type { StoredSet } from './types.js';

/**
 * Warmups and working sets flow through the same `set.start`/`set.end` path.
 * Two signals separate them, applied in order:
 *
 *   1. The explicit `StoredSet.isWarmup` flag (set at `set.start`). A flagged
 *      warmup is never a working set — even a heavy primer at working weight,
 *      which the load heuristic below would wrongly keep.
 *   2. Top load, for the (still common) unflagged warmups: a warmup is a
 *      sub-working-weight ramp-up, so treat the sets at the heaviest load as
 *      the working sets — the ones the rep band is actually prescribed against.
 *
 * `sets` MUST already be scoped to one exercise. The top-load rank is relative
 * to whatever it is given, so a mixed list resolves to the heaviest movement in
 * the session and discards every set of the lighter one as a warm-up.
 *
 * Judging progression on the full set list lets light, low-rep warmups inflate
 * the "missed" tally into a bogus deload (VMCP-progression-warmups), and a
 * single high-velocity-loss warmup can suppress a legit +5. Observed top load
 * (not `targetWeightLbs`) tracks the load actually lifted, even after the
 * plan's original target has been outgrown.
 */
export function selectWorkingSets(sets: StoredSet[]): StoredSet[] {
  const working = sets.filter((set) => !isWarmupSet(set));
  if (working.length === 0) return working;
  // Only weighted sets can be ranked by load. When none recorded a weight there
  // is no basis to discriminate, so every working set is kept — which is what
  // the pre-v6 sentinel produced anyway (all loads equal at 0).
  const loads = working.map((set) => set.weightLbs).filter((w): w is number => w !== undefined);
  if (loads.length === 0) return working;
  const topLoad = Math.max(...loads);
  return working.filter((set) => set.weightLbs !== undefined && set.weightLbs >= topLoad);
}

/**
 * The single read of the warm-up intent. `isWarmup` is the flag on current
 * main; the queued `setPurpose` enum is meant to subsume it, and aliasing the
 * new value here is the only edit that needs.
 */
export function isWarmupSet(set: StoredSet): boolean {
  return set.isWarmup === true;
}
