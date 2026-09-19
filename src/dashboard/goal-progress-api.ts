// Gathers the inputs `read-models/goal-progress.ts` projects, for `GET
// /api/goals` and `GET /api/goal-progress` (VW-352, plan G5).
//
// THE BAND IS RE-DERIVED, NEVER RE-COMPUTED HERE. `deriveTargetInFrame` runs
// the same derivation `goal.propose_targets` runs, against the target's own
// stored selection, so this route can never disagree with the tool path about
// what a band looks like. Only the weekly `expected` corridor comes from that
// fresh band; `committed` and `stretch` on the view are the target's own FIXED
// numbers, read straight off the stored row (`buildGoalProgressView`'s own
// contract).
//
// THE BAND IS ANCHORED IN THE TARGET'S FRAME (VW-449). A lift band starts at the
// target's stored start value on week 1 of its block. Re-deriving it from today's
// latest lift restarted the line at wherever the lifter is now, on every read,
// so a lifter was judged against a band that moved with them.
//
// `mrvVerdict` IS NEVER WIRED HERE. `checkMrvGuard` needs three specific,
// ordered session ids and VW-131 already decided `mrvguard.check` stays
// diagnostic-only with "no internal wiring, no not-yet-built advisory tool
// consuming this" — the same reasoning applies to this read. A future
// consumer that wants it runs the check itself and passes the verdict in.
//
// Confidentiality: fitness units, plan metadata and coaching prose only — no
// protocol data (NF-07).

import {
  deriveTargetInFrame,
  readDerivationContext,
  type GoalDerivationState,
} from '../tools/goal-derivation.js';
import { markPersonalRecords } from '../analytics/goal-history.js';
import { listOfferDecisions, offerInputsOf } from '../tools/goal-recalibration.js';
import { computeHistoryTrend, type HistoryTrendResult } from '../tools/metrics-tools.js';
import { log } from '../logger.js';
import {
  buildFatigueAxesLookup,
  buildGoalProgressView,
  buildPriorityRollup,
  type GoalActual,
  type GoalFatigueContext,
  type GoalPlateauVerdict,
  type GoalProgressView,
  type PriorityRollupView,
} from './read-models/index.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredGoalTarget,
  type StoredPriority,
} from '../store/types.js';

/** The store slice this route needs: `GoalDerivationState`'s, plus the priority/target reads. */
export type GoalProgressStore = GoalDerivationState['store'] & {
  listPriorities: SessionStore['listPriorities'];
  listGoalTargets: SessionStore['listGoalTargets'];
  /** Optional: a store without the advisory log simply has no recalibration answers to show. */
  listAdvisoryDecisions?: SessionStore['listAdvisoryDecisions'];
};

/** The recalibration answers the page reads (VW-444 part 2). */
interface OfferAnswers {
  /** Proposal rows of unanswered offers: shown as a line on the ramp's own card, never as a card. */
  openOfferRows: ReadonlySet<string>;
  /** Accepted starting ramps whose offer the lifter declined. */
  declinedTargets: ReadonlySet<string>;
}

async function readOfferAnswers(store: GoalProgressStore): Promise<OfferAnswers> {
  const list = store.listAdvisoryDecisions;
  if (list === undefined) return { openOfferRows: new Set(), declinedTargets: new Set() };
  const decisions = await listOfferDecisions({ listAdvisoryDecisions: list.bind(store) });
  const open = decisions.filter((decision) => decision.userResponse === undefined);
  const declined = decisions.filter((decision) => decision.userResponse === 'declined');
  return {
    openOfferRows: new Set(open.map((decision) => offerInputsOf(decision).offerTargetId)),
    declinedTargets: new Set(declined.map((decision) => offerInputsOf(decision).targetId)),
  };
}

/** Every non-retired target under one priority, each with its progress view. */
export async function fetchGoalProgressViews(
  store: GoalProgressStore,
  priority: StoredPriority,
  now: Date,
): Promise<GoalProgressView[]> {
  const answers = await readOfferAnswers(store);
  const targets = (await store.listGoalTargets({ priorityId: priority.id })).filter(
    (target) => !answers.openOfferRows.has(target.id),
  );
  if (targets.length === 0) return [];
  const context = await readDerivationContext({ store }, priority);
  const views: GoalProgressView[] = [];
  for (const target of targets) {
    const view = await viewFor(store, { priority, target, context, answers, now });
    if (view !== undefined) views.push(view);
  }
  return views;
}

async function viewFor(
  store: GoalProgressStore,
  read: {
    priority: StoredPriority;
    target: StoredGoalTarget;
    context: Awaited<ReturnType<typeof readDerivationContext>>;
    answers: OfferAnswers;
    now: Date;
  },
): Promise<GoalProgressView | undefined> {
  const { priority, target, context } = read;
  const derived = await deriveTargetInFrame({ store }, context, target);
  if (!('band' in derived)) {
    log.debug(`goal-progress: '${target.id}' band could not be re-derived: ${derived.reason}`);
    return undefined;
  }
  const { actuals, plateauVerdict } = await readActuals(store, target);
  const fatigue = await readFatigue(store, target);
  return buildGoalProgressView({
    priority,
    target,
    band: derived.band,
    calibrationEvidence: {
      matchedSessionCount: derived.matchedSessionCount,
      baselineState: derived.baselineState,
    },
    recalibrationDeclined: read.answers.declinedTargets.has(target.id),
    actuals,
    weeks: context.weeks,
    now: read.now.toISOString(),
    dietState: context.dietState,
    ...(fatigue === undefined ? {} : { fatigue }),
    ...(plateauVerdict === undefined ? {} : { plateauVerdict }),
  });
}

/** `history.trend`'s metric name for a target's own metric, or `null` for a non-lift metric. */
function historyTrendMetricFor(metric: StoredGoalTarget['metric']): 'topLoad' | 'e1rm' | null {
  if (metric === 'e1rm_trend') return 'e1rm';
  if (metric === 'top_load_at_reps' || metric === 'reps_at_load') return 'topLoad';
  return null;
}

/**
 * The verdict and the run that earned it. A lift's run is the flatline
 * (VW-452), so the days and the reasoning are its own, not WA's wider window.
 */
function plateauVerdictOf(plateau: NonNullable<HistoryTrendResult['plateau']>): GoalPlateauVerdict {
  const run = plateau.flatline;
  if (run === null) return { verdict: plateau.verdict };
  return { verdict: plateau.verdict, plateauDays: run.days, reasoning: `${run.reasoning}.` };
}

/**
 * The readings a target is tracked against, plus the plateau verdict when the
 * metric is a lift — both come from the SAME `computeHistoryTrend` call
 * `history.trend` itself runs, so this page can never show a series or a
 * plateau call the MCP tool would disagree with. A `sessions_28d` target
 * reads the live rolling count; a `bodyweight` target reads the recent log.
 *
 * Only a lift's readings can carry a personal record (VW-384); the other two
 * metrics say why they cannot inline below.
 */
async function readActuals(
  store: GoalProgressStore,
  target: StoredGoalTarget,
): Promise<{ actuals: GoalActual[]; plateauVerdict?: GoalPlateauVerdict }> {
  if (target.metric === 'sessions_28d') {
    const from = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const count = await store.countSessions({ from, endedOnly: true });
    return {
      // A rolling attendance count is a dose, not a performance — there is no record to beat.
      actuals: [{ ts: new Date().toISOString(), value: count, matched: true, isPR: false }],
    };
  }
  if (target.metric === 'bodyweight') {
    const recent = await store.listBodyMetrics(LOCAL_USER_ID, { sinceDays: 30 });
    // The store lists newest first; every reader of `actuals` takes the last entry as the newest.
    return {
      actuals: [...recent].reverse().map((entry) => ({
        ts: entry.measuredAt,
        value: entry.bodyweightLbs,
        matched: true,
        // A scale reading is a body-composition measurement, and a new high or low is never a PR.
        isPR: false,
      })),
    };
  }
  const historyMetric = historyTrendMetricFor(target.metric);
  if (historyMetric === null || target.exerciseId === undefined) return { actuals: [] };
  try {
    const trend = await computeHistoryTrend(
      { store },
      { exerciseId: target.exerciseId, metric: historyMetric },
    );
    // `TimeSeries` degrades to `any[]` through the analytics package's .d.ts
    // under NodeNext resolution (the same note `metrics-tools.ts` carries), so
    // the map callback is annotated explicitly rather than inferred.
    type Point = { ts: string; value: number };
    // The PR verdict is computed from the series, never from a label anyone
    // stored: `markPersonalRecords` compares each reading against the earlier
    // readings of the same window this page is already showing.
    const actuals = markPersonalRecords(
      trend.series.map((point: Point) => ({ ts: point.ts, value: point.value })),
    ).map((reading) => ({ ...reading, matched: true }));
    // `plateau` is `null` in the VW-361 new-chapter state, where there is
    // nothing since the boundary to fit — that is an absent read, not a
    // `'none'` verdict, so no `plateauVerdict` is reported at all.
    if (trend.plateau === null) return { actuals };
    return {
      actuals,
      plateauVerdict: plateauVerdictOf(trend.plateau),
    };
  } catch (err) {
    // A lift with no working sets in the window throws NOT_FOUND; that is an
    // absent series, not a failure of the page (mirrors `tryHistoryTrend`,
    // `tools/goal-derivation.ts`).
    log.debug(`goal-progress: no '${historyMetric}' trend for '${target.exerciseId}'`, err);
    return { actuals: [] };
  }
}

/**
 * The entry-depression confounder off the target exercise's most recent
 * session, when one is measurable. `undefined` for a non-lift metric or an
 * exercise with no recorded sets.
 */
async function readFatigue(
  store: GoalProgressStore,
  target: StoredGoalTarget,
): Promise<GoalFatigueContext | undefined> {
  if (target.exerciseId === undefined) return undefined;
  const sets = await store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId: target.exerciseId,
  });
  if (sets.length === 0) return undefined;
  const latestSessionId = sets.reduce((latest, set) =>
    set.startedAt > latest.startedAt ? set : latest,
  ).sessionId;
  const axis = buildFatigueAxesLookup(sets)({
    sessionId: latestSessionId,
    exerciseId: target.exerciseId,
  })?.entryDepression;
  if (axis === undefined || axis.value === null) return undefined;
  return { entryDepressionPct: axis.value, confidence: axis.confidence };
}

/** One priority, its accepted targets, and the rollup built from their progress views. */
export interface GoalPriorityRow {
  priority: StoredPriority;
  targets: StoredGoalTarget[];
  rollup: PriorityRollupView | null;
}

/** `GET /api/goals`'s payload: every declared priority with its accepted targets and rollup. */
export async function fetchGoalPriorityRows(
  store: GoalProgressStore,
  now: Date,
): Promise<GoalPriorityRow[]> {
  const priorities = await store.listPriorities(LOCAL_USER_ID);
  const rows: GoalPriorityRow[] = [];
  for (const priority of priorities) {
    const views = await fetchGoalProgressViews(store, priority, now);
    const acceptedViews = views.filter((view) => view.target.acceptedBy !== undefined);
    rows.push({
      priority,
      targets: acceptedViews.map((view) => view.target),
      rollup: acceptedViews.length === 0 ? null : buildPriorityRollup(acceptedViews)[0],
    });
  }
  return rows;
}
