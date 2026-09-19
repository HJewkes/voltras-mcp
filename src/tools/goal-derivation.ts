// The reads behind `goal.propose_targets` (VW-350, plan §2c).
//
// EVERY INPUT TO A BAND IS READ, NONE IS TYPED. The start value comes from
// history, the tier from the tier signal, the phase from `diet_phases`, the
// weeks from the plan tree. A caller cannot hand this module a number and have
// it come back as a target — that is the whole point of the coach setting the
// target rather than the lifter naming one.
//
// WHAT THIS MODULE WILL NOT DERIVE, AND WHY IT SAYS SO. A metric with no
// series behind it comes back as a `skipped` entry carrying the reason, never
// as a band over a made-up start value. `composite_strength` is skipped by
// design rather than by gap: it is a mean over the per-lift legs, each of
// which already carries its own target, so banding the rollup would commit the
// lifter twice to the same work.

import { deriveGoalBand, type GoalBand, type GoalBandInput } from '../analytics/goal-band.js';
import type { GoalBandWeek, GoalDietState, GoalMetric } from '../analytics/goal-band.js';
import { slopeStandardError, topLoadAtReps } from '../analytics/goal-history.js';
import { modalRepCount, type RepCountedSet } from '../analytics/goal-history.js';
import type { GoalGainMetric } from '../analytics/goal-metrics.js';
import {
  SESSION_WINDOW_DAYS,
  readTrainingDays,
  readTrainingDaysMatching,
} from '../analytics/training-days.js';
import { setPurposeOf } from '../store/set-purpose.js';
import {
  LOCAL_USER_ID,
  type BaselineState,
  type SessionStore,
  type StoredGoalTarget,
  type StoredPriority,
  type StoredSet,
} from '../store/types.js';
import { readDietPhaseState } from './diet-phase-state.js';
import { computeHistoryTrend } from './metrics-tools.js';
import { getTierSignal, type Tier } from './tier-signal.js';

/**
 * The store slice this module reads. Declared narrow (rather than
 * `ServerState`) so a non-tool caller — the goal-progress dashboard route,
 * VW-352 — can re-derive a band without fabricating a whole server state; the
 * MCP tool path's `ServerState` still satisfies it structurally.
 */
export interface GoalDerivationState {
  store: Pick<
    SessionStore,
    | 'getTrainingProfile'
    | 'listSessionEndTimes'
    | 'getSessionDateSpan'
    | 'getTrainingWeeksForBlock'
    | 'getDietPhaseCovering'
    | 'listSessions'
    | 'getTrainingBlock'
    | 'getTrainingBlocksForProgram'
    | 'listBodyMetrics'
    | 'getSetsForExercise'
    | 'getBaseline'
    | 'chapterStartedAt'
  >;
}

/** A gap of this long makes the next mesocycle a return, not a continuation. rp:rp-s7-early-strength-gains-not-pure-muscle-signal */
const LAYOFF_GAP_DAYS = 90;

/**
 * Training days since a gap that make a return a continuation again.
 *
 * ENGINEERING DEFAULT. A mesocycle's session count is a plan fact this module
 * cannot read for a lifter with no plan tree, and the corpus gives no regain
 * figure at all ("Silent: any regain-rate figure", plan §1.10). Twelve is four
 * weeks at three workouts, the shortest ordinary mesocycle. Counted in training
 * days (VW-462), so one visit logged as a row per exercise is one workout.
 */
const TRAINING_DAYS_PER_MESO = 12;

/** Weeks a horizon falls back to when no block names one. rp:rp-s10-three-month-planning-horizon */
const DEFAULT_HORIZON_WEEKS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything a band needs that is the same for every metric of one priority. */
export interface GoalDerivationContext {
  priorityId: string;
  /** The DECLARED tier, which is what sets magnitude (plan §4 Q4). */
  tier: Tier;
  /** True when the tier-signal clamp disagreed with the declaration. */
  tierProvisional: boolean;
  dietState: GoalDietState;
  horizonWeeks: number;
  weeks: GoalBandWeek[];
  layoff: boolean;
  completedMesoCount: number;
  derivedAt: string;
  notes: string[];
}

/** One metric that could not be banded, with what to say about it. */
export interface SkippedMetric {
  metric: GoalMetric;
  exerciseId: string | null;
  reason: string;
}

/** One derived band plus the measurement it starts from. */
export interface DerivedTarget {
  metric: GoalMetric;
  exerciseId: string | null;
  anchorReps: number | null;
  startValue: number;
  startMeasuredAt: string;
  matchedSessionCount: number;
  baselineState: BaselineState;
  band: GoalBand;
}

export async function readDerivationContext(
  state: GoalDerivationState,
  priority: StoredPriority,
): Promise<GoalDerivationContext> {
  const derivedAt = new Date().toISOString();
  const signal = await getTierSignal(state, LOCAL_USER_ID);
  const notes: string[] = [];
  const weeks = await readHorizonWeeks(state, priority, notes);
  const dietState = await readDietPhaseState(state, derivedAt);
  return {
    priorityId: priority.id,
    tier: signal.declared ?? signal.tier,
    tierProvisional: signal.declared !== null && signal.declared !== signal.tier,
    // `slowLoss` is the DECLARED recomposition mode (VW-378), never read off
    // the scale: an undeclared recomposition is false here and lands on the
    // default hold corridor. Ignored by every other phase's band.
    dietState: {
      phase: dietState.phase,
      weeksInPhase: dietState.weeksInPhase,
      slowLoss: dietState.recompMode === 'slow-loss',
    },
    horizonWeeks: weeks.length,
    weeks,
    layoff: await hasRecentLayoff(state, derivedAt),
    completedMesoCount: await countCompletedMesos(state, priority),
    derivedAt,
    notes,
  };
}

/**
 * The horizon's weeks, with the deloads in them. A named block's own weeks are
 * authoritative; without one the horizon is a flat run of training weeks and
 * the note says the deloads in it are unknown rather than absent.
 */
async function readHorizonWeeks(
  state: GoalDerivationState,
  priority: StoredPriority,
  notes: string[],
): Promise<GoalBandWeek[]> {
  const planned =
    priority.blockId === undefined
      ? []
      : await state.store.getTrainingWeeksForBlock(priority.blockId);
  if (planned.length > 0) {
    return planned
      .slice(0, priority.horizonWeeks)
      .map((week, index) => ({ index: index + 1, isDeload: week.isDeload }));
  }
  const length = priority.horizonWeeks > 0 ? priority.horizonWeeks : DEFAULT_HORIZON_WEEKS;
  notes.push(
    'No plan tree backs this horizon, so every week is banded as a training week. A deload flattens ' +
      'the band across it, and one that is programmed later will not be reflected here (VW-326).',
  );
  return Array.from({ length }, (_, index) => ({ index: index + 1, isDeload: false }));
}

/**
 * Whether the lifter is inside the first mesocycle back after a 3+ month gap.
 *
 * Read off the session timeline rather than a self-report: a fitted slope over
 * a regain phase over-projects, and the timeline is what shows the gap
 * (plan §1.10).
 */
async function hasRecentLayoff(state: GoalDerivationState, nowIso: string): Promise<boolean> {
  const sessions = await state.store.listSessions({ sort: 'startedAt:asc', limit: 500 });
  const starts = sessions.map((session) => Date.parse(session.startedAt));
  let lastGapEndedAt: number | null = null;
  for (const [index, start] of starts.entries()) {
    const previous = starts[index - 1];
    if (previous !== undefined && start - previous >= LAYOFF_GAP_DAYS * DAY_MS) {
      lastGapEndedAt = start;
    }
  }
  if (lastGapEndedAt === null) return false;
  const since = { from: new Date(lastGapEndedAt).toISOString(), to: nowIso };
  return (await readTrainingDaysMatching(state.store, since)).length < TRAINING_DAYS_PER_MESO;
}

/**
 * Mesocycles completed before this one: the blocks of the priority's own
 * program that sit earlier in the order than its block.
 *
 * Without a block the answer is zero rather than a guess — an in-meso slope is
 * exactly what the `own` gate exists to keep out of a projection
 * (rp:rp-s5-intermediate-overplanning-risk).
 */
async function countCompletedMesos(
  state: GoalDerivationState,
  priority: StoredPriority,
): Promise<number> {
  if (priority.blockId === undefined) return 0;
  const block = await state.store.getTrainingBlock(priority.blockId);
  if (block === undefined) return 0;
  const siblings = await state.store.getTrainingBlocksForProgram(block.programId);
  return siblings.filter((sibling) => sibling.orderIndex < block.orderIndex).length;
}

/** Derive one gain leg, or say why it has no band. */
export async function deriveTarget(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  selection: GoalGainMetric,
): Promise<DerivedTarget | SkippedMetric> {
  if (selection.metric === 'composite_strength') return skipComposite(selection);
  if (selection.metric === 'bodyweight') return deriveBodyweight(state, context, selection);
  if (selection.metric === 'sessions_28d') return deriveSessionCount(state, context, selection);
  return deriveLiftTarget(state, context, selection);
}

function skipComposite(selection: GoalGainMetric): SkippedMetric {
  return {
    metric: selection.metric,
    exerciseId: selection.exerciseId,
    reason:
      'Composite strength is the mean of the specialized lifts’ own deltas, and each of those ' +
      'lifts carries its own target. A band on the rollup would commit you twice to the same work, ' +
      'so the read model computes it from the legs instead of tracking it against a number.',
  };
}

async function deriveBodyweight(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  selection: GoalGainMetric,
): Promise<DerivedTarget | SkippedMetric> {
  const recent = await state.store.listBodyMetrics(LOCAL_USER_ID, { sinceDays: 30 });
  const newest = recent[0];
  if (newest === undefined) {
    return {
      metric: selection.metric,
      exerciseId: null,
      reason:
        'No bodyweight reading in the last 30 days. Log one with `profile.log_bodyweight` and ask ' +
        'again: a bodyweight band starts from a measurement, never from an estimate.',
    };
  }
  const mean = recent.reduce((sum, entry) => sum + entry.bodyweightLbs, 0) / recent.length;
  return bandFor(context, selection, {
    startValue: recent.length > 1 ? mean : newest.bodyweightLbs,
    startMeasuredAt: newest.measuredAt,
    matchedSessionCount: recent.length,
    baselineState: 'CALIBRATED',
  });
}

async function deriveSessionCount(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  selection: GoalGainMetric,
): Promise<DerivedTarget | SkippedMetric> {
  const count = (await readTrainingDays(state.store, context.derivedAt)).length;
  if (count === 0) {
    return {
      metric: selection.metric,
      exerciseId: null,
      reason:
        `No training days in the last ${SESSION_WINDOW_DAYS} days, so there is no ` +
        'current rate to hold. Train a week and ask again.',
    };
  }
  return bandFor(context, selection, {
    startValue: count,
    startMeasuredAt: context.derivedAt,
    matchedSessionCount: count,
    baselineState: 'CALIBRATED',
  });
}

/** The measured start of a lift leg, plus the evidence that gates its band. */
interface StartMeasurement {
  startValue: number;
  startMeasuredAt: string;
  matchedSessionCount: number;
  baselineState: BaselineState;
  anchorReps?: number;
  ownSlope?: GoalBandInput['ownSlope'];
}

/** A metric with nothing measured behind it, carrying what to say about it. */
function noStartValue(selection: GoalGainMetric, reason: string): SkippedMetric {
  return { metric: selection.metric, exerciseId: selection.exerciseId, reason };
}

async function deriveLiftTarget(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  selection: GoalGainMetric,
): Promise<DerivedTarget | SkippedMetric> {
  const exerciseId = selection.exerciseId;
  if (exerciseId === null) {
    return noStartValue(selection, 'No exercise to read a start value from.');
  }
  if (selection.metric === 'e1rm_trend')
    return deriveE1rmContext(state, context, selection, exerciseId);
  const sets = repCountedSets(
    await state.store.getSetsForExercise({ userId: LOCAL_USER_ID, exerciseId }),
  );
  const anchorReps = selection.anchorReps ?? modalRepCount(sets);
  const read = anchorReps === null ? null : topLoadAtReps(sets, anchorReps);
  if (read === null || anchorReps === null) {
    return noStartValue(
      selection,
      `No working set on record for ${exerciseId}, so there is no measured start value. A start ` +
        'value is read from history and never typed; log a set and ask again.',
    );
  }
  const baseline = await state.store.getBaseline({ userId: LOCAL_USER_ID, exerciseId });
  return bandFor(context, selection, {
    startValue: read.value,
    startMeasuredAt: read.measuredAt,
    matchedSessionCount: read.matchedSessionCount,
    baselineState: baseline?.state ?? 'COLD',
    anchorReps,
    ...(await readOwnSlope(state, exerciseId, read.value)),
  });
}

/**
 * The e1RM leg starts from the e1RM series, not from a top load: the two are
 * different quantities, and seeding an estimate's band with a measured load
 * would make the band describe something the series never tracks. Context
 * only — this leg is shown with its band and never stored as a target.
 */
async function deriveE1rmContext(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  selection: GoalGainMetric,
  exerciseId: string,
): Promise<DerivedTarget | SkippedMetric> {
  const trend = await tryHistoryTrend(state, exerciseId, 'e1rm');
  const latest = trend?.series.reduce(
    (newest: { ts: string; value: number }, point: { ts: string; value: number }) =>
      point.ts > newest.ts ? point : newest,
  );
  if (latest === undefined || latest.value <= 0) {
    return {
      metric: selection.metric,
      exerciseId,
      reason:
        `No e1RM series for ${exerciseId} yet. The e1RM leg is context for the top-load target ` +
        'rather than a goal of its own, so its absence costs nothing that is being tracked.',
    };
  }
  const baseline = await state.store.getBaseline({ userId: LOCAL_USER_ID, exerciseId });
  return bandFor(context, selection, {
    startValue: latest.value,
    startMeasuredAt: latest.ts,
    matchedSessionCount: trend?.series.length ?? 0,
    baselineState: baseline?.state ?? 'COLD',
  });
}

/**
 * The lifter's own fitted trend, as a percent of the start value per week.
 *
 * The fit is `history.trend`'s, not a second one: re-fitting to get a standard
 * error would let two slopes over one series disagree (see
 * `analytics/goal-history.ts`). A lift with no fittable history simply has no
 * own slope, which the band's own gate then reports as a downgrade.
 */
async function readOwnSlope(
  state: GoalDerivationState,
  exerciseId: string,
  startValue: number,
): Promise<{ ownSlope?: GoalBandInput['ownSlope'] }> {
  const trend = await tryHistoryTrend(state, exerciseId);
  if (trend === null) return {};
  const se = slopeStandardError(trend.trend.slope, trend.trend.rSquared, trend.series.length);
  if (se === null) return {};
  const perWeekPct = (value: number) => ((value * 7) / startValue) * 100;
  return {
    ownSlope: {
      pctPerWeek: perWeekPct(trend.trend.slope),
      sePctPerWeek: perWeekPct(se),
      confidence: trend.trend.confidence,
    },
  };
}

/**
 * VW-361: a declared new chapter with nothing recorded since it comes back
 * with a `null` fit rather than a throw, and is folded into the same "no
 * history" answer. Deriving a band off the pre-chapter slope would propose a
 * number the reform was meant to retire.
 */
async function tryHistoryTrend(
  state: GoalDerivationState,
  exerciseId: string,
  metric: 'topLoad' | 'e1rm' = 'topLoad',
): Promise<FittedHistoryTrend | null> {
  try {
    const result = await computeHistoryTrend(state, { exerciseId, metric });
    return result.trend === null ? null : { series: result.series, trend: result.trend };
  } catch {
    // A lift with no working sets in the window throws NOT_FOUND; that is an
    // absent slope, not a failure of the proposal.
    return null;
  }
}

/** The two legs of a `history.trend` result this module reads, both non-null. */
interface FittedHistoryTrend {
  series: Awaited<ReturnType<typeof computeHistoryTrend>>['series'];
  trend: NonNullable<Awaited<ReturnType<typeof computeHistoryTrend>>['trend']>;
}

/**
 * The metrics whose band is anchored to a stored target's own frame. Every
 * metric that stores a start value is (VW-449 lifts, VW-451 bodyweight and the
 * session count); `composite_strength` never stores a target.
 */
const FRAMED_METRICS: readonly GoalMetric[] = [
  'top_load_at_reps',
  'reps_at_load',
  'e1rm_trend',
  'bodyweight',
  'sessions_28d',
];

/** The lift metrics a fitted slope can carry; `e1rm_trend` has never had one. */
const SLOPED_METRICS: readonly GoalMetric[] = ['top_load_at_reps', 'reps_at_load'];

/** The gain selection a stored target was derived from. */
export function selectionOf(target: StoredGoalTarget): GoalGainMetric {
  return {
    kind: 'gain',
    metric: target.metric,
    exerciseId: target.exerciseId ?? null,
    anchorReps: target.anchorReps ?? null,
    role: 'primary',
  };
}

/**
 * A stored target's band, re-derived INSIDE its own frame: the target's start
 * value on week 1 of its block, never today's latest lift (VW-449), today's
 * 30-day mean weight or today's session count (VW-451). Today's evidence still
 * decides the info level and, for a lift that earned one, supplies the fitted
 * slope, expressed against the frame's own start value.
 */
export async function deriveTargetInFrame(
  state: GoalDerivationState,
  context: GoalDerivationContext,
  frame: StoredGoalTarget,
): Promise<DerivedTarget | SkippedMetric> {
  const selection = selectionOf(frame);
  const today = await deriveTarget(state, context, selection);
  if (!('band' in today) && frame.metric === 'bodyweight' && frame.startValue > 0) {
    return bodyweightFrameWithoutReadings(context, selection, frame);
  }
  if (!('band' in today) || !FRAMED_METRICS.includes(frame.metric)) return today;
  if (frame.startValue <= 0) return today;
  const anchorReps = frame.anchorReps ?? today.anchorReps;
  const slope =
    frame.exerciseId !== undefined && SLOPED_METRICS.includes(frame.metric)
      ? await readOwnSlope(state, frame.exerciseId, frame.startValue)
      : {};
  return bandFor(context, selection, {
    startValue: frame.startValue,
    startMeasuredAt: frame.startMeasuredAt,
    matchedSessionCount: today.matchedSessionCount,
    baselineState: today.baselineState,
    ...(anchorReps === null ? {} : { anchorReps }),
    ...slope,
  });
}

/**
 * An accepted bodyweight target with no recent reading still has its frame:
 * the band starts at the stored start weight, and the missing readings are the
 * page's to show, not a reason to hide the goal.
 */
function bodyweightFrameWithoutReadings(
  context: GoalDerivationContext,
  selection: GoalGainMetric,
  frame: StoredGoalTarget,
): DerivedTarget {
  return bandFor(context, selection, {
    startValue: frame.startValue,
    startMeasuredAt: frame.startMeasuredAt,
    matchedSessionCount: 0,
    baselineState: 'CALIBRATED',
  });
}

function bandFor(
  context: GoalDerivationContext,
  selection: GoalGainMetric,
  measurement: StartMeasurement,
): DerivedTarget {
  const band = deriveGoalBand({
    metric: selection.metric,
    startValue: measurement.startValue,
    horizonWeeks: context.horizonWeeks,
    weeks: context.weeks,
    tier: context.tier,
    infoLevel: 'own',
    dietState: context.dietState,
    layoff: context.layoff,
    matchedSessionCount: measurement.matchedSessionCount,
    baselineState: measurement.baselineState,
    completedMesoCount: context.completedMesoCount,
    ...(measurement.ownSlope !== undefined ? { ownSlope: measurement.ownSlope } : {}),
  });
  return {
    metric: selection.metric,
    exerciseId: selection.exerciseId,
    anchorReps: measurement.anchorReps ?? null,
    startValue: measurement.startValue,
    startMeasuredAt: measurement.startMeasuredAt,
    matchedSessionCount: measurement.matchedSessionCount,
    baselineState: measurement.baselineState,
    band,
  };
}

/** Working sets only, reduced to the four fields a matched-reps read needs. */
function repCountedSets(sets: readonly StoredSet[]): RepCountedSet[] {
  return sets
    .filter((set) => setPurposeOf(set) === 'working')
    .map((set) => ({
      sessionId: set.sessionId,
      endedAt: set.endedAt,
      weightLbs: set.weightLbs ?? 0,
      repCount: set.reps.length,
    }));
}
