// Rep eligibility (VW-168 / VW-181) — one rule for "is this rep real work?".
//
// The 2026-09-07 dogfood opened every triceps and curl set with a rope-
// positioning pull: ~1 m of cable at ~1.6 m/s against a working rep of ~0.5 m
// at ~0.8 m/s. That pull became rep 1 of the set and, being the fastest rep in
// it, became the `velocity_loss_exceeded` baseline — so the trigger fired on
// rep 2 of every set. The same pull is what auto-arm opens a set on.
//
// One predicate answers all three questions (baseline, arm trigger, adopted
// tail), so the summary, the trigger and the RIR estimate can never disagree
// about which reps were work.
//
// THE RULE IS SYMMETRIC. A rep is an outlier when it is much BIGGER than its
// neighbours (the positioning pull) or much SMALLER (a half-rep partial, a
// cable bump between sets). Both are "not a rep like the others", and picking
// only the upper tail would let a 0.1 m twitch anchor the ROM median.
//
// It is also RELATIVE, never absolute: nothing here knows what a curl "should"
// measure. A rep is judged only against the other reps in its own window, so
// the rule holds across exercises, lifters and cable geometries.

import { getPhaseRangeOfMotion, type Rep } from '@voltras/workout-analytics';

/**
 * Concentric ROM more than this multiple of the median of the other reps (or
 * less than its reciprocal) is an outlier. The 2026-09-07 pull ran ~2.0x the
 * working reps around it; a deliberately deep or shallow rep inside a real set
 * stays under ~1.5x, so the gate sits between the two.
 */
const ROM_OUTLIER_RATIO = 1.8;

/**
 * Same test on peak concentric velocity, in m/s (VW-160). The pull ran ~1.9x
 * the working concentrics; rep 1 of a fresh set is routinely 1.2-1.3x the set
 * median simply because it is the least fatigued, and that rep is real work.
 */
const VELOCITY_OUTLIER_RATIO = 1.6;

/**
 * A concentric with fewer movement samples than this has no measurable ROM —
 * the in-progress rep at a boundary carries exactly one. Such a rep is not
 * evidence about anything and is dropped from the comparison window rather
 * than being allowed to drag the median to zero.
 */
const MIN_MEASURABLE_MOVEMENT_SAMPLES = 2;

/**
 * How many reps at the head of an eccentric-overloaded set are dropped from
 * velocity-loss accounting (VW-268).
 *
 * Yang 2026 (AEL meta-analysis): an overloaded eccentric impairs the mean
 * velocity of the concentric that follows it by ES -0.25, and the impairment
 * is gone by the second or third repetition. That rep is slower for mechanical
 * reasons, not fatigue, so feeding it to `velocity_loss_exceeded` ends the set
 * early.
 *
 * TWO, MEASURED FROM THE HEAD OF THE SET — not "the rep after each overloaded
 * eccentric". The device carries ONE set-level eccentric setting, never a
 * per-rep record of which eccentrics were overloaded, so "after each" would
 * degenerate to every rep but the first and leave nothing to compare. What the
 * data model can prove is the entry into the overloaded regime: rep 1 has no
 * overloaded eccentric before it and is therefore the only un-depressed rep in
 * the set, and rep 2 is the first depressed one, inside Yang's reps-2-3
 * dissipation window. From rep 3 on, every rep sits in the same mechanical
 * regime and the velocity differences between them are fatigue.
 */
export const ECCENTRIC_OVERLOAD_LEAD_IN_REPS = 2;

export type RepIneligibleReason = 'rom_outlier' | 'velocity_outlier' | 'first_rep_unconfirmed';

export interface RepEligibility {
  eligible: boolean;
  reason?: RepIneligibleReason;
}

/**
 * Is `rep` real work, judged against the other reps in its window?
 *
 * `priorReps` is every OTHER rep in the window — named for the common case
 * where they precede it, but a rep at the head of a finished set is judged
 * against the reps that follow it, which is what lets a genuinely fast rep 1
 * stay eligible.
 *
 * With no measurable rep to compare against, the answer is
 * `first_rep_unconfirmed`: not a judgement that the rep is bad, a statement
 * that nothing corroborates it yet. Callers decide what to do with that —
 * {@link selectEligibleReps} keeps such a rep, the auto-arm gate waits.
 */
export function isRepEligible(rep: Rep, context: { priorReps: readonly Rep[] }): RepEligibility {
  const others = context.priorReps.filter(isMeasurable);
  if (others.length === 0 || !isMeasurable(rep)) {
    return { eligible: false, reason: 'first_rep_unconfirmed' };
  }
  if (isOutlier(concentricRom(rep), others.map(concentricRom), ROM_OUTLIER_RATIO)) {
    return { eligible: false, reason: 'rom_outlier' };
  }
  if (isOutlier(peakVelocity(rep), others.map(peakVelocity), VELOCITY_OUTLIER_RATIO)) {
    return { eligible: false, reason: 'velocity_outlier' };
  }
  return { eligible: true };
}

/**
 * The reps in `reps` that count as work — the window every velocity baseline,
 * first-rep pick and RIR denominator is taken over.
 *
 * Falls back to the input untouched when the filter would empty it (a one-rep
 * window, or a window where every rep is unconfirmed). Excluding a rep is a
 * claim that some OTHER rep is the norm; with no norm to appeal to, keeping
 * the data is the honest default and preserves today's behaviour exactly.
 */
export function selectEligibleReps(reps: readonly Rep[]): readonly Rep[] {
  const kept = reps.filter((rep, i) => isRepEligible(rep, { priorReps: others(reps, i) }).eligible);
  return kept.length === 0 ? reps : kept;
}

/**
 * How many head-of-set reps this eccentric setting excludes: 2, or none.
 *
 * `eccentricOverload` is the setting observed on the device, where a positive
 * value means the eccentric phase is loaded ABOVE the concentric. Zero,
 * negative and unobserved are all ordinary sets that exclude nothing.
 */
export function eccentricOverloadLeadIn(eccentricOverload: number | undefined): number {
  return (eccentricOverload ?? 0) > 0 ? ECCENTRIC_OVERLOAD_LEAD_IN_REPS : 0;
}

/**
 * Reps a set's eccentric setting keeps out of velocity-loss accounting
 * (VW-268). `leadInReps: 0` with a null reason is the ordinary set — nothing
 * was excluded and the figures mean what they always meant.
 */
export interface VelocityLossExclusion {
  leadInReps: number;
  reason: 'eccentric_overload' | null;
}

/** Nothing excluded. The shape every non-overloaded set reports. */
export const NO_VELOCITY_LOSS_EXCLUSION: VelocityLossExclusion = {
  leadInReps: 0,
  reason: null,
};

/**
 * Are two adjacent closed reps consistent with each other (VW-181)?
 *
 * Used by auto-arm to decide whether the rep before the one it is arming on
 * was work or a positioning pull. Order matters: when the two disagree, the
 * LATER rep is the reference and the earlier one is the outlier. A positioning
 * artifact happens at the head of a window — you pull the cable out, then you
 * lift — never after real work has started.
 *
 * A pair that cannot be judged (either rep carries too little movement to
 * measure) is CONSISTENT. Only positive evidence excludes a rep; "we couldn't
 * tell" must not cost the lifter a rep.
 */
export function isTailPairConsistent(earlier: Rep, later: Rep): boolean {
  const verdict = isRepEligible(earlier, { priorReps: [later] });
  return verdict.eligible || verdict.reason === 'first_rep_unconfirmed';
}

/** Every rep in `reps` except the one at `index`. */
function others(reps: readonly Rep[], index: number): Rep[] {
  return reps.filter((_, i) => i !== index);
}

function isMeasurable(rep: Rep): boolean {
  return rep.concentric._movementSampleCount >= MIN_MEASURABLE_MOVEMENT_SAMPLES;
}

function concentricRom(rep: Rep): number {
  return getPhaseRangeOfMotion(rep.concentric);
}

function peakVelocity(rep: Rep): number {
  return rep.concentric.peakVelocity;
}

/**
 * Is `value` off the median of `comparators` by more than `ratio` in either
 * direction? A non-positive median means the comparators carry no signal, so
 * nothing can be called an outlier against them.
 */
function isOutlier(value: number, comparators: number[], ratio: number): boolean {
  const reference = median(comparators);
  if (reference <= 0) return false;
  const observed = value / reference;
  return observed > ratio || observed < 1 / ratio;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
