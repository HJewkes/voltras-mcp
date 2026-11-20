// Which of an exercise's sets describe the WORK (VW-progression / coach-loop).
//
// Extracted from `plan-tools.ts` so the progression heuristic and the coach
// report render the same set list. Two copies of a warm-up rule that drift
// apart would mean the report shows sets the progression suggestion ignored.

import { setPurposeOf, type PurposeBearing } from './set-purpose.js';

/**
 * A set as far as `selectWorkingSets` is concerned — the store's `StoredSet`
 * and the dashboard's wire read-models (`CompletedSet`, `SessionSummarySet`)
 * all satisfy this, which is what lets the wall, the session-completion page
 * and `plan.suggest_progression` share one predicate (VW-283) instead of each
 * keeping its own copy of the warm-up rule.
 */
export interface WorkingSetCandidate extends PurposeBearing {
  weightLbs?: number | null;
  /** Shared by the two sides of one live-paired bilateral effort. */
  bilateralGroupId?: string | null;
}

/**
 * Warmups and working sets flow through the same `set.start`/`set.end` path.
 * Two signals separate them, applied in order:
 *
 *   1. The explicit `setPurpose` (stated at `set.start`). Only `'working'` is
 *      work. A flagged warmup is never a working set — even a heavy primer at
 *      working weight, which the load heuristic below would wrongly keep —
 *      and neither is a `'probe'` or a `'technique'` rung (VMCP-02.84): a
 *      3-rep probe at the session's top load would otherwise score as a MISS
 *      against a 5-10 rep band and drive a bogus -5 lb step.
 *   2. Top load, for the (still common) unflagged warmups: a warmup is a
 *      sub-working-weight ramp-up, so treat the sets at the heaviest load as
 *      the working sets — the ones the rep band is actually prescribed against.
 *      A bilateral pair is one effort with two sides (VW-951), so it ranks by
 *      its heavier side and both sides stay or go together: a lighter side is
 *      an asymmetry, not a warm-up.
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
export function selectWorkingSets<T extends WorkingSetCandidate>(sets: readonly T[]): T[] {
  const working = sets.filter((set) => setPurposeOf(set) === 'working');
  if (working.length === 0) return working;
  // Only weighted sets can be ranked by load. When none recorded a weight there
  // is no basis to discriminate, so every working set is kept — which is what
  // the pre-v6 sentinel produced anyway (all loads equal at 0).
  const loadOf = effortLoads(working);
  const loads = working.map(loadOf).filter((w): w is number => w !== undefined);
  if (loads.length === 0) return working;
  const topLoad = Math.max(...loads);
  return working.filter((set) => (loadOf(set) ?? -Infinity) >= topLoad);
}

/** A set's own load, or for one side of a bilateral pair, the heavier side's. */
function effortLoads<T extends WorkingSetCandidate>(
  sets: readonly T[],
): (set: T) => number | undefined {
  const pairTop = new Map<string, number>();
  for (const set of sets) {
    const groupId = set.bilateralGroupId ?? undefined;
    const load = set.weightLbs ?? undefined;
    if (groupId === undefined || load === undefined) continue;
    pairTop.set(groupId, Math.max(load, pairTop.get(groupId) ?? load));
  }
  return (set) => {
    const groupId = set.bilateralGroupId ?? undefined;
    const pairLoad = groupId === undefined ? undefined : pairTop.get(groupId);
    return pairLoad ?? set.weightLbs ?? undefined;
  };
}

/**
 * Warm-up sets specifically — what `report.session_results` counts as
 * "warm-up: N sets". Narrower than "not a working set": a probe or a
 * technique rung is neither work nor a warm-up.
 */
export function isWarmupSet<T extends PurposeBearing>(set: T): boolean {
  return setPurposeOf(set) === 'warmup';
}
