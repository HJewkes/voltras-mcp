// Gathers the inputs `read-models/goal-progress.ts` projects, for `GET
// /api/goals` and `GET /api/goal-progress` (VW-352, plan G5).
//
// THE BAND IS RE-DERIVED, NEVER RE-COMPUTED HERE. `deriveTarget` (the same
// function `goal.propose_targets` runs) is imported and re-run against the
// target's own stored metric/exercise/anchor selection, so this route can
// never disagree with the tool path about what a band looks like. Only the
// weekly `expected` corridor comes from that fresh band; `committed` and
// `stretch` on the view are the target's own FIXED numbers, read straight
// off the stored row (`buildGoalProgressView`'s own contract).
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
  deriveTarget,
  readDerivationContext,
  type GoalDerivationState,
} from '../tools/goal-derivation.js';
import { computeHistoryTrend } from '../tools/metrics-tools.js';
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
};

/** Every non-retired target under one priority, each with its progress view. */
export async function fetchGoalProgressViews(
  store: GoalProgressStore,
  priority: StoredPriority,
  now: Date,
): Promise<GoalProgressView[]> {
  const targets = await store.listGoalTargets({ priorityId: priority.id });
  if (targets.length === 0) return [];
  const context = await readDerivationContext({ store }, priority);
  const views: GoalProgressView[] = [];
  for (const target of targets) {
    const derived = await deriveTarget({ store }, context, {
      kind: 'gain',
      metric: target.metric,
      exerciseId: target.exerciseId ?? null,
      anchorReps: target.anchorReps ?? null,
      role: 'primary',
    });
    if (!('band' in derived)) {
      log.debug(`goal-progress: '${target.id}' band could not be re-derived: ${derived.reason}`);
      continue;
    }
    const { actuals, plateauVerdict } = await readActuals(store, target);
    const fatigue = await readFatigue(store, target);
    views.push(
      buildGoalProgressView({
        priority,
        target,
        band: derived.band,
        actuals,
        weeks: context.weeks,
        now: now.toISOString(),
        dietState: context.dietState,
        ...(fatigue === undefined ? {} : { fatigue }),
        ...(plateauVerdict === undefined ? {} : { plateauVerdict }),
      }),
    );
  }
  return views;
}

/** `history.trend`'s metric name for a target's own metric, or `null` for a non-lift metric. */
function historyTrendMetricFor(metric: StoredGoalTarget['metric']): 'topLoad' | 'e1rm' | null {
  if (metric === 'e1rm_trend') return 'e1rm';
  if (metric === 'top_load_at_reps' || metric === 'reps_at_load') return 'topLoad';
  return null;
}

/**
 * The readings a target is tracked against, plus the plateau verdict when the
 * metric is a lift — both come from the SAME `computeHistoryTrend` call
 * `history.trend` itself runs, so this page can never show a series or a
 * plateau call the MCP tool would disagree with. A `sessions_28d` target
 * reads the live rolling count; a `bodyweight` target reads the recent log.
 */
async function readActuals(
  store: GoalProgressStore,
  target: StoredGoalTarget,
): Promise<{ actuals: GoalActual[]; plateauVerdict?: GoalPlateauVerdict }> {
  if (target.metric === 'sessions_28d') {
    const from = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const count = await store.countSessions({ from, endedOnly: true });
    return {
      actuals: [{ ts: new Date().toISOString(), value: count, matched: true, isPR: false }],
    };
  }
  if (target.metric === 'bodyweight') {
    const recent = await store.listBodyMetrics(LOCAL_USER_ID, { sinceDays: 30 });
    return {
      actuals: recent.map((entry) => ({
        ts: entry.measuredAt,
        value: entry.bodyweightLbs,
        matched: true,
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
    const actuals = trend.series.map((point: Point) => ({
      ts: point.ts,
      value: point.value,
      matched: true,
      isPR: false,
    }));
    // `plateau` is `null` in the VW-361 new-chapter state, where there is
    // nothing since the boundary to fit — that is an absent read, not a
    // `'none'` verdict, so no `plateauVerdict` is reported at all.
    if (trend.plateau === null) return { actuals };
    return {
      actuals,
      plateauVerdict: {
        verdict: trend.plateau.verdict,
        plateauDays: trend.plateau.plateauDays,
        reasoning: trend.plateau.reasoning,
      },
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
