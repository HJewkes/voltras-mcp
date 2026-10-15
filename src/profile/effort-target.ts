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
  /** The wall's one-line form of {@link text}, read as a target and never as a reading (VW-669). */
  wallText: string;
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
    wallText: 'Technique focus, 1-2 reps shy of failure at most',
    sources: EFFORT_SOURCES,
  },
  intermediate: {
    rirTarget: 3,
    text: 'Start around 3 RIR in week 1, trending toward 0 by the last pre-deload session.',
    wallText: 'Target ~3 RIR in week 1, toward 0 by deload',
    sources: EFFORT_SOURCES,
  },
  advanced: {
    rirTarget: 2,
    text: '2-3 RIR generally; 1-2 RIR for a prioritized small muscle.',
    wallText: 'Target 2-3 RIR',
    sources: EFFORT_SOURCES,
  },
};

/** The effort target RP sets for a working set at `tier`. */
export function effortTargetFor(tier: Tier): EffortTarget {
  return EFFORT_TARGETS[tier];
}
