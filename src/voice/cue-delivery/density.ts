// Tier-density table for the cue-delivery layer (VW-140 plan 3.3).
//
// Lines a slot may hear per interval, by training tier. The table only ever
// removes lines: the budget still applies the hard cap and the mid-set gates.

import type { Tier } from '../../tools/tier-signal.js';
import type { Interval } from './interval.js';

export type IntervalDensity = Readonly<Record<Interval, number>>;

/** No interval admits a third line, whatever the tier. */
export const MAX_LINES_PER_INTERVAL = 2;

/** Until the tier lookup resolves, the strictest density applies. */
export const UNRESOLVED_TIER: Tier = 'advanced';

export const TIER_DENSITY: Readonly<Record<Tier, IntervalDensity>> = Object.freeze({
  beginner: Object.freeze({ pre: 2, intra: 2, post: 2 }),
  intermediate: Object.freeze({ pre: 2, intra: 1, post: 2 }),
  advanced: Object.freeze({ pre: 2, intra: 0, post: 2 }),
});

/** Line allowance for one interval; a `null` tier reads as {@link UNRESOLVED_TIER}. */
export function densityFor(tier: Tier | null, interval: Interval): number {
  return TIER_DENSITY[tier ?? UNRESOLVED_TIER][interval];
}
