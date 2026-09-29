// The per-tier effort target on a working set (VW-668), one table for every reader.
//
// `profile.get_starting_prescription` and the wall's prescription both read it, so the
// tool and the dashboard cannot disagree. Pure, and it imports only the `Tier` type, so
// the dashboard SPA bundle can import it too.

import type { Tier } from '../tools/tier-signal.js';

export interface EffortTarget {
  /** `null` at the beginner tier, which should not track RIR at all. */
  rirTarget: number | null;
  text: string;
  /** Corpus ids the target rests on. */
  sources: readonly string[];
}

const EFFORT_SOURCES = [
  'rp-s7-rir-self-report-accuracy-by-tier',
  'rp-s4-beginner-rir-floor-progression',
] as const;

const EFFORT_TARGETS: Record<Tier, EffortTarget> = {
  beginner: {
    rirTarget: null,
    text:
      'Do not track RIR at this tier — beginner self-report runs 5-10 reps off. Progress on ' +
      'technique instead, with a floor of never closer than 1-2 RIR.',
    sources: EFFORT_SOURCES,
  },
  intermediate: {
    rirTarget: 3,
    text: 'Start around 3 RIR in week 1, trending toward 0 by the last pre-deload session.',
    sources: EFFORT_SOURCES,
  },
  advanced: {
    rirTarget: 2,
    text: '2-3 RIR generally; 1-2 RIR for a prioritized small muscle.',
    sources: EFFORT_SOURCES,
  },
};

/** The effort target RP sets for a working set at `tier`. */
export function effortTargetFor(tier: Tier): EffortTarget {
  return EFFORT_TARGETS[tier];
}
