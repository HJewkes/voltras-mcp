// VW-373 (research W2): the §2b control loop over the bodyweight trend — the
// deviation x slope sizing table, the weekly cadence with its half-week floor
// and two-week cap, the three-condition off-cadence gate, and the four vetoes.
//
// SOURCE OF RECORD: the VW-367 bodyweight-rate methodology note (2026-09-13),
// §1, §2a-2d, §4 and §5 row W2. Named by ticket rather than by path, the way
// `bodyweight-trend.ts` and `cumulative-loss.ts` already do: the repo's own
// `voltras/no-protocol-detail` rule bans pointers into trees a reader of this
// file cannot open. Every RP note id below is quotable on its own.
//
// PURE. No store, no clock, no tool surface: `now` is an input, exactly as in
// `bodyweight-trend.ts` and `cumulative-loss.ts`. The trend facts are NOT
// recomputed here — `computeBodyweightTrend` owns the smoothed mean series,
// the weekly delta and the slope class, `computeCumulativeLossFacts` owns the
// diet-fatigue band, and this module only decides what to do about them.
//
// ADVISORY ONLY, AND UNSIZED. RP's own 0-10% / 10-20% / 20-40% figures are
// calorie-adjustment sizes; this server prescribes no calories, so those bands
// rank urgency INTERNALLY as {@link BodyweightRateAdvisory.urgencyRank} and are
// never rendered. What is emitted is the observation plus the two levers,
// intake and activity, with neither sized (rp-s12-activity-vs-food-adjustment-choice;
// HUMAN DECISION 2026-09-13, methodology §6 item 1). A test walks every string
// in the result and fails on a kcal figure, a macro, or a sized adjustment.
//
// EVERY CONSTANT NAMES ITS SOURCE, same convention as `diet-phase-tolerance.ts`,
// `goal-band.ts`, `bodyweight-trend.ts` and `cumulative-loss.ts`: `rp:<id>` for
// a mined note, ENGINEERING DEFAULT for a number the corpus does not state,
// HUMAN DECISION for a call made on a date.

import {
  BODYWEIGHT_TREND_CONSTANTS,
  computeBodyweightTrend,
  type BodyweightMeanPoint,
  type BodyweightSlopeClass,
  type BodyweightTargetLine,
  type BodyweightTrendInput,
} from './bodyweight-trend.js';
import { computeCumulativeLossFacts, type DietFatigueProxyBand } from './cumulative-loss.js';
import { LONG_PHASE_WEEKS, PHASE_SETTLING_WEEKS } from './diet-phase-tolerance.js';
import { GOAL_BAND_CONSTANTS } from './goal-band.js';
import type { DietPhase, RecompMode } from '../store/diet-phase.js';

/**
 * The 3-point scale every weekly self-report field uses.
 *
 * rp:rp-s7-coarse-rating-scale-rationale, Claim verbatim: "RP argues stimulus
 * and fatigue proxies (pump, perturbation, disruption, joint soreness, etc.)
 * should be rated on a coarse 1-2-3 scale rather than a finer 5- or 10-point
 * scale, because most people cannot reliably distinguish more than roughly
 * three levels of a subjective sensation, and finer scales manufacture
 * precision that isn't really there."
 */
export type WeeklySelfReportLevel = 'low' | 'medium' | 'high';

/**
 * The Sunday-anchor weekly check-in, every field optional (methodology §6
 * item 2). `profile.log_weekly_checkin` (VW-374) is the writer; this type is
 * the shape its reader matches.
 *
 * `hunger` is the load-bearing one: it is the lever-choice input
 * (rp:rp-s12-activity-vs-food-adjustment-choice) and one of the two
 * corroborators the off-cadence gate can see. `sleepQuality` is a confounder
 * line only and never a trigger (§2d).
 */
export interface WeeklySelfReport {
  hunger?: WeeklySelfReportLevel;
  dietPlanAdherence?: WeeklySelfReportLevel;
  sleepQuality?: WeeklySelfReportLevel;
}

export interface BodyweightRateAdvisoryInput {
  /** Reused verbatim from `bodyweight-trend.ts`; never re-derived here. */
  trend: BodyweightTrendInput;
  phase: DietPhase;
  /** Read only under `'recomposition'`; declared, never inferred (VW-378). */
  recompMode?: RecompMode;
  /**
   * When this loop last emitted a proposal. `null` means it never has, and the
   * cadence clock then runs from the end of the settling window.
   */
  lastProposalAt: string | null;
  selfReport?: WeeklySelfReport;
}

/** RP's three deviation bands, as percent of bodyweight off the goal line. */
export type DeviationBand = 'small' | 'moderate' | 'large';

/** Which side of the goal line the lifter sits on, in the phase's own terms. */
export type DeviationDirection = 'behind' | 'ahead';

/** The four vetoes of §2b. Each suppresses the proposal and names itself. */
export type BodyweightRateVeto =
  | 'settling'
  | 'noise_floor'
  | 'spike_in_window'
  | 'salt_and_sweetener_creep';

/** The three conditions rp-s12-early-adjustment-signal-combo requires together. */
export type OffCadenceCondition = 'drastic' | 'consistent' | 'corroborated';

export type BodyweightRateOutcome =
  | 'advisory'
  | 'vetoed'
  | 'within_band'
  | 'awaiting_cadence'
  | 'below_half_week_floor'
  | 'flagged_for_review'
  | 'no_rate_to_autoregulate'
  | 'unevaluable';

export interface BodyweightRateVetoRecord {
  veto: BodyweightRateVeto;
  reason: string;
  sourceId: string;
}

export interface OffCadenceConditionRecord {
  condition: OffCadenceCondition;
  met: boolean;
  sourceId: string;
}

export interface BodyweightRateObservation {
  observedPctPerWeek: number | null;
  weeksOutsideBand: number;
  bandLowPctPerWeek: number | null;
  bandHighPctPerWeek: number | null;
  deviationPctOfBodyweight: number | null;
  deviationBand: DeviationBand | null;
  deviationDirection: DeviationDirection | null;
  slopeClass: BodyweightSlopeClass | null;
  weeksInPhase: number;
  dietFatigueBand: DietFatigueProxyBand | null;
}

export interface BodyweightRateAdvisory {
  outcome: BodyweightRateOutcome;
  /** The emitted text, or `null` when nothing is proposed. Never sized. */
  advisory: string | null;
  /** Named in the advisory, never sized. rp:rp-s12-activity-vs-food-adjustment-choice */
  levers: readonly ['intake', 'activity'];
  observation: BodyweightRateObservation;
  /**
   * INTERNAL URGENCY, 0-3, ranking RP's own calorie-adjustment sizing bands.
   * Never surfaced: the advisory text carries no percentage adjustment.
   */
  urgencyRank: number;
  vetoes: readonly BodyweightRateVetoRecord[];
  offCadenceConditions: readonly OffCadenceConditionRecord[];
  daysSinceDecisionPoint: number;
  /** Sleep and disclosed off-plan eating. Reported, never a trigger (§2d). */
  confounders: readonly string[];
  /** Set by disclosed low plan adherence. rp:rp-s12-off-plan-eating-disclosure-pattern */
  lowConfidence: boolean;
  /** Plain data for VW-376's `inputs_json`. */
  inputs: Record<string, unknown>;
  /** Plain data for VW-376's `thresholds_json`. */
  thresholds: Record<string, unknown>;
}

/**
 * Every magnitude this module runs on, labelled by source.
 */
export const BODYWEIGHT_RATE_CONSTANTS = {
  /**
   * Where the small deviation band closes, as percent of bodyweight off the
   * goal line. rp:rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope
   * ("roughly <0.25%, 0.25-1%, or >1%").
   */
  deviationSmallCeilingPct: 0.25,
  /**
   * Where the moderate deviation band closes.
   * rp:rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope, same range.
   */
  deviationModerateCeilingPct: 1,
  /**
   * The fastest a proposal may follow the last one, in days.
   * rp:rp-s12-minimum-half-week-before-recalorie-change, Claim verbatim:
   * "Calorie or macro adjustments should not be made more often than roughly
   * every half week at the fastest, with once-per-week being the normal default
   * cadence".
   */
  halfWeekFloorDays: 3.5,
  /** The normal cadence, in days. Same note ("once-per-week being the normal default cadence"). */
  weeklyCadenceDays: 7,
  /**
   * How long an unresolved signal may sit before the loop forces a decision.
   * rp:rp-s12-two-week-cap-for-slow-signal-situations ("should not be delayed
   * past roughly two weeks").
   */
  twoWeekCapDays: 14,
  /**
   * The window the off-cadence consistency test walks, in days.
   *
   * ENGINEERING DEFAULT. rp-s12-early-adjustment-signal-combo requires "the
   * day-to-day trend is consistent (not a single spike)" and names neither a
   * window nor a metric.
   */
  offCadenceConsistencyDays: 3,
  /**
   * Mean points the consistency test needs inside that window before it can
   * claim anything. ENGINEERING DEFAULT, matching the note's "day-to-day".
   */
  offCadenceConsistencyMinPoints: 3,
  /**
   * How far back the "for N weeks" figure in the advisory text may look.
   *
   * ENGINEERING DEFAULT bounding a display figure only; no gate reads it.
   */
  weeksOutsideBandLookbackWeeks: 8,
  /**
   * How close a mean point must sit to a week boundary to stand in for it.
   *
   * ENGINEERING DEFAULT. Readings are logged when convenient, so an exact
   * 7-day-old point usually does not exist.
   */
  nearestPointToleranceDays: 2,
} as const;

const C = BODYWEIGHT_RATE_CONSTANTS;

/**
 * Deviation x slope, as an internal urgency rank. 0 proposes nothing; 1, 2 and
 * 3 rank RP's 0-10% / 10-20% / 20-40% calorie bands WITHOUT carrying them.
 *
 * Cited cells, from rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope
 * and methodology §2b's transcription of it: `small x diverging` is its 0-10%
 * case, `moderate x similar` its 10-20% case, `large x diverging` its 20-40%
 * case. The whole `converging` column is 0 by
 * rp-s12-trend-slope-overrides-raw-deviation ("if the current trajectory is
 * predicted to converge with the goal line on its own, no change should be
 * made"), which is why this table's `large x converging` differs from
 * `ADVICE_TABLE`'s `large x improving` in `diet-phase-tolerance.ts` — that one
 * runs on a training-load axis, this one on RP's own bodyweight axis.
 *
 * ENGINEERING DEFAULTS, interpolating the cited diagonal: `small x similar`
 * (parallel tracking inside a quarter percent is not a problem),
 * `moderate x diverging` and `large x similar` (both take the lower of the two
 * neighbouring cited bands).
 */
const URGENCY_TABLE: Record<DeviationBand, Record<BodyweightSlopeClass, number>> = {
  small: { converging: 0, similar: 0, diverging: 1 },
  moderate: { converging: 0, similar: 2, diverging: 2 },
  large: { converging: 0, similar: 2, diverging: 3 },
};

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000);
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The band the phase is judged against, in percent of bodyweight per week.
 * `null` means the phase has no rate to autoregulate: under maintenance's ±2%
 * hold corridor the signal is band EXIT, not slope (methodology §4,
 * rp:rp-s12-maintenance-buffer-2pct).
 */
export function rateBandForPhase(
  phase: DietPhase,
  recompMode?: RecompMode,
): { low: number; high: number } | null {
  if (phase === 'fat-loss') return GOAL_BAND_CONSTANTS.bodyweightFatLossPctPerWeek;
  if (phase === 'gain') return GOAL_BAND_CONSTANTS.bodyweightGainPctPerWeek;
  if (phase === 'recomposition' && recompMode === 'slow-loss') {
    return GOAL_BAND_CONSTANTS.recompositionSlowLossPctPerWeek;
  }
  return null;
}

export function classifyDeviationBand(pctOfBodyweight: number): DeviationBand {
  if (pctOfBodyweight > C.deviationModerateCeilingPct) return 'large';
  if (pctOfBodyweight >= C.deviationSmallCeilingPct) return 'moderate';
  return 'small';
}

/** Where the goal line sits at `atIso`, in lbs. */
function targetPositionLbs(
  line: BodyweightTargetLine,
  phaseStartedAt: string,
  atIso: string,
): number {
  return line.startWeightLbs + line.weeklyRateLbs * (daysBetween(phaseStartedAt, atIso) / 7);
}

/**
 * Which way the goal runs: the line's own slope, or the band's stretch when the
 * committed line is flat (a slow-loss recomposition commits to holding weight, VW-468).
 * Zero only when neither says, and then the raw gap is the deviation.
 */
function goalSignOf(line: BodyweightTargetLine, band: RateBand | null): number {
  return Math.sign(line.weeklyRateLbs) || Math.sign(band?.high ?? 0);
}

/** A band whose committed edge is no change: holding weight is on track. */
function commitsToHold(band: RateBand): boolean {
  return band.low === 0 && band.high !== 0;
}

/** Signed distance off the goal line, negative when the lifter is behind it. */
function signedDeviationLbs(
  meanLbs: number,
  line: BodyweightTargetLine,
  goalSign: number,
  phaseStartedAt: string,
  atIso: string,
): number {
  const gap = meanLbs - targetPositionLbs(line, phaseStartedAt, atIso);
  return goalSign === 0 ? gap : gap * goalSign;
}

/** The mean point nearest `targetIso`, or `null` if none is close enough. */
function nearestMeanPoint(
  series: readonly BodyweightMeanPoint[],
  targetIso: string,
): BodyweightMeanPoint | null {
  let best: BodyweightMeanPoint | null = null;
  let bestGap = Infinity;
  for (const point of series) {
    const gap = Math.abs(daysBetween(point.measuredAt, targetIso));
    if (gap < bestGap) {
      best = point;
      bestGap = gap;
    }
  }
  return bestGap <= C.nearestPointToleranceDays ? best : null;
}

type RateBand = { low: number; high: number };

function isInsideBand(pctPerWeek: number, band: RateBand): boolean {
  return pctPerWeek >= Math.min(band.low, band.high) && pctPerWeek <= Math.max(band.low, band.high);
}

/**
 * How many consecutive whole weeks back from `now` the weekly rate sat outside
 * the band. A display figure for the advisory text; no gate reads it.
 */
function countWeeksOutsideBand(
  series: readonly BodyweightMeanPoint[],
  now: string,
  band: { low: number; high: number },
): number {
  let weeks = 0;
  for (let k = 0; k < C.weeksOutsideBandLookbackWeeks; k++) {
    const end = nearestMeanPoint(series, addDays(now, -7 * k));
    const start = nearestMeanPoint(series, addDays(now, -7 * (k + 1)));
    if (end === null || start === null || start.meanLbs === 0) break;
    const pctPerWeek = ((end.meanLbs - start.meanLbs) / start.meanLbs) * 100;
    if (isInsideBand(pctPerWeek, band)) break;
    weeks++;
  }
  return weeks;
}

/**
 * Is the day-to-day trend consistent, rather than one spike? True when every
 * consecutive mean point inside the consistency window moved no closer to the
 * goal line than the one before it.
 * rp:rp-s12-early-adjustment-signal-combo
 */
function isTrendConsistent(
  series: readonly BodyweightMeanPoint[],
  line: BodyweightTargetLine,
  goalSign: number,
  phaseStartedAt: string,
  now: string,
): boolean {
  const window = series.filter((p) => {
    const back = daysBetween(p.measuredAt, now);
    return back >= 0 && back <= C.offCadenceConsistencyDays;
  });
  if (window.length < C.offCadenceConsistencyMinPoints) return false;
  const deviations = window.map((p) =>
    signedDeviationLbs(p.meanLbs, line, goalSign, phaseStartedAt, p.measuredAt),
  );
  return deviations.every((value, i) => i === 0 || value <= deviations[i - 1]);
}

/**
 * Does hunger point the same direction as the deviation?
 *
 * rp:rp-s12-early-adjustment-signal-combo wants "an independent corroborating
 * signal ... (e.g. reported hunger/fullness pointing the same direction)". The
 * mapping is ENGINEERING DEFAULT over rp-s12-activity-vs-food-adjustment-choice:
 * a lifter BEHIND the line who is not hungry has room to tighten, and a lifter
 * AHEAD of it who is hungry is already strained.
 */
function isCorroborated(direction: DeviationDirection | null, report?: WeeklySelfReport): boolean {
  if (direction === null || report?.hunger === undefined) return false;
  return direction === 'behind' ? report.hunger === 'low' : report.hunger === 'high';
}

interface VetoContext {
  rateClass: 'noise' | 'settling' | 'reportable';
  weeklyDeltaLbs: number | null;
  weeksInPhase: number;
  spikeInWindow: boolean;
  phase: DietPhase;
  selfReport: WeeklySelfReport | undefined;
  /** A noise-level week under a hold commitment is a verdict (flat, on track), not a veto. */
  noiseIsOnTrack: boolean;
}

function collectVetoes(ctx: VetoContext): BodyweightRateVetoRecord[] {
  const vetoes: BodyweightRateVetoRecord[] = [];
  if (ctx.rateClass === 'settling') {
    vetoes.push({
      veto: 'settling',
      reason: `Week ${ctx.weeksInPhase} of the phase is still inside the ${PHASE_SETTLING_WEEKS}-week settling window, where glycogen and body water are still moving.`,
      sourceId: 'rp-s12-exclude-water-weight-from-phase-transition-baseline',
    });
  }
  if (ctx.rateClass === 'noise' && ctx.weeklyDeltaLbs !== null && !ctx.noiseIsOnTrack) {
    vetoes.push({
      veto: 'noise_floor',
      reason: `Weekly change is under the ${BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek} lb noise floor, which is water and food mass rather than tissue.`,
      sourceId: 'rp-s12-no-adjustment-under-half-pound-weekly-change',
    });
  }
  if (ctx.spikeInWindow) {
    vetoes.push({
      veto: 'spike_in_window',
      reason: `A single-day jump inside the last ${BODYWEIGHT_TREND_CONSTANTS.spikeDownweightDays} days is still down-weighted; wait for the weight to restabilise.`,
      sourceId: 'rp-s12-scale-opacity-salt-and-water',
    });
  }
  if (isSaltCreepVeto(ctx)) {
    vetoes.push({
      veto: 'salt_and_sweetener_creep',
      reason:
        'The scale is flat or slightly up late in a cut while plan adherence is reported high; ask about salt and diet-beverage creep before reading it as stalled fat loss.',
      sourceId: 'rp-s12-late-diet-salt-sweetener-creep-masks-fat-loss',
    });
  }
  return vetoes;
}

function isSaltCreepVeto(ctx: VetoContext): boolean {
  return (
    ctx.phase === 'fat-loss' &&
    ctx.weeksInPhase >= LONG_PHASE_WEEKS &&
    ctx.weeklyDeltaLbs !== null &&
    ctx.weeklyDeltaLbs >= 0 &&
    ctx.selfReport?.dietPlanAdherence === 'high'
  );
}

function collectConfounders(report?: WeeklySelfReport): string[] {
  const confounders: string[] = [];
  if (report?.sleepQuality === 'low') {
    confounders.push(
      'Sleep is reported low. The corpus treats sleep as a confound on a single session, never as a rate trigger, so nothing above turns on it.',
    );
  }
  if (report?.dietPlanAdherence === 'low') {
    confounders.push(
      'Plan adherence is reported low, so this period is marked low-confidence and the trend is read as observation rather than response.',
    );
  }
  return confounders;
}

/** One decimal, trailing zero trimmed, so "0.50" reads as "0.5". */
function fmt(value: number): string {
  return String(Number(value.toFixed(2)));
}

function bandText(band: { low: number; high: number }): string {
  const edges = [Math.abs(band.low), Math.abs(band.high)].sort((a, b) => a - b);
  return `${fmt(edges[0])}-${fmt(edges[1])}%`;
}

/**
 * The emitted text: the observation, then the two levers, neither sized.
 * rp:rp-s12-activity-vs-food-adjustment-choice; HUMAN DECISION 2026-09-13.
 */
function buildAdvisoryText(
  observation: BodyweightRateObservation,
  band: { low: number; high: number },
): string {
  const rate = observation.observedPctPerWeek ?? 0;
  const verb = rate < 0 ? 'Losing' : 'Gaining';
  const weeks = observation.weeksOutsideBand;
  const span = weeks <= 1 ? 'the last week' : `the last ${weeks} weeks`;
  return (
    `${verb} ${fmt(Math.abs(rate))}%/wk over ${span}, against a ${bandText(band)}/wk band. ` +
    'The two levers are intake and activity. Which one to move is yours to pick, and this server does not size either.'
  );
}

function reviewText(vetoes: readonly BodyweightRateVetoRecord[]): string {
  const held =
    vetoes.length > 0
      ? ` The signal has been held by: ${vetoes.map((v) => v.veto).join(', ')}.`
      : '';
  return (
    `The bodyweight signal has not resolved in ${C.twoWeekCapDays} days, so it is flagged for a decision ` +
    `rather than deferred again (rp-s12-two-week-cap-for-slow-signal-situations).${held}`
  );
}

/** The instant the cadence and cap clocks run from. */
function decisionPointIso(input: BodyweightRateAdvisoryInput): string {
  if (input.lastProposalAt !== null) return input.lastProposalAt;
  return addDays(input.trend.phaseStartedAt, PHASE_SETTLING_WEEKS * 7);
}

interface CadenceVerdict {
  outcome: BodyweightRateOutcome;
  conditions: OffCadenceConditionRecord[];
}

function cadenceVerdict(
  daysSince: number,
  urgencyRank: number,
  conditions: OffCadenceConditionRecord[],
): CadenceVerdict {
  if (urgencyRank === 0) return { outcome: 'within_band', conditions: [] };
  if (daysSince < C.halfWeekFloorDays) {
    return { outcome: 'below_half_week_floor', conditions: [] };
  }
  if (daysSince >= C.weeklyCadenceDays) return { outcome: 'advisory', conditions: [] };
  const allThree = conditions.every((c) => c.met);
  return { outcome: allThree ? 'advisory' : 'awaiting_cadence', conditions };
}

function offCadenceConditions(
  deviationBand: DeviationBand | null,
  consistent: boolean,
  corroborated: boolean,
): OffCadenceConditionRecord[] {
  const sourceId = 'rp-s12-early-adjustment-signal-combo';
  return [
    { condition: 'drastic', met: deviationBand === 'large', sourceId },
    { condition: 'consistent', met: consistent, sourceId },
    { condition: 'corroborated', met: corroborated, sourceId },
  ];
}

function buildThresholds(band: { low: number; high: number } | null): Record<string, unknown> {
  return {
    ...C,
    bandLowPctPerWeek: band?.low ?? null,
    bandHighPctPerWeek: band?.high ?? null,
    noiseFloorLbsPerWeek: BODYWEIGHT_TREND_CONSTANTS.noiseFloorLbsPerWeek,
    spikeDownweightDays: BODYWEIGHT_TREND_CONSTANTS.spikeDownweightDays,
    phaseSettlingWeeks: PHASE_SETTLING_WEEKS,
    lateCutWeeks: LONG_PHASE_WEEKS,
  };
}

function buildInputs(input: BodyweightRateAdvisoryInput): Record<string, unknown> {
  return {
    now: input.trend.now,
    phase: input.phase,
    recompMode: input.recompMode ?? null,
    phaseStartedAt: input.trend.phaseStartedAt,
    targetLine: { ...input.trend.targetLine },
    readingCount: input.trend.readings.length,
    lastProposalAt: input.lastProposalAt,
    selfReport: { ...(input.selfReport ?? {}) },
  };
}

function emptyAdvisory(
  input: BodyweightRateAdvisoryInput,
  outcome: BodyweightRateOutcome,
  observation: BodyweightRateObservation,
  band: { low: number; high: number } | null,
): BodyweightRateAdvisory {
  return {
    outcome,
    advisory: null,
    levers: ['intake', 'activity'],
    observation,
    urgencyRank: 0,
    vetoes: [],
    offCadenceConditions: [],
    daysSinceDecisionPoint: daysBetween(decisionPointIso(input), input.trend.now),
    confounders: collectConfounders(input.selfReport),
    lowConfidence: input.selfReport?.dietPlanAdherence === 'low',
    inputs: buildInputs(input),
    thresholds: buildThresholds(band),
  };
}

/**
 * Run the §2b control loop for one lifter at one instant. No I/O, no
 * `Date.now()` — `input.trend.now` is the only clock.
 */
export function computeBodyweightRateAdvisory(
  input: BodyweightRateAdvisoryInput,
): BodyweightRateAdvisory {
  const trend = computeBodyweightTrend(input.trend);
  const facts = computeCumulativeLossFacts(input.trend);
  const band = rateBandForPhase(input.phase, input.recompMode);
  const latest = trend.meanSeries.at(-1) ?? null;
  const observation = buildObservation(input, trend, facts, band, latest);

  if (band === null) return emptyAdvisory(input, 'no_rate_to_autoregulate', observation, band);

  const spikeInWindow = trend.adjustments.some((a) => {
    const back = daysBetween(a.measuredAt, input.trend.now);
    return back >= 0 && back < BODYWEIGHT_TREND_CONSTANTS.spikeDownweightDays;
  });
  const vetoes = collectVetoes({
    rateClass: trend.rateClass,
    weeklyDeltaLbs: trend.weeklyDeltaLbs,
    weeksInPhase: trend.weeksInPhase,
    spikeInWindow,
    phase: input.phase,
    selfReport: input.selfReport,
    noiseIsOnTrack: commitsToHold(band),
  });
  return assemble(input, observation, band, vetoes, trend.meanSeries);
}

function buildObservation(
  input: BodyweightRateAdvisoryInput,
  trend: ReturnType<typeof computeBodyweightTrend>,
  facts: ReturnType<typeof computeCumulativeLossFacts>,
  band: { low: number; high: number } | null,
  latest: BodyweightMeanPoint | null,
): BodyweightRateObservation {
  const line = input.trend.targetLine;
  const signed =
    latest === null
      ? null
      : signedDeviationLbs(
          latest.meanLbs,
          line,
          goalSignOf(line, band),
          input.trend.phaseStartedAt,
          input.trend.now,
        );
  const deviationPct =
    latest === null || signed === null ? null : (Math.abs(signed) / latest.meanLbs) * 100;
  return {
    observedPctPerWeek:
      trend.weeklyDeltaLbs === null || latest === null
        ? null
        : (trend.weeklyDeltaLbs / latest.meanLbs) * 100,
    weeksOutsideBand:
      band === null ? 0 : countWeeksOutsideBand(trend.meanSeries, input.trend.now, band),
    bandLowPctPerWeek: band?.low ?? null,
    bandHighPctPerWeek: band?.high ?? null,
    deviationPctOfBodyweight: deviationPct,
    deviationBand: deviationPct === null ? null : classifyDeviationBand(deviationPct),
    deviationDirection: signed === null ? null : signed < 0 ? 'behind' : 'ahead',
    slopeClass: trend.slopeClass,
    weeksInPhase: trend.weeksInPhase,
    dietFatigueBand: facts.band,
  };
}

/**
 * Losing inside a hold-committed band is the stretch being earned, not a drift to correct;
 * past the stretch edge it is outside the band and the ladder applies again.
 */
function aheadInsideHoldBand(observation: BodyweightRateObservation, band: RateBand): boolean {
  return (
    commitsToHold(band) &&
    observation.deviationDirection === 'ahead' &&
    observation.observedPctPerWeek !== null &&
    isInsideBand(observation.observedPctPerWeek, band)
  );
}

/** Fold the vetoes, the cadence and the two-week cap into one result. */
function assemble(
  input: BodyweightRateAdvisoryInput,
  observation: BodyweightRateObservation,
  band: { low: number; high: number },
  vetoes: BodyweightRateVetoRecord[],
  meanSeries: readonly BodyweightMeanPoint[],
): BodyweightRateAdvisory {
  const base = emptyAdvisory(input, 'unevaluable', observation, band);
  const daysSince = base.daysSinceDecisionPoint;
  const unresolved = vetoes.length > 0 || observation.slopeClass === null;
  if (unresolved && daysSince >= C.twoWeekCapDays) {
    return { ...base, outcome: 'flagged_for_review', advisory: reviewText(vetoes), vetoes };
  }
  if (vetoes.length > 0) return { ...base, outcome: 'vetoed', vetoes };
  if (observation.slopeClass === null || observation.deviationBand === null) return base;

  const urgencyRank = aheadInsideHoldBand(observation, band)
    ? 0
    : URGENCY_TABLE[observation.deviationBand][observation.slopeClass];
  const conditions = offCadenceConditions(
    observation.deviationBand,
    isTrendConsistent(
      meanSeries,
      input.trend.targetLine,
      goalSignOf(input.trend.targetLine, band),
      input.trend.phaseStartedAt,
      input.trend.now,
    ),
    isCorroborated(observation.deviationDirection, input.selfReport),
  );
  const verdict = cadenceVerdict(daysSince, urgencyRank, conditions);
  return {
    ...base,
    outcome: verdict.outcome,
    advisory: verdict.outcome === 'advisory' ? buildAdvisoryText(observation, band) : null,
    urgencyRank,
    offCadenceConditions: verdict.conditions,
  };
}
