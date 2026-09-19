// Pure read-model for the `#/goals` page's per-target card (VW-351, plan G4').
//
// `buildGoalProgressView` answers, for ONE coach-derived target: where is the
// band this week, where did the lifter actually land, what does that read as,
// and what — if anything — is the lifter being asked to decide. It performs NO
// I/O and reads no clock: the caller passes `now`, the already-fetched rows and
// the band, so the same inputs always produce the same view. The route (G5) owns
// the store reads; this module owns the arithmetic and the wording.
//
// THE TARGET NEVER MOVES. A `behind` reading produces a PROGRAMMING advisory —
// which lever to pull — and never a smaller number (human decision 2026-09-13,
// enforced in the store by `putGoalTarget`'s `GOAL_TARGET_FIXED`). `committed`
// and `stretch` on the view are the TARGET's two fixed numbers, not the band's;
// the band supplies the weekly corridor the reading is judged against, and the
// two are allowed to disagree once a band is recomputed mid-block.
//
// SLOPE BEFORE DEVIATION. Status comes out of `dietPhaseTolerance`, whose trend
// axis overrides a raw deviation (rp:rp-s12-trend-slope-overrides-raw-deviation):
// a lifter converging on the line needs no advice however far off it they are
// today, and magnitude `none` reads `on_track` even off the line. The deviation
// handed to that table is NORMALISED so the band edge sits exactly at
// `SMALL_DEVIATION_PCT` — the band is this consumer's own concern point, the
// same mapping every other VW-277 consumer states for itself.
//
// TWO WIDENINGS, ONE PHASE, ON PURPOSE. `deriveGoalBand` already re-centres and
// widens a strength band for the declared diet phase; the tolerance read then
// decides whether a miss AGAINST that line earns a verdict at all. The first
// moves where the line is, the second decides what a miss off it means. That is
// what makes `tolerated` a status rather than just a wider band.
//
// NOTHING HERE IS GAMIFIED. There are no streaks (the only rolling figure is a
// 28-day count), a miss is never scored, and praise is quiet per set and loud
// per mesocycle (human decision 2026-09-13), sized against percent of the
// lifter's OWN target (rp:rp-s12-praise-relative-to-goal-not-magnitude).
//
// TWO SOURCES FOR `stalled`. `history.trend`'s plateau verdict decides it when
// the caller ran the detector, which is what plan §2d names; the local
// run-under-the-edge rule is the fallback when no verdict arrives. `statusBasis`
// says which one decided, because they can disagree — the detector fits a curve
// over days, the fallback counts readings against the band.
//
// A COMMITMENT IS NOT A PROGRESSION. A `sessions_28d` band comes back
// `infoLevel: 'cold'` by construction, so the generic `calibrating` rule would
// swallow it forever and describe it in execution-ramp words. It gets its own
// branch instead, judged on pace against the count due by now.
//
// A MET GOAL OUTRANKS PACE. Once a matched reading reaches the committed
// number the target is `goal_met` (or `beyond_goal` past it) for the rest of
// the block, ahead of every pace rule: the verdict reads the block's BEST
// reading, so a later dip cannot take it back (VW-400).
//
// Confidentiality: fitness units, plan metadata and coaching prose only — no
// protocol data (NF-07).

import type { MrvGuardVerdict } from '@voltras/workout-analytics';

import { evaluateE1RMPr } from '../../analytics/e1rm-pr.js';
import {
  SMALL_DEVIATION_PCT,
  dietPhaseTolerance,
  toleranceEffect,
  type DietPhaseState,
  type ToleranceVerdict,
  type TrendSlope,
} from '../../analytics/diet-phase-tolerance.js';
import { blockWeekAt } from '../../analytics/goal-block-weeks.js';
import {
  GOAL_BAND_CONSTANTS,
  calibrationGapOf,
  isStartingRamp,
  type CalibrationBlocker,
  type CalibrationGap,
  type GoalBand,
  type GoalBandExpectation,
  type GoalBandWeek,
  type GoalDietState,
} from '../../analytics/goal-band.js';
import {
  aheadOfEdge,
  behindEdge,
  blockReadingsOf,
  expectationAt,
  goalReachOf,
  mesoMilestoneOf,
  weekOutcomesOf,
  type BlockReading,
  type GoalMesoMilestone,
  type GoalReachRead,
  type GoalWeekOutcomeEntry,
} from './goal-milestone.js';
import type {
  BaselineState,
  StoredGoalBandBasis,
  StoredGoalInfoLevel,
  StoredGoalTarget,
  StoredPriority,
  StoredPriorityKind,
  StoredPriorityLevel,
} from '../../store/types.js';

/**
 * The magnitudes this read-model adds on top of the band's, each labelled with
 * where it came from — the convention `analytics/goal-band.ts` sets.
 */
export const GOAL_PROGRESS_CONSTANTS = {
  /**
   * Matched readings that must sit below the committed edge before a run is
   * called a stall.
   *
   * HUMAN DECISION 2026-09-13, recorded in the ticket. Two is already the
   * mesocycle-level underperformance signal `checkMrvGuard` owns; a stall is
   * the slower claim and wants one more reading than the acute one.
   */
  minMatchedForStall: 3,
  /**
   * Percent per matched reading below which a trend is called flat.
   *
   * ENGINEERING DEFAULT. It is what the ramp's own smallest step
   * (`rampIncrementFloorLbs`, 2.5 lb) is worth on a 250 lb working load — the
   * smallest move the programmed progression can even produce, so anything
   * under it is rounding rather than trend.
   */
  flatSlopePctPerStep: 1,
  /**
   * Lifts that must be progressing before a muscle-level claim is corroborated.
   * rp:rp-s7-multi-exercise-confirmation-for-muscle-gain
   */
  corroborationMinLifts: 2,
  /**
   * The rolling window a `sessions_28d` commitment is counted over, in days.
   *
   * It is the metric's own name, and the window is what moves rather than a
   * streak — the plan's "rolling 28-day counts only" (human decision
   * 2026-09-13). `deriveGoalBand`'s `sessionCountShape` states the same thing
   * about the band.
   */
  sessionWindowDays: 28,
} as const;

/**
 * The nine words the page may say about a target. `calibrating` replaces v1's
 * `insufficient_data`; `goal_met` and `beyond_goal` are block verdicts, not paces (VW-400).
 */
export type GoalProgressStatus =
  | 'goal_met'
  | 'beyond_goal'
  | 'on_track'
  | 'ahead'
  | 'behind'
  | 'tolerated'
  | 'deload_week'
  | 'calibrating'
  | 'stalled';

/** One recorded reading of the tracked metric. */
export interface GoalActual {
  ts: string;
  value: number;
  /** Comparability: the drift guard says this reading is the same work the band started from. */
  matched: boolean;
  isPR: boolean;
}

/**
 * A reading placed on the meso's week axis. `GoalTrajectoryChart` (titan #223)
 * plots by `weekIndex` and only interpolates from `ts` when it has none, so the
 * placement is resolved here where the week boundaries are already known.
 */
export interface GoalActualView extends GoalActual {
  /** Absent when the reading falls outside the meso — before it started or past its last week. */
  weekIndex?: number;
}

/**
 * `history.trend`'s plateau read, projected down to what this model uses
 * (`HistoryTrendResult['plateau']` satisfies it). It arrives precomputed for
 * the same reason `mrvVerdict` does: the detector needs a store read, and this
 * module performs none.
 */
export interface GoalPlateauVerdict {
  /** VW-277's phase-aware answer: `'tolerated'` means the declared phase already explains it. */
  verdict: 'plateau' | 'tolerated' | 'none';
  plateauDays?: number;
  reasoning?: string;
}

/** The entry-depression axis of `computeFatigueAxes`, attached as a confounder and never as a verdict. */
export interface GoalFatigueContext {
  /** Percent below the lifter's own prior output at the same load. `null` when not measurable. */
  entryDepressionPct?: number | null;
  /** `FatigueAxis.confidence`, coarse 0-1. */
  confidence?: number;
}

/** e1RM estimates to draw beside the card. Information only — never the verdict source. */
export interface GoalE1RMInput {
  series: readonly { ts: string; value: number }[];
  /** The prior historical best `evaluateE1RMPr` judges the newest estimate against. */
  historyBest?: number | null;
}

/** Each e1RM estimate inside its pooled standard error. */
export interface GoalE1RMContextView {
  series: { ts: string; value: number; low: number; high: number }[];
  seePct: number;
  isPR: boolean;
  priorBest: number | null;
}

/** The evidence the band's calibration gates read, as `deriveTarget` measured it. */
export interface GoalCalibrationEvidence {
  matchedSessionCount: number;
  baselineState: BaselineState;
}

/**
 * Why a `calibrating` target is still calibrating, structured so the page never
 * parses `statusBasis` (VW-444). `targetBasis` / `targetInfoLevel` are the
 * ACCEPTED target's own, which say whether its number is the generic starting ramp.
 */
export interface GoalCalibrationView {
  /** Matched sessions still to come. `0` when only the baseline blocks. */
  sessionsNeeded: number;
  blockedBy: CalibrationBlocker;
  baselineState: BaselineState;
  targetBasis: StoredGoalBandBasis;
  targetInfoLevel: StoredGoalInfoLevel;
}

/**
 * An accepted starting ramp whose lift has since calibrated (VW-444 part 2).
 * `offered` while a data-based target is on offer, `kept_starting_ramp` once the
 * lifter declined it for this block. The accepted number is never edited.
 */
export interface GoalRecalibrationView {
  state: 'offered' | 'kept_starting_ramp';
}

export interface GoalProgressInput {
  priority: StoredPriority;
  target: StoredGoalTarget;
  /** Recomputed by `deriveGoalBand` or rebuilt from the stored row; must cover every week. */
  band: GoalBand;
  /** What the band was derived from; the source of a calibrating view's shortfall. */
  calibrationEvidence: GoalCalibrationEvidence;
  /** The lifter declined this target's recalibration offer (an `advisory_decisions` answer). */
  recalibrationDeclined?: boolean;
  actuals: readonly GoalActual[];
  weeks: readonly GoalBandWeek[];
  /** ISO instant the view is being built for. The model never reads the clock itself. */
  now: string;
  dietState: GoalDietState;
  fatigue?: GoalFatigueContext;
  /** `checkMrvGuard`'s two-session verdict, when the caller ran it for this lift. */
  mrvVerdict?: MrvGuardVerdict;
  /** `history.trend`'s plateau read. When present it decides `stalled`; absent falls back. */
  plateauVerdict?: GoalPlateauVerdict;
  e1rm?: GoalE1RMInput;
}

export interface GoalMesoWeek {
  n: number;
  of: number;
  isDeload: boolean;
}

export interface GoalMilestone {
  label: string;
  value: number;
  dueWeek: number;
  /** The target's own rep anchor for `top_load_at_reps`; mirrors `load` for every other metric. */
  reps: number;
  /**
   * The waypoint's rounded value — the same number `label` prints. A `reps_at_load`
   * target's own `anchorLoad` instead, when it recorded one (VW-399).
   */
  load: number;
  /** Every stored value in this system is pounds (VW-230); no per-user kg preference exists yet. */
  unit: 'lb' | 'kg';
  /** Same as `dueWeek`, named for the card's own field (VW-386, additive). */
  goalWeek: number;
}

export interface GoalConfounder {
  kind: 'entry_depression';
  pct: number;
  confidence: number;
}

export interface GoalAdvisory {
  kind: 'programming' | 'ahead_decision';
  prompt: string;
  /** Which analysis produced it, so the page can say where the ask came from. */
  source: string;
}

export interface GoalPraise {
  level: 'quiet' | 'loud';
  text: string;
}

export interface GoalProgressView {
  priority: StoredPriority;
  target: StoredGoalTarget;
  mesoWeek: GoalMesoWeek | null;
  expected: GoalBandExpectation[];
  /** The target's own fixed numbers, never the band's recomputed edges. */
  committed: number;
  stretch: number;
  actuals: GoalActualView[];
  e1rmContext?: GoalE1RMContextView;
  status: GoalProgressStatus;
  /** One clause: which rule fired, and its citation. */
  statusBasis: string;
  /** Present only while `status` is `calibrating` for a lift; absent for every other status. */
  calibration?: GoalCalibrationView;
  /** Present only for an accepted starting ramp whose lift has calibrated since. */
  recalibration?: GoalRecalibrationView;
  /**
   * Present and `null` for a muscle priority, absent for a lift: corroboration
   * is a claim across a priority's lifts, so `buildPriorityRollup` decides it.
   */
  corroborated?: boolean | null;
  nextMilestone: GoalMilestone;
  /** The committed number as the block-end milestone, and whether it has been reached (VW-400). */
  mesoMilestone: GoalMesoMilestone;
  /** Every week of the block against its own band row, aligned to week 1 (VW-400). */
  weekOutcomes: GoalWeekOutcomeEntry[];
  confounder?: GoalConfounder;
  advisory?: GoalAdvisory;
  praise?: GoalPraise;
}

const C = GOAL_PROGRESS_CONSTANTS;

/** Everything the status chain and the advisory rules read, computed once. */
interface Reading {
  input: GoalProgressInput;
  weekPosition: number;
  isLastWeek: boolean;
  expected: GoalBandExpectation;
  matched: GoalActual[];
  latest: GoalActual | undefined;
  deviationPct: number;
  slope: TrendSlope;
  verdict: ToleranceVerdict;
  effect: 'softened' | 'hardened' | 'none';
  belowCommitted: boolean;
  beyondStretch: boolean;
  /** Matched readings inside the block, each with its week. */
  inBlock: BlockReading[];
  reach: GoalReachRead | null;
}

interface StatusRead {
  status: GoalProgressStatus;
  statusBasis: string;
  gap?: CalibrationGap;
}

export function buildGoalProgressView(input: GoalProgressInput): GoalProgressView {
  assertUsableInput(input);
  const reading = read(input);
  const { status, statusBasis, gap } = resolveStatus(reading);
  const advisory = advisoryFor(status, reading);
  const confounder = confounderFor(status, input.fatigue);
  const praise = praiseFor(status, reading);
  const recalibration = recalibrationOf(input);
  return {
    priority: input.priority,
    target: input.target,
    mesoWeek: mesoWeekOf(input.weeks, reading.weekPosition),
    expected: [...input.band.expected],
    committed: input.target.committedValue,
    stretch: input.target.stretchValue,
    actuals: input.actuals.map((entry) => placeOnWeekAxis(entry, input)),
    status,
    statusBasis,
    ...(gap === undefined ? {} : { calibration: calibrationViewOf(gap, input) }),
    ...(recalibration === undefined ? {} : { recalibration }),
    ...(input.priority.kind === 'muscle' ? { corroborated: null } : {}),
    nextMilestone: nextMilestoneOf(reading),
    mesoMilestone: mesoMilestoneOf({
      target: input.target,
      band: input.band,
      weeks: input.weeks,
      readings: reading.inBlock,
      now: input.now,
      reach: reading.reach,
    }),
    weekOutcomes: weekOutcomesOf(input.target, input.band, input.weeks, reading.inBlock),
    ...(input.e1rm === undefined ? {} : { e1rmContext: e1rmContextOf(input.e1rm) }),
    ...(confounder === undefined ? {} : { confounder }),
    ...(advisory === undefined ? {} : { advisory }),
    ...(praise === undefined ? {} : { praise }),
  };
}

function assertUsableInput(input: GoalProgressInput): void {
  if (input.weeks.length === 0) {
    throw new Error('buildGoalProgressView: weeks must not be empty');
  }
  if (input.band.expected.length === 0) {
    throw new Error('buildGoalProgressView: band.expected must not be empty');
  }
}

function read(input: GoalProgressInput): Reading {
  const weekPosition = positionAt(input.target.startMeasuredAt, input.now, input.weeks.length);
  const expected = expectationAt(input.band, input.weeks, weekPosition);
  const matched = input.actuals.filter((actual) => actual.matched);
  const latest = matched[matched.length - 1];
  const mid = (expected.low + expected.high) / 2;
  const slope = slopeOf(matched, input.band.direction, mid);
  const deviationPct = latest === undefined ? 0 : deviationOf(expected, latest.value, input.band);
  const verdict = dietPhaseTolerance(dietPhaseStateOf(input.dietState), deviationPct, slope);
  const inBlock = blockReadingsOf(input.target, input.weeks, matched);
  return {
    input,
    weekPosition,
    isLastWeek: weekPosition === input.weeks.length - 1,
    expected,
    matched,
    latest,
    deviationPct,
    slope,
    verdict,
    effect: toleranceEffect(verdict),
    belowCommitted: latest !== undefined && behindEdge(expected.low, latest.value, input.band),
    beyondStretch: latest !== undefined && aheadOfEdge(expected.high, latest.value, input.band),
    inBlock,
    reach: goalReachOf(input.target, input.band.direction, inBlock),
  };
}

/** Which week of the horizon `atIso` falls in, 0-based and clamped to the horizon's ends. */
function positionAt(fromIso: string, atIso: string, weekCount: number): number {
  const week = blockWeekAt(fromIso, atIso);
  return Number.isNaN(week) ? 0 : Math.min(Math.max(week, 1), weekCount) - 1;
}

/**
 * Put a reading on the meso's week axis, or leave it off. Unlike
 * {@link positionAt} this does NOT clamp: a reading taken before the target's
 * start or past its last week belongs to no week of this meso, and clamping it
 * into week 1 would draw it on a week it was not measured in.
 */
function placeOnWeekAxis(entry: GoalActual, input: GoalProgressInput): GoalActualView {
  const week = input.weeks[blockWeekAt(input.target.startMeasuredAt, entry.ts) - 1];
  return week === undefined ? { ...entry } : { ...entry, weekIndex: week.index };
}

/**
 * The declared phase, passed through unfolded. `recomposition` is a first-class
 * `DietPhase` since VW-363 and `dietPhaseTolerance` handles it itself, so
 * folding it onto maintenance here would only lose the label the rationale
 * prints — `deriveGoalBand` still folds it because the fold is what earns that
 * band its `provisional` flag, which is a claim about the band, not the phase.
 */
function dietPhaseStateOf(state: GoalDietState): DietPhaseState {
  return { phase: state.phase, weeksInPhase: state.weeksInPhase };
}

/**
 * Distance from the band's midline, scaled so the band edge lands exactly on
 * `SMALL_DEVIATION_PCT`: inside the band is always a `small` deviation, one
 * band-width past it is `moderate`. Negative is behind, positive is ahead, as
 * `DeviationPct` requires. A `hold` goal has no ahead side — any departure from
 * the corridor's middle is a departure — so its deviation is never positive.
 *
 * A zero-width band (the cold execution ramp, a session count) has no corridor
 * to scale against and falls back to the raw percent of expected.
 */
function deviationOf(expected: GoalBandExpectation, value: number, band: GoalBand): number {
  const mid = (expected.low + expected.high) / 2;
  const halfSpan = Math.abs(expected.high - expected.low) / 2;
  const displacement =
    band.direction === 'hold' ? -Math.abs(value - mid) : (value - mid) * signOf(band.direction);
  if (halfSpan > 0) return (displacement / halfSpan) * SMALL_DEVIATION_PCT;
  return mid === 0 ? 0 : (displacement / Math.abs(mid)) * 100;
}

function signOf(direction: GoalBand['direction']): number {
  return direction === 'down' ? -1 : 1;
}

/**
 * The trend of the matched readings, in the lifter's favour. A `hold` goal
 * trends on distance from the corridor's middle: closing on it is improving.
 */
function slopeOf(
  matched: readonly GoalActual[],
  direction: GoalBand['direction'],
  mid: number,
): TrendSlope {
  if (matched.length < 2) return 'flat';
  const first = matched[0];
  const last = matched[matched.length - 1];
  const [from, to] =
    direction === 'hold'
      ? [Math.abs(first.value - mid), -Math.abs(last.value - mid)]
      : [first.value * signOf(direction), last.value * signOf(direction)];
  const scale = Math.abs(first.value);
  if (scale === 0) return 'flat';
  const pctPerStep = (((to - from) / scale) * 100) / (matched.length - 1);
  if (pctPerStep > C.flatSlopePctPerStep) return 'improving';
  if (pctPerStep < -C.flatSlopePctPerStep) return 'declining';
  return 'flat';
}

function mesoWeekOf(weeks: readonly GoalBandWeek[], position: number): GoalMesoWeek | null {
  const week = weeks[position];
  if (week === undefined) return null;
  return { n: week.index, of: weeks.length, isDeload: week.isDeload };
}

/** First rule that fires wins; the chain is the precedence, top to bottom. */
function resolveStatus(reading: Reading): StatusRead {
  return (
    reachRead(reading) ??
    deloadRead(reading) ??
    sessionCountRead(reading) ??
    calibratingRead(reading) ??
    aheadRead(reading) ??
    toleratedRead(reading) ??
    stalledRead(reading) ??
    behindRead(reading) ??
    onTrackRead(reading)
  );
}

/**
 * The committed number, reached. It reads the block's BEST matched reading, so
 * once earned it holds for the rest of the block whatever a later set does:
 * the target was set to be barely achievable, and delivering it is the verdict.
 */
function reachRead(reading: Reading): StatusRead | undefined {
  const reach = reading.reach;
  if (reach === null || reach.reach === 'short') return undefined;
  const committed = reading.input.target.committedValue;
  const rule =
    'It holds for the rest of the block, and what the block does next is decided at its ' +
    'boundary (rp:rp-s10-underpromise-overdeliver-goal-setting).';
  if (reach.reach === 'beyond') {
    return {
      status: 'beyond_goal',
      statusBasis: `Beyond the goal: the block's best matched reading, ${reach.best}, is past the committed ${committed}. ${rule}`,
    };
  }
  return {
    status: 'goal_met',
    statusBasis: `Goal met: a matched reading reached the committed ${committed}. ${rule}`,
  };
}

/** A deload week flattens the band and suspends the verdict, before any other question. */
function deloadRead(reading: Reading): StatusRead | undefined {
  const week = reading.input.weeks[reading.weekPosition];
  if (week === undefined || !week.isDeload) return undefined;
  return {
    status: 'deload_week',
    statusBasis: `Week ${week.index} is a deload: the band is flat across it and no verdict is drawn (VW-326).`,
  };
}

/**
 * A 28-day session count is judged on pace, not on calibration. Its band comes
 * back `cold` by construction — `sessionCountShape` holds it flat at the
 * declared count — so the generic `calibrating` rule below would swallow it
 * forever and describe a commitment in execution-ramp words. What it is owed
 * instead is the count due by now: the committed total pro-rated by however
 * much of the rolling window has elapsed. Never a streak; the window moves.
 */
function sessionCountRead(reading: Reading): StatusRead | undefined {
  if (reading.input.target.metric !== 'sessions_28d') return undefined;
  const counted = reading.latest?.value;
  const committed = reading.input.target.committedValue;
  const dueByNow = committed * windowFractionElapsed(reading);
  const commitment =
    'A 28-day session count is a commitment, not a progression (goal / plan / commitment, ' +
    'rp:rp-s10-three-month-planning-horizon): the count holds and the rolling window moves.';
  if (counted === undefined) {
    return { status: 'calibrating', statusBasis: `No training days counted yet. ${commitment}` };
  }
  const pace = `${counted} of the ${round(dueByNow)} due by now against a committed ${committed}`;
  if (counted >= dueByNow) {
    return { status: 'on_track', statusBasis: `On pace: ${pace}. ${commitment}` };
  }
  return { status: 'behind', statusBasis: `Under pace: ${pace}. ${commitment}` };
}

/** How much of the rolling window has run, 0 to 1. A full window is the whole commitment. */
function windowFractionElapsed(reading: Reading): number {
  const startedMs = Date.parse(reading.input.target.startMeasuredAt);
  const nowMs = Date.parse(reading.input.now);
  if (Number.isNaN(startedMs) || Number.isNaN(nowMs)) return 1;
  const elapsedDays = (nowMs - startedMs) / (24 * 60 * 60 * 1000);
  return Math.min(1, Math.max(0, elapsedDays / C.sessionWindowDays));
}

function calibratingRead(reading: Reading): StatusRead | undefined {
  const evidence = reading.input.calibrationEvidence;
  if (reading.input.band.infoLevel === 'cold') {
    const gap = calibrationGapOf(evidence.matchedSessionCount, evidence.baselineState);
    return {
      status: 'calibrating',
      statusBasis:
        'Calibrating: the band is the programmed execution ramp, which is a claim about ' +
        'completing the work rather than about strength gained (rp:rp-s5-load-increment-by-exercise-type).',
      ...(gap === null ? {} : { gap }),
    };
  }
  const gap = calibrationGapOf(reading.matched.length, null);
  if (gap === null) return undefined;
  return {
    status: 'calibrating',
    statusBasis:
      `Calibrating: ${gap.sessionsNeeded} more matched session(s) before a reading ` +
      'is judged against the band (rp:rp-s7-like-vs-like-progress-comparison-rule).',
    gap,
  };
}

/** Evidence going backwards closes a gate again, and with it the offer: no state is latched. */
function recalibrationOf(input: GoalProgressInput): GoalRecalibrationView | undefined {
  const { target, calibrationEvidence: evidence } = input;
  if (target.acceptedBy === undefined || !isStartingRamp(target.metric, target.infoLevel)) {
    return undefined;
  }
  if (calibrationGapOf(evidence.matchedSessionCount, evidence.baselineState) !== null) {
    return undefined;
  }
  return { state: input.recalibrationDeclined === true ? 'kept_starting_ramp' : 'offered' };
}

function calibrationViewOf(gap: CalibrationGap, input: GoalProgressInput): GoalCalibrationView {
  return {
    ...gap,
    baselineState: input.calibrationEvidence.baselineState,
    targetBasis: input.target.basis,
    targetInfoLevel: input.target.infoLevel,
  };
}

function aheadRead(reading: Reading): StatusRead | undefined {
  if (!reading.beyondStretch) return undefined;
  return {
    status: 'ahead',
    statusBasis:
      'Past the stretch edge of the band. Running ahead is a decision at the block boundary, ' +
      'not a mid-block change (rp:rp-s5-intermediate-overplanning-risk).',
  };
}

/**
 * Behind the committed edge, but the declared diet phase is what turned the
 * advice down. Only a SOFTENED verdict tolerates: a phase that changed nothing
 * leaves the reading exactly as the unwidened table judged it.
 */
function toleratedRead(reading: Reading): StatusRead | undefined {
  if (!reading.belowCommitted || reading.effect !== 'softened') return undefined;
  return {
    status: 'tolerated',
    statusBasis:
      `Behind the committed edge, tolerated: ${reading.verdict.rationale}. A dip in a deficit ` +
      'is expected rather than a stall (rp:rp-s11-diet-phase-training-fatigue-coupling).',
  };
}

/**
 * `history.trend`'s plateau verdict is the source of `stalled` when the caller
 * ran the detector (plan §2d), and the local run rule is the fallback when it
 * did not. `statusBasis` names which of the two decided, because they can
 * disagree: the detector fits a curve over days, the fallback counts readings
 * against the band. A `'tolerated'` verdict is not a stall — the phase already
 * explains it, and the chain's own `tolerated` branch has had its say above.
 */
function stalledRead(reading: Reading): StatusRead | undefined {
  const detected = reading.input.plateauVerdict;
  if (detected !== undefined) return detectedStall(detected);
  const run = reading.matched.slice(-C.minMatchedForStall);
  if (run.length < C.minMatchedForStall || reading.slope === 'improving') return undefined;
  if (!run.every((actual) => belowEdgeAt(actual, reading))) return undefined;
  return {
    status: 'stalled',
    statusBasis:
      `${run.length} matched sessions under the committed edge with a ${reading.slope} trend, ` +
      'by this page’s own run rule with no plateau detector run: a flatline, not a slowdown ' +
      '(rp:rp-s7-plateau-flatline-vs-slowdown-distinction).',
  };
}

function detectedStall(detected: GoalPlateauVerdict): StatusRead | undefined {
  if (detected.verdict !== 'plateau') return undefined;
  const run = detected.plateauDays === undefined ? '' : ` over ${detected.plateauDays} days`;
  const why = detected.reasoning === undefined ? '' : ` ${detected.reasoning}`;
  return {
    status: 'stalled',
    statusBasis:
      `history.trend’s plateau detector called this a plateau${run}.${why} A flatline, not a ` +
      'slowdown (rp:rp-s7-plateau-flatline-vs-slowdown-distinction).',
  };
}

function belowEdgeAt(actual: GoalActual, reading: Reading): boolean {
  const position = positionAt(
    reading.input.target.startMeasuredAt,
    actual.ts,
    reading.input.weeks.length,
  );
  const expected = expectationAt(reading.input.band, reading.input.weeks, position);
  return behindEdge(expected.low, actual.value, reading.input.band);
}

function behindRead(reading: Reading): StatusRead | undefined {
  if (!reading.belowCommitted || reading.verdict.magnitude === 'none') return undefined;
  return {
    status: 'behind',
    statusBasis:
      `Behind the committed edge: ${reading.verdict.rationale}, judged slope-first ` +
      '(rp:rp-s12-trend-slope-overrides-raw-deviation).',
  };
}

function onTrackRead(reading: Reading): StatusRead {
  return {
    status: 'on_track',
    statusBasis:
      `On track: ${reading.verdict.rationale}. A trend already converging needs no response, ` +
      'however far off the line today sits (rp:rp-s12-trend-slope-overrides-raw-deviation).',
  };
}

/**
 * What the lifter is asked to decide. Behind buys a PROGRAMMING lever and never
 * a smaller target; ahead buys the block-boundary question, and only in the
 * block's last week.
 */
function advisoryFor(status: GoalProgressStatus, reading: Reading): GoalAdvisory | undefined {
  if (status === 'behind' || status === 'stalled') return programmingAdvisory(reading);
  const past = status === 'ahead' || status === 'beyond_goal';
  if (past && reading.isLastWeek) return aheadDecisionAdvisory(reading);
  return undefined;
}

function programmingAdvisory(reading: Reading): GoalAdvisory {
  if (reading.input.target.metric === 'sessions_28d') {
    return {
      kind: 'programming',
      prompt:
        'Under the count you committed to: the lever is the schedule, not the training. Put the ' +
        'missed sessions back in the week. The committed count itself does not move.',
      source: 'commitment',
    };
  }
  const verdict = reading.input.mrvVerdict;
  if (verdict?.mrvFlagged === true) {
    return {
      kind: 'programming',
      prompt:
        'Two matched sessions in a row came in under the reference, so consider a recovery ' +
        `session before the next load step. ${verdict.reasoning} The target itself does not move.`,
      source: 'checkMrvGuard',
    };
  }
  return {
    kind: 'programming',
    prompt:
      'Under the committed edge: the lever is the programming, not the number. Hold the load ' +
      'and add a rep, or trim a set and repeat the week. The target itself does not move.',
    source: 'progression',
  };
}

function aheadDecisionAdvisory(reading: Reading): GoalAdvisory {
  const options = reading.verdict.aheadOptions;
  if (options.length === 0) {
    return {
      kind: 'ahead_decision',
      prompt:
        'Last week of the block and ahead of the stretch edge: the next block is where that ' +
        'gets spent, not this one (rp:rp-s5-intermediate-overplanning-risk).',
      source: 'block-boundary',
    };
  }
  return {
    kind: 'ahead_decision',
    prompt: `Last week of the block and ahead of the stretch edge. Options: ${options.join('; ')}.`,
    source: 'dietPhaseTolerance.aheadOptions',
  };
}

/** Entry depression rides along with a shortfall as a confounder, never as its cause. */
function confounderFor(
  status: GoalProgressStatus,
  fatigue: GoalFatigueContext | undefined,
): GoalConfounder | undefined {
  if (status !== 'behind' && status !== 'stalled') return undefined;
  const pct = fatigue?.entryDepressionPct;
  if (pct === undefined || pct === null || pct <= 0) return undefined;
  return { kind: 'entry_depression', pct, confidence: fatigue?.confidence ?? 0 };
}

/** Quiet per set, loud per mesocycle (human decision 2026-09-13). A miss is never scored. */
function praiseFor(status: GoalProgressStatus, reading: Reading): GoalPraise | undefined {
  if (reading.isLastWeek && PROGRESSING.includes(status)) {
    return { level: 'loud', text: mesoPraiseText(reading) };
  }
  const latest = reading.input.actuals[reading.input.actuals.length - 1];
  if (latest?.isPR !== true) return undefined;
  return { level: 'quiet', text: 'Personal best on that set.' };
}

function mesoPraiseText(reading: Reading): string {
  const achieved = reading.latest?.value;
  const { startValue, committedValue } = reading.input.target;
  const span = committedValue - startValue;
  if (achieved === undefined || span === 0) {
    return 'Mesocycle done, and it landed on the target you committed to.';
  }
  const pct = Math.round(((achieved - startValue) / span) * 100);
  return (
    `Mesocycle done: ${pct}% of the move you committed to, ${startValue} to ${achieved} against ` +
    `a committed ${committedValue}. Judged against your own target, not against anyone else's ` +
    '(rp:rp-s12-praise-relative-to-goal-not-magnitude).'
  );
}

/** The next week's committed edge — the waypoint, not the horizon. */
function nextMilestoneOf(reading: Reading): GoalMilestone {
  const weeks = reading.input.weeks;
  const position = Math.min(reading.weekPosition + 1, weeks.length - 1);
  const expected = expectationAt(reading.input.band, weeks, position);
  const dueWeek = weeks[position]?.index ?? expected.weekIndex;
  const target = reading.input.target;
  const rounded = roundToTenth(expected.low);
  const reps = target.metric === 'top_load_at_reps' ? (target.anchorReps ?? rounded) : rounded;
  const load = target.metric === 'reps_at_load' ? (target.anchorLoad ?? rounded) : rounded;
  return {
    label: milestoneLabel(target, rounded, dueWeek),
    value: expected.low,
    dueWeek,
    reps,
    load,
    unit: 'lb',
    goalWeek: dueWeek,
  };
}

/** The single rounding this waypoint's `label`, `load` and `reps` all read off, so none can drift apart. */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function milestoneLabel(target: StoredGoalTarget, rounded: number, dueWeek: number): string {
  const week = `in week ${dueWeek}`;
  switch (target.metric) {
    case 'top_load_at_reps':
      return `${rounded} x ${target.anchorReps ?? '?'} ${week}`;
    case 'reps_at_load':
      return target.anchorLoad === undefined
        ? `${rounded} reps ${week}`
        : `${rounded} reps at ${target.anchorLoad} lb ${week}`;
    case 'bodyweight':
      return `bodyweight ${rounded} ${week}`;
    case 'sessions_28d':
      return `${rounded} training days in the rolling 28-day window`;
    case 'e1rm_trend':
      return `e1RM ${rounded} ${week}`;
    case 'composite_strength':
      return `composite strength ${rounded} ${week}`;
  }
}

/** Every estimate inside its pooled standard error (VW-267). Read as a trend, never as a measurement. */
function e1rmContextOf(input: GoalE1RMInput): GoalE1RMContextView {
  const seePct = GOAL_BAND_CONSTANTS.e1rmSeePct;
  const latest = input.series[input.series.length - 1];
  const verdict = evaluateE1RMPr(latest?.value ?? null, input.historyBest ?? null);
  return {
    series: input.series.map((point) => ({
      ts: point.ts,
      value: point.value,
      low: round(point.value * (1 - seePct / 100)),
      high: round(point.value * (1 + seePct / 100)),
    })),
    seePct,
    isPR: verdict.isPR,
    priorBest: verdict.priorBest,
  };
}

/** One priority's targets, read together. */
export interface PriorityRollupView {
  priorityId: string;
  kind: StoredPriorityKind;
  ref: string;
  level: StoredPriorityLevel;
  /** The most actionable of the priority's target statuses. */
  status: GoalProgressStatus;
  /** `null` for a lift priority, and for a muscle with fewer than two targets to agree. */
  corroborated: boolean | null;
  progressingCount: number;
  targetCount: number;
  summary: string;
}

/** Statuses that count as the lift moving in the right direction. */
const PROGRESSING: readonly GoalProgressStatus[] = ['on_track', 'ahead', 'goal_met', 'beyond_goal'];

/**
 * How actionable each status is. The rollup reports the highest: one lift that
 * stalled is the thing worth saying about a priority whose others are fine.
 */
const STATUS_RANK: Record<GoalProgressStatus, number> = {
  beyond_goal: -2,
  goal_met: -1,
  ahead: 0,
  on_track: 1,
  deload_week: 2,
  calibrating: 3,
  tolerated: 4,
  behind: 5,
  stalled: 6,
};

const STATUS_LABEL: Record<GoalProgressStatus, string> = {
  beyond_goal: 'beyond goal',
  goal_met: 'goal met',
  ahead: 'ahead',
  on_track: 'on track',
  deload_week: 'deload week, no verdict',
  calibrating: 'calibrating',
  tolerated: 'behind, tolerated for the diet phase',
  behind: 'behind',
  stalled: 'stalled',
};

/**
 * Group per-target views by their priority. A muscle priority earns
 * `corroborated` only when two of its lifts agree that it is progressing
 * (rp:rp-s7-multi-exercise-confirmation-for-muscle-gain); a single lift needs
 * no corroboration and reports `null`.
 */
export function buildPriorityRollup(views: readonly GoalProgressView[]): PriorityRollupView[] {
  const groups = new Map<string, GoalProgressView[]>();
  for (const view of views) {
    const group = groups.get(view.priority.id);
    if (group === undefined) groups.set(view.priority.id, [view]);
    else group.push(view);
  }
  return [...groups.values()].map(rollupOne);
}

function rollupOne(group: GoalProgressView[]): PriorityRollupView {
  const priority = group[0].priority;
  const status = group.reduce(
    (worst, view) => (STATUS_RANK[view.status] > STATUS_RANK[worst] ? view.status : worst),
    group[0].status,
  );
  const progressingCount = group.filter((view) => PROGRESSING.includes(view.status)).length;
  const corroborated =
    priority.kind !== 'muscle' || group.length < C.corroborationMinLifts
      ? null
      : progressingCount >= C.corroborationMinLifts;
  return {
    priorityId: priority.id,
    kind: priority.kind,
    ref: priority.ref,
    level: priority.level,
    status,
    corroborated,
    progressingCount,
    targetCount: group.length,
    summary: rollupSummary(priority, group, status, progressingCount, corroborated),
  };
}

function rollupSummary(
  priority: StoredPriority,
  group: GoalProgressView[],
  status: GoalProgressStatus,
  progressingCount: number,
  corroborated: boolean | null,
): string {
  const week = weekClause(group[0].mesoWeek);
  if (priority.kind !== 'muscle') {
    return `${priority.ref}: ${STATUS_LABEL[status]}${week}.`;
  }
  const agreement =
    corroborated === null
      ? 'one lift, so no corroboration yet'
      : corroborated
        ? 'corroborated across lifts'
        : 'not yet corroborated across lifts';
  return `${priority.ref}: ${progressingCount} of ${group.length} lifts on track, ${agreement}${week}.`;
}

function weekClause(mesoWeek: GoalMesoWeek | null): string {
  return mesoWeek === null ? '' : ` (week ${mesoWeek.n} of ${mesoWeek.of})`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
