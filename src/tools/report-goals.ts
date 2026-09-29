// The goal section of `report.weekly` (VW-358, plan G11'). Every status word and rollup count
// comes from the GoalProgressView read model; this file only words them as lines.

import { fetchGoalProgressViews } from '../dashboard/goal-progress-api.js';
import { buildPriorityRollup, type GoalProgressStatus } from '../dashboard/read-models/index.js';
import {
  STATUS_LABEL,
  type GoalMesoWeek,
  type GoalProgressView,
} from '../dashboard/read-models/goal-progress.js';
import { localDate } from '../analytics/training-days.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type StoredGoalTarget } from '../store/types.js';

export interface WeeklyGoalLine {
  priorityId: string;
  /** Absent on a muscle priority's rollup line. */
  targetId?: string;
  status: GoalProgressStatus;
  text: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One line per accepted target of every priority live at `to`, plus a rollup line per muscle
 * priority. Goals belong to the owner, so a report scoped to a named lifter has none. A target
 * counts from its `derivedAt` (no accept time is stored) until its `retiredAt`.
 */
export async function buildGoalLines(
  state: ServerState,
  to: string,
  lifter: string | undefined,
): Promise<WeeklyGoalLine[]> {
  if (lifter !== undefined) return [];
  const store = withRetiredTargets(state.store);
  const priorities = await state.store.listPriorities(LOCAL_USER_ID, { includeRetired: true });
  const lines: WeeklyGoalLine[] = [];
  for (const priority of priorities.filter((row) => liveAt(row.declaredAt, row.retiredAt, to))) {
    const views = (await fetchGoalProgressViews(store, priority, new Date(to))).filter(
      (view) =>
        view.target.acceptedBy !== undefined &&
        liveAt(view.target.derivedAt, view.target.retiredAt, to),
    );
    for (const view of views) lines.push(targetLine(state, view));
    if (priority.kind === 'muscle' && views.length > 0) lines.push(rollupLine(views));
  }
  return lines;
}

/** Started at or before `at`, and not retired until after it. */
function liveAt(startedAt: string, retiredAt: string | undefined, at: string): boolean {
  return startedAt <= at && (retiredAt === undefined || retiredAt > at);
}

/** The progress read lists live targets only; a report as of an earlier date needs the retired ones too. */
function withRetiredTargets(store: ServerState['store']): ServerState['store'] {
  return Object.create(store, {
    listGoalTargets: {
      value: (selector: Parameters<ServerState['store']['listGoalTargets']>[0]) =>
        store.listGoalTargets(selector, { includeRetired: true }),
    },
  }) as ServerState['store'];
}

function targetLine(state: ServerState, view: GoalProgressView): WeeklyGoalLine {
  const { target } = view;
  const text =
    `goal: ${describeTarget(state, target)} by ${shortDate(target.endsAt)}, ` +
    `${STATUS_LABEL[view.status]}${weekClause(view.mesoWeek)}`;
  return { priorityId: view.priority.id, targetId: target.id, status: view.status, text };
}

function rollupLine(views: GoalProgressView[]): WeeklyGoalLine {
  const [rollup] = buildPriorityRollup(views);
  const text =
    `goal: ${rollup.ref}, ${rollup.progressingCount} of ${rollup.targetCount} ` +
    `primary lifts on track${weekClause(views[0].mesoWeek)}`;
  return { priorityId: rollup.priorityId, status: rollup.status, text };
}

function describeTarget(state: ServerState, target: StoredGoalTarget): string {
  const lift = state.exercises.getById(target.exerciseId ?? '')?.name ?? target.exerciseId ?? '';
  switch (target.metric) {
    case 'top_load_at_reps':
      return `${lift} ${target.committedValue}x${target.anchorReps ?? '?'}`;
    case 'reps_at_load':
      return `${lift} ${target.committedValue} reps at ${target.anchorLoad ?? '?'}`;
    case 'e1rm_trend':
      return `${lift} e1RM ${target.committedValue}`;
    case 'sessions_28d':
      return `${target.committedValue} training days per 28`;
    case 'bodyweight':
      return `bodyweight ${target.committedValue}`;
    case 'composite_strength':
      return `composite strength ${target.committedValue}`;
  }
}

function weekClause(mesoWeek: GoalMesoWeek | null): string {
  return mesoWeek === null ? '' : ` (wk ${mesoWeek.n}/${mesoWeek.of})`;
}

function shortDate(iso: string): string {
  const [, month, day] = localDate(iso).split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}
