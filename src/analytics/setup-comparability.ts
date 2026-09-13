// Cable geometry gates comparability (VW-272) — one rule, shared by the wall's
// live L/R callout and `progression.get_for_exercise`'s per-side split, so the
// two can never disagree about whether two slots were even set up the same way.
//
// WHY GEOMETRY IS NOT METADATA
// ----------------------------
// Resistance torque is force times the PERPENDICULAR distance from the line of
// the resistance to the joint. For a free weight that line is always vertical;
// for a cable it is the cable, so moving the anchor moves the resistance moment
// arm and the same commanded load becomes a different joint torque. The worked
// example is a lateral raise: the cable version peaks its moment arm near full
// adduction and DECREASES through the concentric, while the dumbbell version
// peaks at 90 degrees (Keogh, Lake & Swinton, 2013, *Journal of Fitness
// Research* 2(2):39-48).
//
// Two units anchored differently therefore manufacture a left/right difference
// that has nothing to do with the athlete. Every asymmetry verdict and every
// per-side comparison has to answer "same setup?" BEFORE it answers "which side
// is stronger?", or it reports the rig as the lifter.
//
// WHAT THE SIGNATURE IS
// ---------------------
// The same observable `store/exercise-setups.ts` clusters on: median concentric
// ROM over the reps that count as work. Nothing in the product asks a lifter to
// describe their anchor, and cable travel is the only thing that moves with
// geometry, so it is what both sides get compared on.
//
// Setup IDS are deliberately never compared across sides, only carried in the
// payload so a reader can chase which cluster each side landed in. `setupRowId`
// keys on the side, so a left id and a right id are in different namespaces and
// can never be equal; treating that inequality as a mismatch would confound
// every bilateral pair there is.
//
// DEGRADE, NEVER REFUSE SILENTLY — the same posture as `comparability.ts`. A
// side with no measurable travel yields `setup_unverified`, which says the gate
// could not run rather than suppressing a verdict on a check that never
// happened. Only a measured mismatch confounds.

import type { StoredSide } from '../store/types.js';

/**
 * How far apart two median ROMs may be, as a ratio in either direction, before
 * the two sides are judged to be different physical setups.
 *
 * THE SPLIT RULE'S OWN NUMBER, not a second threshold. `store/exercise-setups.ts`
 * imports it as `SETUP_SPLIT_RATIO` to decide whether one set opens a new setup
 * cluster; the cross-slot question here is the same question asked between two
 * limbs instead of between two sets, and giving it its own constant would put
 * two geometry thresholds in the codebase that drift apart.
 *
 * The value comes from the protocol's figure for "the geometry changed": a
 * sustained 10-15 % move in median concentric ROM
 * (vbt-rir-research-and-protocol.md §4.5, quoted in `exercise-baselines.ts`'s
 * `staleAfterDays` note). 1.15 is the top of that band — below it, two sides are
 * the same setup performed with ordinary rep-to-rep variation.
 */
export const SETUP_GEOMETRY_RATIO = 1.15;

/** What the torque-curve gate is sourced from, quoted wherever it refuses. */
export const CABLE_GEOMETRY_CITATION =
  'Keogh, Lake & Swinton 2013, Journal of Fitness Research 2(2):39-48';

/**
 * Whether two slots may be compared at all.
 *
 * - `comparable` — the signatures agree inside {@link SETUP_GEOMETRY_RATIO}.
 * - `setup_confounded` — they differ by more; any left-vs-right difference is
 *   at least partly the rig, so the verdict is withheld.
 * - `setup_unverified` — at least one side carries no signature, so the gate
 *   could not run. It does NOT withhold: a check that never happened is not
 *   evidence of a mismatch.
 */
export type SetupComparability = 'comparable' | 'setup_confounded' | 'setup_unverified';

/** One slot's inferred physical configuration, as far as comparability can see it. */
export interface SetupSignature {
  side: StoredSide;
  /** Median concentric ROM over this side's working reps, in metres. */
  medianRomM?: number;
  /**
   * The setup row this side's sets are stamped with, when they all agree on one.
   * Carried for the reader, never compared — see the header.
   */
  setupId?: string;
}

/** The gate's answer: a verdict, why, and both signatures it read. */
export interface SetupComparabilityVerdict {
  comparability: SetupComparability;
  reason: string;
  left: SetupSignature;
  right: SetupSignature;
}

/**
 * May a left-vs-right comparison be made from these two signatures?
 *
 * The median ROMs are compared as a RATIO, on the same relative-never-absolute
 * rule the setup clustering uses: nothing here knows what a row "should"
 * measure, so each side is judged only against the other.
 */
export function compareSetupSignatures(
  left: SetupSignature,
  right: SetupSignature,
): SetupComparabilityVerdict {
  const verdict = (
    comparability: SetupComparability,
    reason: string,
  ): SetupComparabilityVerdict => ({ comparability, reason, left, right });

  if (left.medianRomM === undefined || right.medianRomM === undefined) {
    return verdict(
      'setup_unverified',
      `no cable travel recorded on ${missingSides(left, right)}, so the setup gate could not run;` +
        ' a left-vs-right difference here has not been checked against the rig',
    );
  }
  const apart = separation(left.medianRomM, right.medianRomM);
  if (apart > SETUP_GEOMETRY_RATIO) {
    return verdict(
      'setup_confounded',
      `the two slots travel differently (${metres(left.medianRomM)} left vs ` +
        `${metres(right.medianRomM)} right, ${ratio(apart)} apart, past the ` +
        `${ratio(SETUP_GEOMETRY_RATIO)} setup-split ratio), and ${TORQUE_CURVE_SENTENCE}`,
    );
  }
  return verdict(
    'comparable',
    `the two slots travel the same (${metres(left.medianRomM)} left vs ` +
      `${metres(right.medianRomM)} right, ${ratio(apart)} apart, inside the ` +
      `${ratio(SETUP_GEOMETRY_RATIO)} setup-split ratio), so the setup is not what separates them`,
  );
}

/**
 * The fact every refusal carries, so a reader is told what a mismatch costs
 * rather than just that something was withheld.
 */
const TORQUE_CURVE_SENTENCE =
  'the same nominal load at a different anchor is a different joint torque ' +
  `(${CABLE_GEOMETRY_CITATION}) — so a left-vs-right difference is the rig, not the athlete`;

/**
 * Median of the ROMs that carry signal, in metres, or `undefined` when none
 * does.
 *
 * Non-positive values are dropped rather than averaged in: a rep with no
 * measurable travel is not evidence about geometry, and letting it through
 * would drag a side's signature toward zero and fabricate a mismatch.
 */
export function medianRomMetres(romsM: readonly number[]): number | undefined {
  const usable = romsM.filter((rom) => rom > 0).sort((a, b) => a - b);
  if (usable.length === 0) return undefined;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

/** How far apart two ROMs are, as a ratio >= 1 in either direction. */
function separation(a: number, b: number): number {
  return Math.max(a, b) / Math.min(a, b);
}

function missingSides(left: SetupSignature, right: SetupSignature): string {
  const sides: string[] = [];
  if (left.medianRomM === undefined) sides.push('left');
  if (right.medianRomM === undefined) sides.push('right');
  return sides.join(' or ');
}

function metres(value: number): string {
  return `${value.toFixed(2)} m`;
}

function ratio(value: number): string {
  return `${value.toFixed(2)}x`;
}
