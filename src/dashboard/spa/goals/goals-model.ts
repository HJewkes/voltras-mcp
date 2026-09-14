/**
 * Pure projections from `/api/goals` + `/api/goal-progress` onto what
 * `GoalsPage` renders (VW-355, plan G8'). No I/O, no clock — everything here
 * is a function of the two fetched payloads, so it is unit-testable without a
 * server and the render test can hand it fixtures directly.
 */
import type { GoalTrajectoryStatus, GoalDirection } from '@titan-design/react-ui';

import type { GoalProgressView } from '../../read-models/index.js';
import type { GoalPriorityRow } from '../../goal-progress-api.js';
import type { StoredPriority } from '../../../store/types.js';

/** The two fetched payloads this page renders from. */
export interface GoalsPageData {
  priorities: GoalPriorityRow[];
  /** `/api/goal-progress?priorityId=` results, keyed by `priorityId`. */
  progress: Record<string, GoalProgressView[]>;
}

export interface GoalTargetRow {
  priority: StoredPriority;
  view: GoalProgressView;
}

/** Every target view across every priority, flattened, in declaration order. */
function allViews(data: GoalsPageData): GoalTargetRow[] {
  const rows: GoalTargetRow[] = [];
  for (const row of data.priorities) {
    for (const view of data.progress[row.priority.id] ?? []) {
      rows.push({ priority: row.priority, view });
    }
  }
  return rows;
}

/**
 * The lift the header + chart lead with: the first `specialize` lift priority's
 * `top_load_at_reps` target, falling back to any lift-tracked target at all. A
 * muscle priority's own lifts qualify too — the chart cares which METRIC a
 * target tracks, not which kind of priority asked for it.
 */
export function primaryTarget(data: GoalsPageData): GoalTargetRow | null {
  const rows = liftRows(data);
  const specialized = rows.find((row) => row.priority.level === 'specialize');
  return specialized ?? rows[0] ?? null;
}

/** One row per exercise-tracked target (`top_load_at_reps`), for the per-lift table. */
export function liftRows(data: GoalsPageData): GoalTargetRow[] {
  return allViews(data).filter((row) => row.view.target.metric === 'top_load_at_reps');
}

/** One row per `muscle`-kind priority, from its already-computed rollup. */
export function muscleRollupRows(data: GoalsPageData): GoalPriorityRow[] {
  return data.priorities.filter((row) => row.priority.kind === 'muscle');
}

/** The `sessions_28d` commitment view, if one has been accepted. */
export function sessionsTarget(data: GoalsPageData): GoalTargetRow | null {
  return allViews(data).find((row) => row.view.target.metric === 'sessions_28d') ?? null;
}

/**
 * The bodyweight target view, or `null`. Absent whenever no `bodyweight`
 * target has been accepted OR it carries no readings yet — VW-327 (the
 * bodyweight writer) hasn't landed, so a target with the metric selected but
 * nothing logged is exactly the state the tile must render nothing for
 * (plan G8' done_when).
 */
export function bodyweightTarget(data: GoalsPageData): GoalTargetRow | null {
  const row = allViews(data).find((r) => r.view.target.metric === 'bodyweight') ?? null;
  return row !== null && row.view.actuals.length > 0 ? row : null;
}

/**
 * Which way "better" points, from the target's own two fixed numbers. A loss
 * goal's committed edge is numerically ABOVE its stretch edge (the same
 * convention `GoalTrajectoryChart`'s geometry documents), so equality reads
 * as `up` — there is no loss goal with a zero-width band in practice.
 */
export function directionOf(view: GoalProgressView): GoalDirection {
  return view.committed <= view.stretch ? 'up' : 'down';
}

/**
 * The chart's week list, derived from the band's own week indices. Only the
 * CURRENT week's deload flag is known to this page (`GoalProgressView.mesoWeek`
 * carries just the one the reading falls in) — every other week defaults to
 * non-deload, which only under-shades a deload week elsewhere in the meso
 * rather than mis-shading one that never happened.
 */
export function chartWeeks(view: GoalProgressView): { index: number; isDeload: boolean }[] {
  const meso = view.mesoWeek;
  return view.expected.map((point) => ({
    index: point.weekIndex,
    isDeload: meso !== null && meso.n === point.weekIndex && meso.isDeload,
  }));
}

/** `GoalActualView.ts` (an ISO instant) trimmed to the `YYYY-MM-DD` the chart's date parser wants. */
export function dateOnly(ts: string): string {
  return ts.slice(0, 10);
}

/** The chart's own status vocabulary is the read model's, unchanged — named for the import site. */
export type { GoalTrajectoryStatus };

export function statusLabel(status: GoalProgressView['status']): string {
  switch (status) {
    case 'on_track':
      return 'On track';
    case 'ahead':
      return 'Ahead';
    case 'behind':
      return 'Behind';
    case 'tolerated':
      return 'Tolerated';
    case 'deload_week':
      return 'Deload week';
    case 'calibrating':
      return 'Calibrating';
    case 'stalled':
      return 'Stalled';
  }
}

/** Badge tone per status. `ahead` is brand/info, never warning-amber (plan §2e / REJECTED.md). */
export function statusBadgeVariant(
  status: GoalProgressView['status'],
): 'success' | 'warning' | 'error' | 'info' {
  switch (status) {
    case 'on_track':
      return 'success';
    case 'ahead':
      return 'info';
    case 'tolerated':
    case 'calibrating':
    case 'deload_week':
      return 'info';
    case 'behind':
    case 'stalled':
      return 'warning';
  }
}

export function mesoSubtitle(view: GoalProgressView): string {
  if (view.mesoWeek === null) return 'Calibrating';
  return `Week ${view.mesoWeek.n} of ${view.mesoWeek.of}`;
}

export function priorityLabel(priority: StoredPriority): string {
  return slugToLabel(priority.ref);
}

/**
 * The row label for a per-lift table entry. A `lift` priority's own `ref` IS
 * the exercise id, but a `muscle` priority's isn't — its lifts share one ref
 * ("biceps"), so the table would show every row of that muscle identically.
 * The target's own `exerciseId` disambiguates; it is only absent for the
 * non-exercise metrics (`sessions_28d`, `bodyweight`) that never reach this
 * table (`liftRows` already filters to `top_load_at_reps`).
 */
export function targetLabel(row: GoalTargetRow): string {
  return row.view.target.exerciseId === undefined
    ? priorityLabel(row.priority)
    : slugToLabel(row.view.target.exerciseId);
}

function slugToLabel(slug: string): string {
  return slug.replace(/-/g, ' ').toUpperCase();
}
