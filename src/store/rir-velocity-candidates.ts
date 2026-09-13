// Which stored sets can back an RIR-velocity curve, and what each one
// contributes (VW-298).
//
// A set is evidence about reps in reserve only if something says how many reps
// were LEFT when it ended. Two things can:
//
//   - the harvested failure anchor (`failure-harvest.ts`) says the set reached
//     failure, which puts the last completed rep at RIR 0; or
//   - the lifter said so, and that self-report is stored on the anchor row.
//
// A set whose anchor was filtered to `'abort'` and carries no self-report is
// EXCLUDED. That verdict exists because a set cut short by pain looks like
// failure to a naive stall test while yielding a spuriously fast terminal
// velocity — exactly the error direction that tells a lifter they have reps
// left when they do not. Which of the two sources backed each set is carried
// through to the fitted model, because a curve built from measured failures and
// one built from self-reports are not the same claim: Paulsen et al. (PeerJ
// 13, 2025, 10.7717/peerj.19797) found perceived RIR shifts by roughly 0.94
// units between lifters at IDENTICAL measured velocity, so a self-report
// anchors the curve less firmly than a failure does.
//
// RIR IS COUNTED BACKWARDS FROM THE END OF THE SET, over the set's original rep
// ordinals. The eligibility filter (`state/rep-eligibility.ts`) then drops the
// positioning pulls and partials, which is why it runs AFTER the counting: a
// dropped rep still happened, so removing it must not renumber the reps around
// it.
//
// PURE. Every input is an already-fetched row.

import { estimateE1RMFromReps, getPhaseMeanVelocity, type Rep } from '@voltras/workout-analytics';

import type {
  RirAnchorSource,
  RirVelocityObservation,
  RirVelocityPoint,
} from '../analytics/rir-velocity.js';
import { selectEligibleReps } from '../state/rep-eligibility.js';
import type { FailureVerdict } from './failure-harvest.js';
import type { StoredSet } from './types.js';
import { normaliseVelocityToMps } from './velocity-units.js';

/** What the anchor table knows about one set. */
export interface RirAnchorRow {
  verdict: FailureVerdict;
  selfReportedRir?: number;
}

/**
 * The lifter's own reference 1RM for one exercise: the highest rep-based
 * estimate across their recorded sets.
 *
 * REP-BASED (Epley) ON PURPOSE. The alternative is the load-velocity
 * extrapolation, which multiplies the velocity at 1RM — a figure that repeats
 * with CV 22.5% between sessions (Banyard, Nosaka & Haff, J Strength Cond Res,
 * 2017) — into the very ratio used to select sets for a velocity model. The
 * rep formula never touches a velocity, so the band gate and the thing being
 * fitted stay independent.
 *
 * `undefined` when no set carries both a load and a rep. That is a real gap,
 * not a zero: with no reference there is no relative intensity and no band.
 */
export function referenceOneRepMax(sets: readonly StoredSet[]): number | undefined {
  const estimates = sets
    .filter((s) => (s.weightLbs ?? 0) > 0 && s.reps.length > 0)
    .map((s) => estimateE1RMFromReps(s.weightLbs ?? 0, s.reps.length).e1RM);
  return estimates.length === 0 ? undefined : Math.max(...estimates);
}

/**
 * Reduce one lifter's stored sets for one exercise into the observations
 * {@link import('../analytics/rir-velocity.js').fitRirVelocityModel} fits.
 *
 * Sets with no usable anchor, no load or no measurable rep are dropped here
 * rather than passed on as empty observations — the fit reports how many sets
 * it SAW, and a set that could never have qualified is not evidence it
 * weighed.
 */
export function toRirVelocityObservations(
  sets: readonly StoredSet[],
  anchors: ReadonlyMap<string, RirAnchorRow>,
  referenceOneRepMaxLbs: number,
): RirVelocityObservation[] {
  const out: RirVelocityObservation[] = [];
  for (const set of sets) {
    const terminal = terminalRir(anchors.get(set.id));
    const load = set.weightLbs ?? 0;
    if (terminal === null || load <= 0) continue;
    const points = pointsFor(set, terminal.rir);
    if (points.length === 0) continue;
    out.push({
      setId: set.id,
      sessionId: set.sessionId,
      performedAt: set.startedAt,
      relativeIntensity: load / referenceOneRepMaxLbs,
      anchorSource: terminal.source,
      points,
    });
  }
  return out;
}

/** Reps in reserve at a set's last completed rep, or null when unknowable. */
function terminalRir(
  anchor: RirAnchorRow | undefined,
): { rir: number; source: RirAnchorSource } | null {
  if (anchor === undefined) return null;
  // A measured failure outranks a self-report on the same set: the harvest read
  // the velocity trajectory, the lifter read their own effort.
  if (anchor.verdict === 'failure') return { rir: 0, source: 'failure' };
  if (anchor.selfReportedRir !== undefined) {
    return { rir: anchor.selfReportedRir, source: 'self_report' };
  }
  return null;
}

/** One point per eligible rep, RIR counted back from the set's last rep. */
function pointsFor(set: StoredSet, terminal: number): RirVelocityPoint[] {
  const reps = normaliseVelocityToMps(set).reps;
  const eligible = new Set<Rep>(selectEligibleReps(reps));
  return reps
    .map((rep, index) => ({
      rep,
      rir: terminal + (reps.length - 1 - index),
      velocityMps: getPhaseMeanVelocity(rep.concentric),
    }))
    .filter((p) => eligible.has(p.rep) && p.velocityMps > 0)
    .map(({ rir, velocityMps }) => ({ rir, velocityMps }));
}
