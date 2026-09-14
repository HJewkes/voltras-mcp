// Diet-phase-aware autoregulation tolerance (VW-277) — the two-axis adjustment
// table that decides how big a training-load response a performance deviation
// earns, and how far a declared diet phase moves the line before it earns one.
//
// THIS IS THE MODULE `store/diet-phase.ts` SAYS DOES NOT EXIST. That header
// states "no interpretation lives here or downstream" for VW-149/VW-150, and
// that was true of the phase TAG: the tag was reported next to a verdict for a
// reader to discount by hand. VW-277 is the decision to do the discounting in
// code, and the RP corpus is what makes it citable — rp-s12-idea-1 asks for
// exactly it, and `coaching.explain`'s own `diet.phase_coupling` topic already
// tells a caller to "widen the app's 'normal' band or suppress plateau alerts
// based on weeks-in-phase". The comparability path still does not interpret;
// only the callers listed in that module's header note now do.
//
// THE PHASE VOCABULARY IS THE STORE'S. `DietPhase` is fat-loss / gain /
// maintenance (VW-149) plus recomposition (VW-363), not the cut / maintain /
// gain wording VW-277's ticket uses — those name the same states and a second
// spelling of a persisted enum would be a bug waiting to happen.
//
// EVERY NUMBER HERE CARRIES ITS SOURCE. A cell taken from a mined note names
// the note id; a cell chosen to keep the table monotone says "engineering
// default". The RP material is about CALORIE adjustments off a body-weight
// trend, and this table adjusts TRAINING LOAD off a performance trend, so what
// transfers is the shape — three deviation bands, three slopes, magnitude
// rising with both — and not the percentages. Where a cut point had to be
// invented, it is an engineering default even when the band it sits in is not.

import type { DietPhase } from '../store/diet-phase.js';

/**
 * How far performance sits from where the plan expected it, as a percentage.
 *
 * SIGNED. Negative is behind (a performance dip), positive is ahead (progress
 * faster than expected). Both directions run through the same table — the
 * ahead-of-schedule case is a decision too, not silence (rp-s12-idea-6).
 *
 * WHAT THE PERCENT MEASURES, ACROSS CONSUMERS: distance past the point where
 * the consumer's own analytics starts to be concerned, normalised so that
 * concern point sits at {@link SMALL_DEVIATION_PCT}. `plan.suggest_progression`
 * maps reps missed against the prescribed band 1:1, `session.readiness` maps
 * the warm-up velocity dip 1:1, and `history.trend` maps a plateau's run length
 * against `detectPlateau`'s own `minDays` floor. Each consumer states its
 * mapping; none of them invents a threshold the analytics did not already have.
 */
export type DeviationPct = number;

/** Which of the three deviation bands a deviation lands in, after tolerance. */
export type DeviationBand = 'small' | 'moderate' | 'large';

/**
 * The trend axis. RP's own words are converging / similar-slope / diverging
 * against a goal line; against a performance trend those read as improving /
 * flat / declining, which is the same three states with the sign fixed to
 * "good for the lifter" (rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope).
 */
export type TrendSlope = 'improving' | 'flat' | 'declining';

/**
 * How big a response the table says the deviation earns. The percentage bands
 * are RP's own, quoted for a caller that wants to state one:
 * `minor` 0-10%, `moderate` 10-20%, `major` 20-40%
 * (rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope).
 */
export type AdviceMagnitude = 'none' | 'minor' | 'moderate' | 'major';

/**
 * The unwidened small/moderate boundary, in percent of expected performance.
 *
 * ENGINEERING DEFAULT. It matches `detectPlateau`'s own default
 * `thresholdPct` of 5, so a deviation this server already calls flat is the
 * same deviation this table calls small. The RP note this table's shape comes
 * from bands a BODY-WEIGHT deviation (<0.25% / 0.25-1% / >1%), which says
 * nothing about a load or velocity deviation.
 */
export const SMALL_DEVIATION_PCT = 5;

/**
 * The unwidened moderate/large boundary, in percent of expected performance.
 *
 * ENGINEERING DEFAULT for the value, cited for the ratio: 4x the small edge,
 * the same 0.25%-to-1% spread
 * rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope puts between its
 * own small and moderate body-weight bands.
 */
const LARGE_DEVIATION_PCT = 20;

/**
 * The two-axis table: deviation band x trend slope -> advice magnitude.
 *
 * Six of the nine cells are cited, three are engineering defaults that keep the
 * table monotone (magnitude never falls as either axis worsens):
 *
 * - `small x improving`, `moderate x improving` — rp-s12-trend-slope-overrides-raw-deviation:
 *   a trend already converging on its own needs no help, however off-target the
 *   current reading is. This is the cell most naive logic gets wrong.
 * - `small x flat` — rp-s12-no-adjustment-under-half-pound-weekly-change: below
 *   the noise floor there is nothing to act on.
 * - `small x declining` — the 0-10% band of
 *   rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope: small gap,
 *   but the slope is against the lifter.
 * - `moderate x flat` — that note verbatim: "10-20% for moderate deviations
 *   with a similar (non-converging, non-diverging) slope".
 * - `large x declining` — that note verbatim: "20-40% for large deviations with
 *   a diverging trend".
 * - `moderate x declining`, `large x flat`, `large x improving` — engineering
 *   defaults. The note names only its diagonal; these three interpolate it.
 */
const ADVICE_TABLE: Record<DeviationBand, Record<TrendSlope, AdviceMagnitude>> = {
  small: { improving: 'none', flat: 'none', declining: 'minor' },
  moderate: { improving: 'none', flat: 'moderate', declining: 'moderate' },
  large: { improving: 'minor', flat: 'moderate', declining: 'major' },
};

/** The percentage band `magnitude` names, for copy that wants to state one. */
export const ADVICE_PERCENT_BAND: Record<AdviceMagnitude, string> = {
  none: 'no change',
  minor: '0-10%',
  moderate: '10-20%',
  major: '20-40%',
};

/**
 * The end of the phase-transition window, in weeks.
 *
 * CITED. rp-s12-two-week-cap-for-slow-signal-situations names "the first couple
 * of weeks after a phase transition, when body water is still re-normalizing"
 * as the window where the signal has not clarified yet, and caps the wait
 * there. So weeks 1-2 of any phase get the phase's tolerance only partly: the
 * reason to hold off is still noise, not yet accumulated diet fatigue.
 */
const PHASE_SETTLING_WEEKS = 2;

/**
 * Where a fat-loss phase stops being short and starts being long, in weeks.
 *
 * CITED. rp-s12-diet-phase-length-for-adherence puts a diet phase at 1-3
 * months; `coaching.explain`'s `diet.phase_durations` puts fat loss at 8-12
 * weeks. Week 9 is past the short end of both, and at RP's own 0.5-1%/week
 * fat-loss pace it is also past the ~7% cumulative loss that
 * rp-s11-diet-fatigue-pct-weight-lost-proxy calls noticeable diet fatigue.
 */
const LONG_PHASE_WEEKS = 8;

/**
 * What a phase and its elapsed weeks do to the band edges.
 *
 * A multiplier above 1 WIDENS: the same dip lands in a smaller band, so the
 * table advises less. Below 1 TIGHTENS. The direction of each entry is the
 * point of VW-277 and is cited; the magnitudes are engineering defaults.
 *
 * - fat-loss widens, and widens further with weeks in phase, because reduced
 *   bar-speed and even slight strength regression are EXPECTED in a deficit
 *   rather than a stall (rp-s11-diet-phase-training-fatigue-coupling, quoted in
 *   `coaching.explain`'s `diet.phase_coupling`).
 * - gain tightens once the phase has settled: a surplus should be producing
 *   progress, so a dip that persists in one is less likely to be the diet and
 *   more likely to be the training (the same coupling note read the other way).
 * - maintenance is the neutral case and moves nothing, which is also what an
 *   undeclared phase gets. `recomposition` is a fourth label over the same
 *   arithmetic (VW-363): the corpus treats it as a maintenance-calorie
 *   strategy, not a fourth physiology, so it moves nothing either.
 */
function toleranceMultiplierFor(phase: DietPhase, weeksInPhase: number): number {
  if (phase === 'maintenance' || phase === 'recomposition') return 1;
  if (weeksInPhase <= PHASE_SETTLING_WEEKS) {
    // Engineering defaults. Inside the settling window the widening is partial
    // and the tightening is withheld entirely — there is not yet a phase
    // effect to tighten against.
    return phase === 'fat-loss' ? 1.25 : 1;
  }
  if (phase === 'gain') return 0.75; // engineering default
  return weeksInPhase > LONG_PHASE_WEEKS ? 2.25 : 1.75; // engineering defaults
}

/** What the caller knows about the lifter's declared phase. */
export interface DietPhaseState {
  /** `'unknown'` when no declared range covers the window being judged. */
  phase: DietPhase | 'unknown';
  /** 1-based; week 1 is the first seven days. `null` when the phase is unknown. */
  weeksInPhase: number | null;
}

/** The context field every VW-277 consumer reports back, unchanged in shape. */
export interface DietPhaseContext {
  phase: DietPhase | 'unknown';
  weeksInPhase: number | null;
  /** True only when the phase actually moved a band edge off its unwidened value. */
  toleranceApplied: boolean;
}

export interface ToleranceVerdict {
  context: DietPhaseContext;
  /** What the band edges were multiplied by; 1 means the table ran unmodified. */
  toleranceMultiplier: number;
  band: DeviationBand;
  slope: TrendSlope;
  /** Which side of the plan the lifter is on. */
  direction: 'behind' | 'ahead';
  magnitude: AdviceMagnitude;
  /**
   * What the table would have said with the phase undeclared. Consumers act on
   * the DIFFERENCE between this and `magnitude`, never on `magnitude` alone —
   * that is what keeps an undeclared phase and a maintenance phase byte-identical
   * to the pre-VW-277 numbers.
   */
  untoleratedMagnitude: AdviceMagnitude;
  /** One clause, ready to append to a caller's own reasoning string. */
  rationale: string;
  /**
   * The three responses RP names for a lifter running AHEAD of plan, empty
   * otherwise. Presented, never auto-selected: both ahead-of-schedule notes say
   * the choice turns on fatigue and momentum self-report, not on the trend
   * (rp-s12-ahead-of-schedule-fat-loss-options,
   * rp-s12-ahead-of-schedule-muscle-gain-options).
   */
  aheadOptions: readonly string[];
}

/**
 * Weeks elapsed in a phase that started at `startedAt`, 1-based: the first
 * seven days are week 1, matching how the coaching copy counts ("week 1 of a
 * cut"). A start in the future clamps to week 1 rather than going negative.
 */
export function weeksInPhaseAt(startedAt: string, nowIso: string): number {
  const elapsedMs = new Date(nowIso).getTime() - new Date(startedAt).getTime();
  const days = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

/**
 * Run the table. `deviationPct` is signed (see {@link DeviationPct}); `slope`
 * is the trend of the same quantity, and a caller with only one data point
 * passes `'flat'` rather than guessing a direction.
 *
 * Tolerance scales the BAND EDGES, not the deviation: a widened cut keeps the
 * lifter's real dip intact in the response and only changes which band it falls
 * in. Nothing here rewrites a measurement.
 */
export function dietPhaseTolerance(
  state: DietPhaseState,
  deviationPct: DeviationPct,
  slope: TrendSlope,
): ToleranceVerdict {
  const phase = state.phase;
  const weeksInPhase = state.weeksInPhase;
  const multiplier =
    phase === 'unknown' || weeksInPhase === null ? 1 : toleranceMultiplierFor(phase, weeksInPhase);
  const band = bandFor(Math.abs(deviationPct), multiplier);
  const direction = deviationPct > 0 ? 'ahead' : 'behind';
  const magnitude = ADVICE_TABLE[band][slope];
  const context: DietPhaseContext = { phase, weeksInPhase, toleranceApplied: multiplier !== 1 };
  return {
    context,
    toleranceMultiplier: multiplier,
    band,
    slope,
    direction,
    magnitude,
    untoleratedMagnitude: ADVICE_TABLE[bandFor(Math.abs(deviationPct), 1)][slope],
    rationale: rationaleFor(context, multiplier, band, direction, magnitude),
    aheadOptions: direction === 'ahead' && magnitude !== 'none' ? aheadOptionsFor(phase) : [],
  };
}

const MAGNITUDE_RANK: Record<AdviceMagnitude, number> = {
  none: 0,
  minor: 1,
  moderate: 2,
  major: 3,
};

/**
 * What the declared phase did to the advice, against the same deviation judged
 * with no phase at all.
 *
 * THE ASYMMETRY AT THE CONSUMERS IS DELIBERATE. A `'softened'` verdict lets a
 * consumer downgrade a finding its own analytics made — that is VW-277's whole
 * point, and the RP material supports it (a deficit is EXPECTED to cost bar
 * speed). A `'hardened'` verdict never manufactures a finding the underlying
 * analytics declined to make: a gain phase makes this server ask the
 * ahead-of-schedule question sooner and says so in the rationale, but it does
 * not invent a plateau `detectPlateau` did not find. Inventing one would be a
 * claim with no measurement behind it.
 */
export function toleranceEffect(verdict: ToleranceVerdict): 'softened' | 'hardened' | 'none' {
  const delta = MAGNITUDE_RANK[verdict.magnitude] - MAGNITUDE_RANK[verdict.untoleratedMagnitude];
  if (delta < 0) return 'softened';
  if (delta > 0) return 'hardened';
  return 'none';
}

function bandFor(absDeviationPct: number, multiplier: number): DeviationBand {
  if (absDeviationPct < SMALL_DEVIATION_PCT * multiplier) return 'small';
  if (absDeviationPct < LARGE_DEVIATION_PCT * multiplier) return 'moderate';
  return 'large';
}

/**
 * The three options for a lifter running ahead of plan, in RP's own order.
 * Maintenance, recomposition and an unknown phase all get the fat-loss list's
 * shape minus its diet wording — the decision ("bank it, split it, or stop
 * early") is the same one.
 */
function aheadOptionsFor(phase: DietPhase | 'unknown'): readonly string[] {
  if (phase === 'gain') {
    return [
      'keep the current progression and raise the end-of-block target',
      'halve the progression step and reassess',
      'hold the current load and let the extra progress consolidate',
    ];
  }
  return [
    'keep the current progression to bank the extra progress, if fatigue is low',
    'split the difference between the current step and holding',
    'hold here and end the block early on the progress already made',
  ];
}

function rationaleFor(
  context: DietPhaseContext,
  multiplier: number,
  band: DeviationBand,
  direction: 'behind' | 'ahead',
  magnitude: AdviceMagnitude,
): string {
  const where = direction === 'ahead' ? 'ahead of' : 'behind';
  const sized = `${band} deviation ${where} plan, advice ${ADVICE_PERCENT_BAND[magnitude]}`;
  if (!context.toleranceApplied) {
    const why = context.phase === 'unknown' ? 'no diet phase declared' : `${context.phase} phase`;
    return `${sized} (${why}; tolerance unchanged)`;
  }
  const verb = multiplier > 1 ? 'widened' : 'tightened';
  return (
    `${sized} (week ${context.weeksInPhase} of a ${context.phase} phase ` +
    `${verb} the tolerance ${multiplier}x)`
  );
}
