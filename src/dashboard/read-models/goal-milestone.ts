// The block-end half of a goal target's read (VW-400): the committed number as
// a milestone due in the block's last week, whether it has been reached, and
// what each week of the block came to against its own band row.
//
// THE MILESTONE IS THE HORIZON, NOT THE WAYPOINT. `nextMilestone` on the view
// is next week's committed edge, which the chart's band needs; this is the
// target's own fixed committed number, which the card leads with. A target is
// judged met the moment a matched reading reaches that number, and otherwise
// at the block boundary (rp:rp-s10-underpromise-overdeliver-goal-setting,
// rp:rp-s10-three-month-planning-horizon). A miss is a state, never a score.
//
// Shapes mirror titan's `goalMilestone.ts` one to one, so the card derives
// nothing: a load metric's target and readings are sets, every other metric's
// are bare values.
//
// Confidentiality: fitness units and plan metadata only, no protocol data (NF-07).

import { blockWeekAt } from '../../analytics/goal-block-weeks.js';
import {
  GOAL_BAND_CONSTANTS,
  type GoalBand,
  type GoalBandExpectation,
  type GoalBandWeek,
} from '../../analytics/goal-band.js';
import { DEVICE_LOAD_STEP_LBS } from '../../analytics/percent-increment.js';
import type { StoredGoalMetric, StoredGoalTarget } from '../../store/types.js';

/** Where the block's committed number stands. There is no "due" state: it is judged at block end. */
export type GoalMesoMilestoneState = 'upcoming' | 'hit' | 'missed';

/** One week's latest matched reading against that week's band row. */
export type GoalWeekOutcome = 'ahead' | 'on_track' | 'missed' | 'none';

/** The best matched reading of the block against the committed number, at the metric's precision. */
export type GoalReach = 'short' | 'met' | 'beyond';

export interface GoalMesoLoadTarget {
  metric: 'top_load_at_reps' | 'reps_at_load';
  reps: number;
  load: number;
  /** Every stored value in this system is pounds (VW-230). */
  unit: 'lb' | 'kg';
}

/** Any metric without a full set: a value metric, or a load metric whose anchor was never recorded. */
export interface GoalMesoValueTarget {
  metric: StoredGoalMetric;
  value: number;
  unit: string;
}

export type GoalMesoTarget = GoalMesoLoadTarget | GoalMesoValueTarget;

/** A matched reading in its target's own shape. */
export type GoalMesoReading = { reps: number; load: number } | { value: number };

export interface GoalMesoMilestone {
  target: GoalMesoTarget;
  /** The block's last week, 1-based: the week the committed number is due. */
  goalWeek: number;
  /** 1-based, and past `weekCount` once the block has ended. */
  currentWeek: number;
  weekCount: number;
  direction: GoalBand['direction'];
  /** The latest matched reading inside the block. */
  latest?: GoalMesoReading;
  state: GoalMesoMilestoneState;
}

/** Titan's `GoalWeekEntry`, plus the week it belongs to. */
export interface GoalWeekOutcomeEntry {
  weekIndex: number;
  outcome: GoalWeekOutcome;
  /** The week's latest matched reading; absent when `outcome` is `none`. */
  reading?: GoalMesoReading;
}

/** A matched reading that fell inside the block, with its 0-based week position. */
export interface BlockReading {
  value: number;
  position: number;
}

export interface GoalReachRead {
  reach: GoalReach;
  /** The best matched reading of the block, in the goal’s direction; a hold commitment’s latest. */
  best: number;
}

export interface MesoMilestoneInput {
  target: StoredGoalTarget;
  band: GoalBand;
  weeks: readonly GoalBandWeek[];
  readings: readonly BlockReading[];
  now: string;
  reach: GoalReachRead | null;
}

/** Metrics counted in whole units; every other metric compares at a tenth. */
const WHOLE_UNIT_METRICS: readonly StoredGoalMetric[] = ['reps_at_load', 'sessions_28d'];

/**
 * A top load is a weight the lifter sets, so the card prints and scores it at
 * the device's step. The band itself stays exact (VW-482).
 */
function atDeviceStep(loadLbs: number): number {
  return Math.round(loadLbs / DEVICE_LOAD_STEP_LBS) * DEVICE_LOAD_STEP_LBS;
}

const VALUE_UNIT: Record<StoredGoalMetric, string> = {
  top_load_at_reps: 'lb',
  reps_at_load: 'reps',
  bodyweight: 'lb',
  e1rm_trend: 'lb',
  sessions_28d: '',
  composite_strength: '',
};

/** The band row for a week, by `weekIndex` first so a reordered band still lines up. */
export function expectationAt(
  band: GoalBand,
  weeks: readonly GoalBandWeek[],
  position: number,
): GoalBandExpectation {
  const week = weeks[position];
  const byIndex = week && band.expected.find((row) => row.weekIndex === week.index);
  return byIndex ?? band.expected[position] ?? band.expected[band.expected.length - 1];
}

/**
 * A band that commits to no change but runs a direction: only a slow-loss
 * recomposition's bodyweight band has this shape (VW-468), since a zero edge
 * reads as `hold` everywhere else.
 */
export function commitsToHold(band: GoalBand): boolean {
  return band.direction !== 'hold' && band.bandLowPctPerWeek === 0;
}

/**
 * A two-sided corridor: the maintenance bodyweight band, where a departure
 * either way is a departure (VW-457). A lift held through a deficit is not one.
 */
export function isCorridor(band: GoalBand): boolean {
  return band.direction === 'hold' && (band.corridorPct ?? 0) > 0;
}

/** Which side of its corridor a reading sits on, or `null` inside it. */
export function corridorSideOf(
  expected: GoalBandExpectation,
  value: number,
): 'above' | 'below' | null {
  const [low, high] = [expected.low, expected.high].sort((a, b) => a - b);
  if (value > high) return 'above';
  return value < low ? 'below' : null;
}

/** How far past a hold commitment still reads as holding: one week's noise floor. */
function holdToleranceOf(band: GoalBand): number {
  return commitsToHold(band) ? GOAL_BAND_CONSTANTS.bodyweightNoiseFloorLbsPerWeek : 0;
}

/** Below the conservative edge, whichever numeric side of it that is (VW-348). */
export function behindEdge(committedEdge: number, value: number, band: GoalBand): boolean {
  const tolerance = holdToleranceOf(band);
  if (band.direction === 'down') return value > committedEdge + tolerance;
  if (band.direction === 'hold') return false;
  return value < committedEdge - tolerance;
}

/** Past the stretch edge. A `hold` goal has no stretch to pass. */
export function aheadOfEdge(stretchEdge: number, value: number, band: GoalBand): boolean {
  if (band.direction === 'down') return value < stretchEdge;
  if (band.direction === 'hold') return false;
  return value > stretchEdge;
}

/** Matched readings taken inside the block, oldest first, each with the week it fell in. */
export function blockReadingsOf(
  target: StoredGoalTarget,
  weeks: readonly GoalBandWeek[],
  matched: readonly { ts: string; value: number }[],
): BlockReading[] {
  return matched.flatMap((actual) => {
    const position = blockWeekAt(target.startMeasuredAt, actual.ts) - 1;
    return position >= 0 && position < weeks.length ? [{ value: actual.value, position }] : [];
  });
}

/**
 * The block's best matched reading against the committed number. `null` for a
 * lift held through a diet phase, which has no side to be past; `short` with no reading at all.
 */
export function goalReachOf(
  target: StoredGoalTarget,
  band: GoalBand,
  readings: readonly BlockReading[],
  weekCount: number,
): GoalReachRead | null {
  const direction = band.direction;
  if (isCorridor(band)) return corridorReachOf(target, band, readings, weekCount);
  if (direction === 'hold' || readings.length === 0) {
    return direction === 'hold' ? null : { reach: 'short', best: target.startValue };
  }
  if (commitsToHold(band)) return holdReachOf(target, band, readings, weekCount);
  const values = readings.map((reading) => reading.value);
  const best = direction === 'down' ? Math.min(...values) : Math.max(...values);
  return reachAt(target, direction, best, 0);
}

/**
 * A hold commitment is kept to the end, not reached once: the committed number is the
 * start value, so the first flat reading would otherwise meet it for the whole block.
 * It is read in the block's final week, off the latest reading (VW-468).
 */
function holdReachOf(
  target: StoredGoalTarget,
  band: GoalBand,
  readings: readonly BlockReading[],
  weekCount: number,
): GoalReachRead {
  const latest = readings[readings.length - 1];
  if (latest.position < weekCount - 1) return { reach: 'short', best: latest.value };
  return reachAt(target, band.direction, latest.value, holdToleranceOf(band));
}

/**
 * A corridor is kept to the end the same way (VW-468): judged in the final week off
 * the latest reading, met inside the corridor, and never beyond it (VW-457).
 */
function corridorReachOf(
  target: StoredGoalTarget,
  band: GoalBand,
  readings: readonly BlockReading[],
  weekCount: number,
): GoalReachRead {
  const latest = readings[readings.length - 1];
  if (latest === undefined) return { reach: 'short', best: target.startValue };
  const inFinalWeek = latest.position >= weekCount - 1;
  const inside = corridorSideOf(band.expected[band.expected.length - 1], latest.value) === null;
  return { reach: inFinalWeek && inside ? 'met' : 'short', best: latest.value };
}

function reachAt(
  target: StoredGoalTarget,
  direction: GoalBand['direction'],
  value: number,
  tolerance: number,
): GoalReachRead {
  const sign = direction === 'down' ? -1 : 1;
  const past =
    (atPrecision(target.metric, value) - atPrecision(target.metric, target.committedValue)) * sign;
  if (past < -tolerance) return { reach: 'short', best: value };
  return { reach: past <= tolerance ? 'met' : 'beyond', best: value };
}

function atPrecision(metric: StoredGoalMetric, value: number): number {
  if (WHOLE_UNIT_METRICS.includes(metric)) return Math.round(value);
  if (metric === 'top_load_at_reps') return atDeviceStep(value);
  return Math.round(value * 10) / 10;
}

export function mesoMilestoneOf(input: MesoMilestoneInput): GoalMesoMilestone {
  const { target, band, weeks, readings } = input;
  const weekCount = weeks.length;
  const currentWeek = Math.max(1, blockWeekAt(target.startMeasuredAt, input.now));
  const last = readings[readings.length - 1];
  const ended = currentWeek > weekCount;
  return {
    target: mesoTargetOf(target),
    goalWeek: weeks[weekCount - 1]?.index ?? weekCount,
    currentWeek,
    weekCount,
    direction: band.direction,
    ...(last === undefined ? {} : { latest: readingShape(target, last.value) }),
    state: milestoneState(input, ended, last),
  };
}

/**
 * Hit the moment the committed number is lifted; missed only once the block
 * has ended without it. A lift held through a diet phase has no number to lift, so
 * it is judged at the boundary alone: held if its last reading sits inside that week's band.
 */
function milestoneState(
  input: MesoMilestoneInput,
  ended: boolean,
  last: BlockReading | undefined,
): GoalMesoMilestoneState {
  if (input.reach !== null && input.reach.reach !== 'short') return 'hit';
  if (!ended) return 'upcoming';
  if (input.reach !== null || last === undefined) return 'missed';
  const expected = expectationAt(input.band, input.weeks, last.position);
  return insideCorridor(expected, last.value) ? 'hit' : 'missed';
}

/** One entry per week of the block, aligned to week 1. */
export function weekOutcomesOf(
  target: StoredGoalTarget,
  band: GoalBand,
  weeks: readonly GoalBandWeek[],
  readings: readonly BlockReading[],
): GoalWeekOutcomeEntry[] {
  return weeks.map((week, position) => {
    const latest = readings.filter((reading) => reading.position === position).pop();
    if (latest === undefined) return { weekIndex: week.index, outcome: 'none' };
    const expected = expectationAt(band, weeks, position);
    return {
      weekIndex: week.index,
      outcome: outcomeAgainst(expected, latest.value, band),
      reading: readingShape(target, latest.value),
    };
  });
}

function outcomeAgainst(
  expected: GoalBandExpectation,
  value: number,
  band: GoalBand,
): GoalWeekOutcome {
  if (band.direction === 'hold') return insideCorridor(expected, value) ? 'on_track' : 'missed';
  if (behindEdge(expected.low, value, band)) return 'missed';
  return aheadOfEdge(expected.high, value, band) ? 'ahead' : 'on_track';
}

function insideCorridor(expected: GoalBandExpectation, value: number): boolean {
  return corridorSideOf(expected, value) === null;
}

/** The committed number as the card prints it: a whole set when both anchors are known. */
function mesoTargetOf(target: StoredGoalTarget): GoalMesoTarget {
  const committed = target.committedValue;
  if (target.metric === 'top_load_at_reps' && target.anchorReps !== undefined) {
    const load = atDeviceStep(committed);
    return { metric: target.metric, reps: target.anchorReps, load, unit: 'lb' };
  }
  if (target.metric === 'reps_at_load' && target.anchorLoad !== undefined) {
    return { metric: target.metric, reps: committed, load: target.anchorLoad, unit: 'lb' };
  }
  return { metric: target.metric, value: committed, unit: VALUE_UNIT[target.metric] };
}

function readingShape(target: StoredGoalTarget, value: number): GoalMesoReading {
  if (target.metric === 'top_load_at_reps' && target.anchorReps !== undefined) {
    return { reps: target.anchorReps, load: value };
  }
  if (target.metric === 'reps_at_load' && target.anchorLoad !== undefined) {
    return { reps: value, load: target.anchorLoad };
  }
  return { value };
}
