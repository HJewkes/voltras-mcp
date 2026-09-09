// Within-set ROM integrity readout (VW-93 / B09) — pure, unit-free, and
// baseline-free.
//
// EVERYTHING HERE COMPARES A SET TO ITSELF. A rep's ROM against the median of
// its own set; the last eligible rep's ROM against the first eligible rep's; a
// coefficient of variation over the set's own reps. Nothing in this file knows
// what a curl "should" measure, and no population figure exists to know it
// with: anthropometry, cable geometry and seat position all move ROM without a
// single thing changing about technique. That is why the within-set half is
// the sane first slice of VW-93 — it needs no baseline at all. The
// cross-session half lives in `metrics-tools.ts`, where the store and the B57
// gate are, and is refused outright below a PROVISIONAL baseline.
//
// EVERY CUT IS BORROWED, NAMED AND CITED. Both margins below come from
// `@voltras/workout-analytics`'s own published schemes and are applied through
// WA's own `classifyByBreakpoints`, never restated as a local number, so a
// scheme change upstream cannot silently disagree with a copy here. A margin
// supplied as `null` yields a `null` verdict rather than a guess — the ratio
// and the CV ship either way. `rep-faults.ts` follows the same rule for the
// faults it has no citable cut for.
//
// FALSE POSITIVES COST MORE THAN SILENCE. Telling a lifter their technique is
// degrading when it is not is worse than saying nothing, so a statistic that
// cannot be computed reports `null` and never a stand-in: a one-rep set has no
// decay, and a set that never moved has no CV.

import {
  buildDistribution,
  classifyByBreakpoints,
  getCV,
  getPhaseRangeOfMotion,
  DEFAULT_CONSISTENCY_SCHEME,
  DEFAULT_PARTIAL_REP_SCHEME,
  type BreakpointScheme,
  type Rep,
} from '@voltras/workout-analytics';

import { selectEligibleReps } from '../state/rep-eligibility.js';

/** A classification cut together with where it comes from. */
export interface CitedScheme<T> {
  readonly scheme: BreakpointScheme<T>;
  /** The source of the cut. A margin with no citable source is `null`, never invented. */
  readonly citation: string;
}

/** WA's own consistency vocabulary, reused verbatim so the cut and the label agree. */
export type RomVarianceVerdict = 'stable' | 'variable' | 'erratic';

export interface RomIntegrityMargins {
  readonly decay: CitedScheme<boolean> | null;
  readonly variance: CitedScheme<RomVarianceVerdict> | null;
}

/**
 * The two cuts this readout is allowed to speak with.
 *
 * `decay` reuses WA's partial-rep scheme because it grades exactly this
 * quantity: a ROM RATIO of actual over expected, where below 0.80 is called a
 * partial rep. The expectation here is the set's own first eligible rep rather
 * than a technique baseline, which is the only substitution — the measurement
 * and its scale are unchanged.
 *
 * `variance` reuses WA's consistency scheme, which grades a coefficient of
 * variation and is what WA's own `ConsistencyScore.overall` classifies
 * `romCV` with. Same statistic, same estimator (`getCV` over
 * `buildDistribution`), same labels.
 */
export const ROM_INTEGRITY_MARGINS: RomIntegrityMargins = {
  decay: {
    scheme: DEFAULT_PARTIAL_REP_SCHEME,
    citation:
      "@voltras/workout-analytics DEFAULT_PARTIAL_REP_SCHEME — 'ROM < 80% = partial', a ratio " +
      'of observed ROM to expected ROM; here the expectation is the set’s own first eligible rep',
  },
  variance: {
    scheme: DEFAULT_CONSISTENCY_SCHEME,
    citation:
      '@voltras/workout-analytics DEFAULT_CONSISTENCY_SCHEME — CV < 0.10 stable, < 0.20 ' +
      'variable, >= 0.20 erratic; the same scheme WA grades its own ROM `romCV` with',
  },
};

export interface RepRomReading {
  repNumber: number;
  /**
   * This rep's concentric ROM over the MEDIAN concentric ROM of the set's
   * eligible reps. `null` only when that median is not positive.
   */
  romFractionOfSetMedian: number | null;
  /**
   * `false` for a rep `selectEligibleReps` dropped — the opening positioning
   * pull (VW-168) or a half-rep. Ineligible reps are reported with their raw
   * fraction and excluded from every statistic below.
   */
  eligible: boolean;
}

export interface RomDecayReading {
  /**
   * Last eligible rep's ROM over the FIRST eligible rep's. `null` below two
   * eligible reps, or when the first carries no measurable ROM.
   */
  lastOverFirstEligible: number | null;
  verdict: 'stable' | 'shrinking' | null;
  /** Where the verdict's cut comes from; `null` exactly when the verdict is. */
  citation: string | null;
}

export interface RomVarianceReading {
  /** Coefficient of variation of eligible-rep ROM. Dimensionless by construction. */
  cv: number | null;
  verdict: RomVarianceVerdict | null;
  /** Where the verdict's cut comes from; `null` exactly when the verdict is. */
  citation: string | null;
}

export interface RomIntegrityReading {
  /** How many reps the statistics below were taken over. */
  eligibleRepCount: number;
  /** Every rep in the set, eligible or not — nothing is dropped silently. */
  perRep: RepRomReading[];
  decay: RomDecayReading;
  variance: RomVarianceReading;
}

/**
 * Read one set's ROM integrity.
 *
 * `margins` is injectable for the same reason WA's own analytics take a
 * `schemes?` argument: a caller with a better-sourced cut may supply one, and
 * a caller with none may pass `null` and get raw numbers with null verdicts.
 */
export function readRomIntegrity(
  reps: readonly Rep[],
  margins: RomIntegrityMargins = ROM_INTEGRITY_MARGINS,
): RomIntegrityReading {
  const eligible = selectEligibleReps(reps);
  // Identity, not `repNumber`: `selectEligibleReps` returns the very rep
  // objects it kept, so a set with duplicate rep numbers cannot mislabel one.
  const kept = new Set(eligible);
  const roms = eligible.map(concentricRom);
  const median = medianOf(roms);
  return {
    eligibleRepCount: eligible.length,
    perRep: reps.map((rep) => ({
      repNumber: rep.repNumber,
      romFractionOfSetMedian: median > 0 ? concentricRom(rep) / median : null,
      eligible: kept.has(rep),
    })),
    decay: readDecay(roms, margins.decay),
    variance: readVariance(roms, margins.variance),
  };
}

/**
 * The median concentric ROM of the set's eligible reps, or `null` when no rep
 * carries a measurable one.
 *
 * NOT PART OF THE READOUT — it is an absolute length, and this server publishes
 * ratios only. It is exported for the cross-session comparison in
 * `metrics-tools.ts`, which needs a numerator to divide by a baseline.
 */
export function medianEligibleRom(reps: readonly Rep[]): number | null {
  const median = medianOf(selectEligibleReps(reps).map(concentricRom));
  return median > 0 ? median : null;
}

/**
 * First-to-last shrink across the set's eligible reps.
 *
 * The reference is the FIRST eligible rep, not a median of the opening few:
 * "the first few" would need a window size, no citable one exists, and
 * `selectEligibleReps` already removes the artifact that a median was there to
 * absorb — it drops a rep that is far bigger OR far smaller than its
 * neighbours, which is exactly the opening positioning pull.
 */
function readDecay(roms: readonly number[], margin: CitedScheme<boolean> | null): RomDecayReading {
  const first = roms[0];
  const last = roms[roms.length - 1];
  if (roms.length < 2 || first === undefined || last === undefined || first <= 0) {
    return { lastOverFirstEligible: null, verdict: null, citation: null };
  }
  const lastOverFirstEligible = last / first;
  if (margin === null) return { lastOverFirstEligible, verdict: null, citation: null };
  return {
    lastOverFirstEligible,
    verdict: classifyByBreakpoints(lastOverFirstEligible, margin.scheme) ? 'shrinking' : 'stable',
    citation: margin.citation,
  };
}

/**
 * Rep-to-rep ROM spread as a coefficient of variation, computed with WA's own
 * `getCV` (sample standard deviation over the mean) so the number and the
 * scheme that grades it are the same statistic.
 */
function readVariance(
  roms: readonly number[],
  margin: CitedScheme<RomVarianceVerdict> | null,
): RomVarianceReading {
  // A set whose reps all measure zero would otherwise report `cv: 0`, which
  // `getCV` returns for a zero mean and which reads as perfect consistency.
  if (roms.length < 2 || Math.max(...roms) <= 0) {
    return { cv: null, verdict: null, citation: null };
  }
  const cv = getCV(buildDistribution(roms));
  if (margin === null) return { cv, verdict: null, citation: null };
  return { cv, verdict: classifyByBreakpoints(cv, margin.scheme), citation: margin.citation };
}

function concentricRom(rep: Rep): number {
  return getPhaseRangeOfMotion(rep.concentric);
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
