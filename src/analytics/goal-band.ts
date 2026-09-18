// The coach's expected progression band for a mesocycle goal (VW-348, plan G2').
//
// PURE. No store, no clock, no tool surface: the same input always yields the
// same band. `goal.propose_targets` (VW-349/H2) is what reads history, picks
// the metric and persists the result; this module only does the arithmetic.
//
// WHAT A BAND IS. Two edges per week, plus the value each edge reaches at the
// horizon. The LOW edge is what the coach commits to and the HIGH edge is the
// stretch — that is the reconciliation the plan's §1.7 makes between RP's
// "counter a wish with a target you cannot under-deliver on"
// (rp-s10-underpromise-overdeliver-goal-setting) and B55's refusal to shade a
// displayed projection. Nothing here is shaded; both edges are shown.
//
// LOW IS THE CONSERVATIVE EDGE, NOT THE SMALLER NUMBER. For a fat-loss
// bodyweight goal the committed edge is -0.5%/wk and the stretch is -1%/wk, so
// `bandLowPctPerWeek` is numerically the greater of the two. `direction` says
// which way the goal runs; a consumer drawing a polygon uses both edges and
// does not need them ordered.
//
// EVERY MAGNITUDE LIVES IN `GOAL_BAND_CONSTANTS` AND NAMES WHERE IT CAME FROM,
// in one of five vocabularies: `rp:<id>` for a mined RP University note,
// ENGINEERING DEFAULT for a number the corpus does not state, HUMAN DECISION
// for a call made on a date, STATISTICAL CONVENTION for a standard choice of
// interval, and LITERATURE for a published figure. The labelling convention is
// `diet-phase-tolerance.ts`'s. Changing one of those constants fails a test by
// construction, which is what keeps the labels honest.

import { dietPhaseTolerance, type DietPhaseState } from './diet-phase-tolerance.js';
import type { DietPhase } from '../store/diet-phase.js';
import type { BaselineState } from '../store/types.js';
import { computePercentIncrement } from './percent-increment.js';
import type { Tier } from '../tools/tier-signal.js';

/**
 * Every magnitude the band is built from, with its source. No entry here is
 * unlabelled, and only `rp:<id>` is a citation — the other four labels exist so
 * a reader can tell a mined finding from a call someone made.
 */
export const GOAL_BAND_CONSTANTS = {
  /** Smallest weekly load step in the programmed ramp. rp:rp-s5-load-increment-by-exercise-type */
  rampIncrementFloorLbs: 2.5,
  /** Largest weekly load step in the programmed ramp. rp:rp-s5-load-increment-by-exercise-type */
  rampIncrementCapLbs: 10,
  /**
   * Percent of working load the weekly step is taken from, before the cited
   * floor and cap clamp it.
   *
   * ENGINEERING DEFAULT. The corpus states the 2.5-10 lb bracket and says the
   * step is proportional to the exercise's load, but never the proportion;
   * `plan-tools.ts` leaves its own `PROGRESSION_INCREMENT_PERCENT` null for
   * exactly that reason. 2.5% is the percent at which the cited floor binds
   * below a 100 lb working load and the cited cap binds above 400 lb, so the
   * whole normal working range sits inside the bracket the corpus does state.
   */
  rampIncrementPercentOfLoad: 2.5,
  /** Weekly rep step at fixed load, low edge. rp:rp-s5-rep-progression-alternative */
  rampRepFloorPerWeek: 1,
  /** Weekly rep step at fixed load, high edge. rp:rp-s5-rep-progression-alternative */
  rampRepCapPerWeek: 2,
  /**
   * What the low edge keeps of the full ramp: the ramp with every other week
   * held.
   *
   * HUMAN DECISION 2026-09-13. Encoded rather than derived — the corpus states
   * the increment, not what a conservative edge should keep of it.
   */
  heldWeekFraction: 0.5,
  /**
   * The committed edge of a recomposition lift band: hold, not gain.
   *
   * HUMAN DECISION 2026-09-13 (VW-365). The stretch stays the tier's RP ramp,
   * so the pair reads "specialization allowed, lower expectations" without a
   * haircut constant anywhere: the committed number becomes hold and the
   * stretch is unshaded.
   */
  recompositionLiftHoldPctPerWeek: 0,
  /**
   * How many muscles a recomposition may specialize. Advisory, never a block.
   *
   * ENGINEERING DEFAULT interpolating two cited anchors: a gain phase permits
   * specialization, and a fat-loss phase forbids it outright and holds every
   * muscle at maintenance volume (rp:rp-s5-fatloss-priority-training-rule).
   * The corpus states no recomposition figure, so 1 is the midpoint of 2 and 0
   * rather than a mined number.
   */
  recompositionSpecializationCap: 1,
  /** Weekly bodyweight loss in a deficit, committed then stretch. rp:rp-s11-fat-loss-rate-heuristic */
  bodyweightFatLossPctPerWeek: { low: -0.5, high: -1 },
  /** Weekly bodyweight gain in a surplus, committed then stretch. rp:rp-s11-muscle-gain-rate-heuristic */
  bodyweightGainPctPerWeek: { low: 0.25, high: 0.5 },
  /** The corridor a maintenance bodyweight goal lives in. rp:rp-s12-maintenance-buffer-2pct */
  bodyweightMaintenanceBufferPct: 2,
  /** Below this a weekly bodyweight move is noise. rp:rp-s12-no-adjustment-under-half-pound-weekly-change */
  bodyweightNoiseFloorLbsPerWeek: 0.5,
  /** How many ramping weeks a layoff front-loads. rp:rp-s7-early-strength-gains-not-pure-muscle-signal */
  layoffFrontLoadWeeks: 2,
  /**
   * How much wider the high edge runs through those weeks.
   *
   * ENGINEERING DEFAULT. The note says early gains are fast and decelerate,
   * and says so without a figure ("Silent: any regain-rate figure", plan
   * §1.10), so the direction is cited and the size is not.
   */
  layoffFrontLoadHighMultiplier: 1.5,
  /**
   * Multiples of the fitted standard error the `own` band spans either side.
   *
   * STATISTICAL CONVENTION. One standard error is the ordinary one-sigma
   * interval around a fitted slope; a wider band would be a coaching choice
   * about how much to promise, which is `heldWeekFraction`'s job, not this.
   */
  ownSlopeSeMultiple: 1,
  /**
   * Matched sessions before a gain band is claimed at all.
   *
   * HUMAN DECISION 2026-09-13, recorded in plan §4 Q3.
   */
  minMatchedSessionsForRamp: 2,
  /**
   * Completed mesocycles before a fitted slope may be projected forward.
   *
   * HUMAN DECISION 2026-09-13, recorded in plan §4 Q3. The reason is cited even
   * though the count is not: an in-meso slope over-extrapolates
   * (rp:rp-s5-intermediate-overplanning-risk).
   */
  minCompletedMesosForOwn: 1,
  /** Past this the coach declines the horizon rather than projecting it. rp:rp-s11-goal-horizon-3to6-months */
  maxHorizonWeeks: 26,
  /**
   * Pooled standard error of an e1RM estimate, as percent of measured 1RM.
   *
   * LITERATURE: VBT, see `coaching-content.ts:507` / VW-267. Quoted from the
   * same figure that tool's `meso.e1rm_interpretation` topic already returns,
   * so the band and the coaching copy cannot drift apart.
   */
  e1rmSeePct: 9.8,
} as const;

export type GoalMetric =
  | 'top_load_at_reps'
  | 'reps_at_load'
  | 'e1rm_trend'
  | 'sessions_28d'
  | 'bodyweight'
  | 'composite_strength';

/** The three information levels of plan §2c, in ascending order of claim. */
export type GoalInfoLevel = 'cold' | 'ramp' | 'own';

/** What the band was built from; mirrors `StoredGoalTarget.basis`. */
export type GoalBandBasis = 'execution_ramp' | 'rp_ramp' | 'own_slope';

/**
 * The diet state the band is shaped by. `'recomposition'` is one of
 * {@link DietPhase}'s own four values (VW-363) and carries its own band here
 * (VW-365) rather than folding onto maintenance.
 */
export type GoalDietPhase = DietPhase | 'unknown';

export interface GoalDietState {
  phase: GoalDietPhase;
  /** 1-based, as `weeksInPhaseAt` counts. `null` when the phase is unknown. */
  weeksInPhase: number | null;
  /**
   * The recomposition bodyweight target declared at the start: the cited
   * slow-loss rate instead of the default hold corridor. Read only under
   * `'recomposition'`, and never inferred from the weight series — under a hold
   * band there is no rate to read (VW-367 §4).
   */
  slowLoss?: boolean;
}

/** One planned week of the horizon. A deload week flattens the band across it. */
export interface GoalBandWeek {
  index: number;
  isDeload: boolean;
}

/** A fitted per-lifter trend, from `history.trend`'s raw slope and fit. */
export interface GoalOwnSlope {
  pctPerWeek: number;
  sePctPerWeek: number;
  /** WA's own rule: `high` needs r-squared above 0.7 and 5+ points. */
  confidence: 'high' | 'medium' | 'low';
}

export interface GoalBandInput {
  metric: GoalMetric;
  /** The measured value the band starts from. Must be positive. */
  startValue: number;
  horizonWeeks: number;
  weeks: readonly GoalBandWeek[];
  /** The DECLARED tier, which is what sets magnitude (plan §4 Q4). */
  tier: Tier;
  /** The level the caller is asking for; the result reports what it earned. */
  infoLevel: GoalInfoLevel;
  dietState: GoalDietState;
  /** First meso on record after a gap of 3+ months. */
  layoff: boolean;
  matchedSessionCount: number;
  baselineState: BaselineState;
  completedMesoCount: number;
  ownSlope?: GoalOwnSlope;
}

export interface GoalBandExpectation {
  weekIndex: number;
  low: number;
  high: number;
}

export interface GoalBand {
  basis: GoalBandBasis;
  /** What the evidence actually earned, which may be below what was asked for. */
  infoLevel: GoalInfoLevel;
  bandLowPctPerWeek: number;
  bandHighPctPerWeek: number;
  /**
   * A flat corridor around the start value, in percent, for a goal whose
   * expectation is a range rather than a rate. `null` for every rate band.
   */
  corridorPct: number | null;
  expected: GoalBandExpectation[];
  committedValue: number;
  stretchValue: number;
  direction: 'up' | 'down' | 'hold';
  /**
   * True when an input's meaning is not settled and the band inherits that.
   * Nothing sets it since VW-365 gave `recomposition` a settled band; it stays
   * in the shape because the next unsettled input should land here rather than
   * in a consumer's own guesswork.
   */
  provisional: boolean;
  notes: string[];
}

const C = GOAL_BAND_CONSTANTS;

/** Baseline tiers a gain band may not be claimed from (plan §2c `cold`). */
const SHAPE_ONLY_OR_COLDER: readonly BaselineState[] = ['COLD', 'SHAPE_ONLY'];

/** Which of the two calibration gates is still shut. */
export type CalibrationBlocker = 'sessions' | 'baseline' | 'both';

/** What still keeps a gain band from being claimed (VW-444). */
export interface CalibrationGap {
  /** Matched sessions still to come. `0` when only the baseline blocks. */
  sessionsNeeded: number;
  blockedBy: CalibrationBlocker;
}

/**
 * The calibration gates, stated once: the band's own downgrade and the progress
 * view's structured shortfall both read this. `null` baseline means the caller
 * has no baseline to judge, so only the session count can block.
 */
export function calibrationGapOf(
  matchedSessionCount: number,
  baselineState: BaselineState | null,
): CalibrationGap | null {
  const sessionsNeeded = Math.max(0, C.minMatchedSessionsForRamp - matchedSessionCount);
  const baselineBlocks = baselineState !== null && SHAPE_ONLY_OR_COLDER.includes(baselineState);
  if (sessionsNeeded > 0 && baselineBlocks) return { sessionsNeeded, blockedBy: 'both' };
  if (sessionsNeeded > 0) return { sessionsNeeded, blockedBy: 'sessions' };
  if (baselineBlocks) return { sessionsNeeded, blockedBy: 'baseline' };
  return null;
}

/**
 * A lift target derived before calibration: the generic programmed ramp, the
 * same for any new lifter. A `sessions_28d` band is cold by construction and
 * is a commitment, never a ramp, so it is excluded.
 */
export function isStartingRamp(metric: GoalMetric, infoLevel: GoalInfoLevel): boolean {
  return infoLevel === 'cold' && metric !== 'sessions_28d';
}

/** The edges and framing a metric-plus-evidence combination produces. */
interface BandShape {
  basis: GoalBandBasis;
  infoLevel: GoalInfoLevel;
  lowPctPerWeek: number;
  highPctPerWeek: number;
  corridorPct: number | null;
  direction: 'up' | 'down' | 'hold';
}

export function deriveGoalBand(input: GoalBandInput): GoalBand {
  assertUsableInput(input);
  const notes: string[] = [];
  const dietState = input.dietState;
  if (input.horizonWeeks > C.maxHorizonWeeks) {
    notes.push(
      `Horizon of ${input.horizonWeeks} weeks is past the 3-6 month planning window; ` +
        'the far end of this band is a placeholder, not a commitment (rp:rp-s11-goal-horizon-3to6-months).',
    );
  }
  const shape = shapeFor(input, dietState, notes);
  const expected =
    shape.corridorPct === null
      ? projectRate(input, shape, notes)
      : projectCorridor(input, shape.corridorPct);
  const last = expected[expected.length - 1];
  return {
    basis: shape.basis,
    infoLevel: shape.infoLevel,
    bandLowPctPerWeek: round(shape.lowPctPerWeek),
    bandHighPctPerWeek: round(shape.highPctPerWeek),
    corridorPct: shape.corridorPct,
    expected,
    committedValue: last.low,
    stretchValue: last.high,
    direction: shape.direction,
    provisional: false,
    notes,
  };
}

function assertUsableInput(input: GoalBandInput): void {
  if (input.startValue <= 0) {
    throw new Error('deriveGoalBand: startValue must be positive');
  }
  if (input.weeks.length === 0) {
    throw new Error('deriveGoalBand: weeks must not be empty');
  }
  if (input.weeks.length !== input.horizonWeeks) {
    throw new Error(
      `deriveGoalBand: weeks has ${input.weeks.length} entries for a ${input.horizonWeeks}-week horizon`,
    );
  }
}

/** Route to the metric's own band rule, then let the diet phase reshape it. */
function shapeFor(input: GoalBandInput, dietState: DietPhaseState, notes: string[]): BandShape {
  if (input.metric === 'bodyweight') return bodyweightShape(input, dietState, notes);
  if (input.metric === 'sessions_28d') return sessionCountShape(notes);
  const earned = earnedInfoLevel(input, notes);
  const slope = input.ownSlope;
  const raw =
    earned === 'own' && slope !== undefined
      ? ownShape(slope, notes)
      : rampShape(input, earned, notes);
  return reshapeForDiet(raw, input.tier, dietState, notes);
}

/**
 * What the evidence earns, which is never more than what was asked for. Each
 * downgrade says which precondition failed, because "calibrating, N more
 * matched sessions" is copy the page needs (plan §2c).
 */
function earnedInfoLevel(input: GoalBandInput, notes: string[]): GoalInfoLevel {
  const gap = calibrationGapOf(input.matchedSessionCount, input.baselineState);
  if (gap !== null) {
    notes.push(
      `Calibrating: ${gap.sessionsNeeded} more matched session(s) and a baseline past SHAPE_ONLY before ` +
        'a gain band is claimed. Until then the band is the programmed ramp itself.',
    );
    return 'cold';
  }
  if (input.infoLevel !== 'own') return input.infoLevel === 'cold' ? 'cold' : 'ramp';
  return ownPreconditionsMet(input, notes) ? 'own' : 'ramp';
}

function ownPreconditionsMet(input: GoalBandInput, notes: string[]): boolean {
  if (input.layoff) {
    notes.push(
      'First mesocycle back after a layoff: the fitted slope is a regain slope and would ' +
        'over-project, so the band falls back to the programmed ramp ' +
        '(rp:rp-s7-early-strength-gains-not-pure-muscle-signal).',
    );
    return false;
  }
  if (input.ownSlope === undefined || input.ownSlope.confidence !== 'high') {
    notes.push(
      'No high-confidence fitted trend yet (r-squared above 0.7 and 5+ points), so the band ' +
        'is the programmed ramp rather than this lifter’s own slope.',
    );
    return false;
  }
  if (input.completedMesoCount < C.minCompletedMesosForOwn) {
    notes.push(
      'No completed mesocycle on record yet, so an in-meso slope is not projected forward ' +
        '(rp:rp-s5-intermediate-overplanning-risk).',
    );
    return false;
  }
  return true;
}

/** The fitted slope plus or minus one standard error. */
function ownShape(slope: GoalOwnSlope, notes: string[]): BandShape {
  const spread = slope.sePctPerWeek * C.ownSlopeSeMultiple;
  notes.push(
    `Band is this lifter’s own fitted trend, ${round(slope.pctPerWeek)}%/wk plus or minus ` +
      'one standard error, judged against their own curve rather than a population pace ' +
      '(rp:rp-s7-plateau-flatline-vs-slowdown-distinction).',
  );
  return {
    basis: 'own_slope',
    infoLevel: 'own',
    lowPctPerWeek: slope.pctPerWeek - spread,
    highPctPerWeek: slope.pctPerWeek + spread,
    corridorPct: null,
    direction: directionOf(slope.pctPerWeek - spread, slope.pctPerWeek + spread),
  };
}

/**
 * The programmed ramp. At `cold` both edges are the full ramp: it is an
 * EXECUTION target ("complete the ramp"), not a claim about strength gained,
 * so there is nothing to stretch to and nothing to under-deliver on.
 */
function rampShape(input: GoalBandInput, infoLevel: GoalInfoLevel, notes: string[]): BandShape {
  const { low, high } = rampEdges(input);
  if (input.metric === 'e1rm_trend') {
    notes.push(
      `e1RM carries a pooled standard error of ${C.e1rmSeePct}% of 1RM, which is wider than a ` +
        'meso-sized gain: read this band as a trend, never as a measured change (VW-267).',
    );
  }
  if (infoLevel === 'cold') {
    notes.push(
      'Execution ramp only, no gain claim: the band is the programmed weekly increment from a ' +
        '3-RIR start, which is mostly effort taper (rp:rp-s5-load-increment-by-exercise-type).',
    );
    return shapeOf('execution_ramp', 'cold', high, high);
  }
  notes.push(
    'Band is the programmed ramp: the high edge adds the increment every week, the low edge ' +
      'holds every other week (rp:rp-s5-load-increment-by-exercise-type).',
  );
  return shapeOf('rp_ramp', 'ramp', low, high);
}

/**
 * The ramp's two weekly edges, as percents of the start value. A rep goal uses
 * the cited 1-2 reps/week directly; half a rep is not a thing a lifter can do,
 * so the "every other week held" low edge is the 1-rep step itself.
 */
function rampEdges(input: GoalBandInput): { low: number; high: number } {
  const perStep = 100 / input.startValue;
  if (input.metric === 'reps_at_load') {
    return { low: C.rampRepFloorPerWeek * perStep, high: C.rampRepCapPerWeek * perStep };
  }
  const stepLbs = computePercentIncrement(
    input.startValue,
    C.rampIncrementPercentOfLoad,
    C.rampIncrementFloorLbs,
    C.rampIncrementCapLbs,
  );
  const high = stepLbs * perStep;
  return { low: high * C.heldWeekFraction, high };
}

function shapeOf(
  basis: GoalBandBasis,
  infoLevel: GoalInfoLevel,
  lowPctPerWeek: number,
  highPctPerWeek: number,
): BandShape {
  return {
    basis,
    infoLevel,
    lowPctPerWeek,
    highPctPerWeek,
    corridorPct: null,
    direction: directionOf(lowPctPerWeek, highPctPerWeek),
  };
}

/**
 * Bodyweight bands come from the diet phase, not from training history, so
 * they do not pass through the information-level gate (plan §1.9). The phase
 * rate IS the RP heuristic, which is why the basis stays `rp_ramp`.
 */
function bodyweightShape(
  input: GoalBandInput,
  dietState: DietPhaseState,
  notes: string[],
): BandShape {
  if (dietState.phase === 'fat-loss') {
    notes.push(bodyweightNote('loss', input.startValue, C.bodyweightFatLossPctPerWeek.low));
    return shapeOf(
      'rp_ramp',
      'ramp',
      C.bodyweightFatLossPctPerWeek.low,
      C.bodyweightFatLossPctPerWeek.high,
    );
  }
  if (dietState.phase === 'gain') {
    notes.push(bodyweightNote('gain', input.startValue, C.bodyweightGainPctPerWeek.low));
    return shapeOf(
      'rp_ramp',
      'ramp',
      C.bodyweightGainPctPerWeek.low,
      C.bodyweightGainPctPerWeek.high,
    );
  }
  if (dietState.phase === 'recomposition') {
    return recompositionBodyweightShape(input, notes);
  }
  return maintenanceCorridorShape(notes);
}

/**
 * A recomposition holds the maintenance corridor unless the lifter declared the
 * slow-loss target instead. The slow variant is one line rather than a band:
 * both edges sit on the SLOW edge of the cited fat-loss range, because anything
 * faster is a fat-loss phase wearing a recomposition label.
 */
function recompositionBodyweightShape(input: GoalBandInput, notes: string[]): BandShape {
  if (input.dietState.slowLoss !== true) {
    notes.push(
      'Recomposition bodyweight holds the maintenance corridor by default, because a recomposition ' +
        'runs on maintenance calories (rp:rp-s12-recomposition-requires-maintenance-calories). The ' +
        'slow-loss target is declared at the start, never read off the scale.',
    );
    return maintenanceCorridorShape(notes);
  }
  const rate = C.bodyweightFatLossPctPerWeek.low;
  notes.push(
    `Recomposition declared as slow loss: both edges sit at ${rate}%/wk, the slow edge of the cited ` +
      'fat-loss range (rp:rp-s11-fat-loss-rate-heuristic). There is no faster stretch to offer — a ' +
      'faster loss is a fat-loss phase, not this one.',
  );
  notes.push(bodyweightNote('loss', input.startValue, rate));
  return shapeOf('rp_ramp', 'ramp', rate, rate);
}

/** Maintenance names a corridor to stay inside, so there is no weekly rate. */
function maintenanceCorridorShape(notes: string[]): BandShape {
  notes.push(
    `Maintenance bodyweight is a corridor, not a rate: plus or minus ${C.bodyweightMaintenanceBufferPct}% ` +
      'of the start weight for the whole horizon (rp:rp-s12-maintenance-buffer-2pct). Committed and ' +
      'stretch are the two edges of that corridor rather than an easy and an ambitious target.',
  );
  return {
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    lowPctPerWeek: 0,
    highPctPerWeek: 0,
    corridorPct: C.bodyweightMaintenanceBufferPct,
    direction: 'hold',
  };
}

function bodyweightNote(kind: 'loss' | 'gain', startValue: number, committedPct: number): string {
  const committedLbs = Math.abs((startValue * committedPct) / 100);
  const noise =
    committedLbs < C.bodyweightNoiseFloorLbsPerWeek
      ? ` At this bodyweight the committed edge is ${round(committedLbs)} lb/wk, under the ` +
        `${C.bodyweightNoiseFloorLbsPerWeek} lb weekly noise floor ` +
        '(rp:rp-s12-no-adjustment-under-half-pound-weekly-change), so judge it over several weeks.'
      : '';
  const citation =
    kind === 'loss' ? 'rp:rp-s11-fat-loss-rate-heuristic' : 'rp:rp-s11-muscle-gain-rate-heuristic';
  return `Bodyweight band is the declared phase’s own rate (${citation}).${noise}`;
}

/** A 28-day session count is a commitment the lifter makes, not a derived gain. */
function sessionCountShape(notes: string[]): BandShape {
  notes.push(
    'A 28-day session count is a commitment, not a progression: the band holds at the declared ' +
      'count and the rolling window is what moves (never a streak).',
  );
  return {
    basis: 'execution_ramp',
    infoLevel: 'cold',
    lowPctPerWeek: 0,
    highPctPerWeek: 0,
    corridorPct: 0,
    direction: 'hold',
  };
}

/**
 * What the declared diet phase does to a strength band.
 *
 * The multiplier is `dietPhaseTolerance`'s own, read at zero deviation so only
 * the phase and weeks-in-phase move it. Fat loss re-centres on hold, because a
 * deficit is expected to cost strength rather than add it; a gain phase keeps
 * the ramp's high edge and narrows toward it, because a surplus should be
 * delivering; a recomposition drops the committed edge to hold and keeps the
 * ramp as the stretch. A beginner's band is untouched in every phase
 * (rp:rp-s4-training-invariant-across-diet-phase).
 */
function reshapeForDiet(
  shape: BandShape,
  tier: Tier,
  dietState: DietPhaseState,
  notes: string[],
): BandShape {
  if (dietState.phase === 'maintenance' || dietState.phase === 'unknown') return shape;
  if (tier === 'beginner') {
    notes.push(
      'Beginner tier: the band does not change across diet phases, because a beginner program ' +
        'does not (rp:rp-s4-training-invariant-across-diet-phase).',
    );
    return shape;
  }
  if (dietState.phase === 'recomposition') return recompositionLiftShape(shape, notes);
  const multiplier = dietPhaseTolerance(dietState, 0, 'flat').toleranceMultiplier;
  const halfSpan = ((shape.highPctPerWeek - shape.lowPctPerWeek) / 2) * multiplier;
  if (dietState.phase === 'fat-loss') {
    notes.push(
      'Fat-loss phase: the strength target is centred on hold, not on gain, and widened by the ' +
        `phase tolerance (x${multiplier}). Holding a lift through a deficit is the win ` +
        '(rp:rp-s11-diet-phase-training-fatigue-coupling).',
    );
    return { ...shape, lowPctPerWeek: -halfSpan, highPctPerWeek: halfSpan, direction: 'hold' };
  }
  notes.push(
    `Gain phase: the ramp stands and the band tightens toward it (x${multiplier}); a surplus ` +
      'should be producing progress (rp:rp-s11-diet-phase-training-fatigue-coupling).',
  );
  const low = shape.highPctPerWeek - (shape.highPctPerWeek - shape.lowPctPerWeek) * multiplier;
  return { ...shape, lowPctPerWeek: low, direction: directionOf(low, shape.highPctPerWeek) };
}

/**
 * Recomposition: the committed edge drops to hold and the stretch stays the
 * tier's RP ramp. Nothing is shaded and no haircut is invented — the pair says
 * "specialization allowed, lower expectations" purely by where the two cited
 * edges already sit (VW-346 §2c).
 */
function recompositionLiftShape(shape: BandShape, notes: string[]): BandShape {
  const hold = C.recompositionLiftHoldPctPerWeek;
  notes.push(
    'Recomposition phase: the committed edge is hold and the stretch stays the programmed ramp. A ' +
      'recomposition runs on maintenance calories and a non-beginner gets better absolute results ' +
      'from sequenced phases (rp:rp-s12-recomposition-requires-maintenance-calories), so holding a ' +
      'lift here is the commitment and the ramp is the upside.',
  );
  notes.push(
    `Specialization stays allowed under recomposition, capped at ${C.recompositionSpecializationCap} ` +
      'muscle. ENGINEERING DEFAULT: the corpus permits specialization in a gain phase and forbids it ' +
      'in a deficit (rp:rp-s5-fatloss-priority-training-rule), and states nothing in between. This is ' +
      'advisory copy, never a block.',
  );
  return { ...shape, lowPctPerWeek: hold, direction: directionOf(hold, shape.highPctPerWeek) };
}

/**
 * Walk the weeks. Week 1 sits at the start value; every later non-deload week
 * advances one step; a deload week repeats the week before it, which is what
 * "a deload week flattens the band" means.
 */
function projectRate(
  input: GoalBandInput,
  shape: BandShape,
  notes: string[],
): GoalBandExpectation[] {
  const lowStep = (input.startValue * shape.lowPctPerWeek) / 100;
  const highStep = (input.startValue * shape.highPctPerWeek) / 100;
  if (input.layoff && shape.basis !== 'execution_ramp') {
    notes.push(
      `Front-loaded: the first ${C.layoffFrontLoadWeeks} ramping weeks carry a wider high edge, ` +
        'because strength returns fast after a layoff and then decelerates ' +
        '(rp:rp-s7-early-strength-gains-not-pure-muscle-signal).',
    );
  }
  const expected: GoalBandExpectation[] = [];
  let low = input.startValue;
  let high = input.startValue;
  let advanced = 0;
  for (const [position, week] of input.weeks.entries()) {
    if (position > 0 && !week.isDeload) {
      advanced += 1;
      low += lowStep;
      high += highStep * frontLoadFactor(input.layoff, shape.basis, advanced);
    }
    expected.push({ weekIndex: week.index, low: round(low), high: round(high) });
  }
  return expected;
}

function frontLoadFactor(layoff: boolean, basis: GoalBandBasis, advanced: number): number {
  if (!layoff || basis === 'execution_ramp') return 1;
  return advanced <= C.layoffFrontLoadWeeks ? C.layoffFrontLoadHighMultiplier : 1;
}

/** A corridor does not accumulate: every week sits inside the same two edges. */
function projectCorridor(input: GoalBandInput, corridorPct: number): GoalBandExpectation[] {
  const low = round(input.startValue * (1 - corridorPct / 100));
  const high = round(input.startValue * (1 + corridorPct / 100));
  return input.weeks.map((week) => ({ weekIndex: week.index, low, high }));
}

function directionOf(lowPctPerWeek: number, highPctPerWeek: number): 'up' | 'down' | 'hold' {
  if (lowPctPerWeek > 0 && highPctPerWeek > 0) return 'up';
  if (lowPctPerWeek < 0 && highPctPerWeek < 0) return 'down';
  return 'hold';
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
