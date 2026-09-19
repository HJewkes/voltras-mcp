/**
 * Pure projections from `/api/goals` + `/api/goal-progress` onto what
 * `GoalsPage` renders (VW-355, plan G8'). No I/O, no clock — everything here
 * is a function of the two fetched payloads, so it is unit-testable without a
 * server and the render test can hand it fixtures directly.
 */
import type {
  GoalCardChart,
  GoalCardMilestone,
  GoalCardTrend,
  GoalLiftActual,
  GoalMilestoneTarget,
  GoalMuscleLift,
  GoalNextTarget,
  GoalWeekEntry,
} from '@titan-design/react-ui';
// The muscle taxonomy's VALUE export lives on this subpath, not on the root
// barrel: the root `.d.ts` re-declares `MuscleGroup` but `dist/index.mjs` never
// emits it, so a root import typechecks and is `undefined` at runtime.
import { MuscleGroup } from '@titan-design/react-ui/bodymap';

import type { GoalProgressView, PriorityRollupView } from '../../read-models/index.js';
import type { GoalMesoTarget } from '../../read-models/goal-milestone.js';
import type { GoalPriorityRow } from '../../goal-progress-api.js';
import type { StoredPriority } from '../../../store/types.js';
import { mapCatalogMuscle } from '../../../exercises/muscle-map.js';
import { calibrationCopy } from './calibration-copy.js';

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
  const rows = trackedLiftRows(data);
  const specialized = rows.find((row) => row.priority.level === 'specialize');
  return specialized ?? rows[0] ?? null;
}

/**
 * The per-lift grid's rows: every tracked lift except the lead, which already has the
 * large card at the top of the page (owner ruling, VW-467: "Drop it from per-lift everywhere").
 */
export function liftRows(data: GoalsPageData): GoalTargetRow[] {
  const leadId = primaryTarget(data)?.view.target.id;
  return trackedLiftRows(data).filter((row) => row.view.target.id !== leadId);
}

/** One row per exercise-tracked target (`top_load_at_reps`) with a set to print. */
function trackedLiftRows(data: GoalsPageData): GoalTargetRow[] {
  return allViews(data).filter(
    (row) =>
      row.view.target.metric === 'top_load_at_reps' && 'reps' in row.view.mesoMilestone.target,
  );
}

/** One row per `muscle`-kind priority, from its already-computed rollup. */
export function muscleRollupRows(data: GoalsPageData): GoalPriorityRow[] {
  return data.priorities.filter((row) => row.priority.kind === 'muscle');
}

/** The readings `GoalLiftCard` can plot. One outside the meso has no week to sit on. */
export function cardActuals(view: GoalProgressView): GoalLiftActual[] {
  return view.actuals.flatMap((actual) =>
    actual.weekIndex === undefined ? [] : [{ weekIndex: actual.weekIndex, value: actual.value }],
  );
}

/**
 * The block-end milestone the card's summary leads with, from the read model's
 * own verdict and week cells (VW-400). The summary is told the state, so it
 * never re-derives a verdict the read model already ruled on.
 */
export function cardMilestone(view: GoalProgressView): GoalCardMilestone {
  const meso = view.mesoMilestone;
  return {
    target: milestoneTarget(meso.target),
    weekCount: meso.weekCount,
    currentWeek: meso.currentWeek,
    state: meso.state,
    status: view.status,
    weeks: weekEntries(view),
    ...(meso.latest === undefined ? {} : { latest: meso.latest }),
    ...(meso.direction === 'hold' ? {} : { direction: meso.direction }),
  };
}

/**
 * Only a load-shaped target reaches here: `liftRows` drops a lift target whose
 * anchor was never recorded, and goal derivation refuses to store one.
 */
function milestoneTarget(target: GoalMesoTarget): GoalMilestoneTarget {
  if ('reps' in target) return target;
  throw new Error(`goal target ${target.metric} has no set to print on a lift card`);
}

function weekEntries(view: GoalProgressView): GoalWeekEntry[] {
  return view.weekOutcomes.map(({ outcome, reading }) =>
    reading === undefined ? { outcome } : { outcome, reading },
  );
}

/** The next week's waypoint as the chart's hollow marker; its label becomes the marker's tip. */
export function nextTarget(view: GoalProgressView): GoalNextTarget {
  const { dueWeek, value, label } = view.nextMilestone;
  return { weekIndex: dueWeek, value, label };
}

/** The full card's trajectory chart, everything but the box the card measures itself. */
export function cardChart(view: GoalProgressView): GoalCardChart {
  return {
    expected: view.expected,
    committed: view.committed,
    stretch: view.stretch,
    actuals: view.actuals.map((a) => ({
      ts: dateOnly(a.ts),
      ...(a.weekIndex === undefined ? {} : { weekIndex: a.weekIndex }),
      value: a.value,
      isPR: a.isPR,
      matched: a.matched,
    })),
    weeks: chartWeeks(view),
    // titan has no hold direction yet, so a hold keeps the chart's default, as the milestone does.
    ...(view.direction === 'hold' ? {} : { direction: view.direction }),
    nextTarget: nextTarget(view),
    // Only a calibrating lift carries `calibration`; the chart's note then says what it waits on.
    ...(view.calibration === undefined
      ? {}
      : { calibratingNote: calibrationCopy(view.calibration).chartNote }),
  };
}

/** The compact card's week-column chart, running to the block's last week. */
export function cardTrend(view: GoalProgressView): GoalCardTrend {
  return {
    committed: view.committed,
    stretch: view.stretch,
    actuals: cardActuals(view),
    goalWeek: view.mesoMilestone.goalWeek,
    unit: view.nextMilestone.unit,
    nextTarget: nextTarget(view),
  };
}

/** Whether any reading in this target set a personal record — the card's star. */
export function hasPR(view: GoalProgressView): boolean {
  return view.actuals.some((actual) => actual.isPR);
}

/** One `GoalMuscleCard`'s props, assembled from a muscle priority and its lift targets. */
export interface GoalMuscleCardRow {
  priority: StoredPriority;
  rollup: PriorityRollupView;
  muscle: MuscleGroup;
  side: 'front' | 'back';
  commonGoalWeek: number;
  lifts: GoalMuscleLift[];
}

/**
 * One card per `muscle`-kind priority that has a rollup, a taxonomy slug and at
 * least one contributing lift. A priority missing any of the three has nothing
 * the card is about: the figure needs a slug and the rows need lifts.
 */
export function muscleCardRows(data: GoalsPageData): GoalMuscleCardRow[] {
  return muscleRollupRows(data).flatMap((row) => {
    const muscle = muscleGroupOf(row.priority.ref);
    const lifts = liftsUnder(data, row.priority);
    const first = lifts[0];
    if (row.rollup === null || muscle === null || first === undefined) return [];
    return [
      {
        priority: row.priority,
        rollup: row.rollup,
        muscle,
        side: MUSCLE_SIDE[muscle],
        commonGoalWeek: commonGoalWeek(lifts, first.goalWeek),
        lifts,
      },
    ];
  });
}

function liftsUnder(data: GoalsPageData, priority: StoredPriority): GoalMuscleLift[] {
  return (data.progress[priority.id] ?? [])
    .filter((view) => view.target.metric === 'top_load_at_reps')
    .map((view) => ({
      name: targetLabel({ priority, view }),
      status: view.status,
      reps: view.nextMilestone.reps,
      load: view.nextMilestone.load,
      unit: view.nextMilestone.unit,
      goalWeek: view.nextMilestone.goalWeek,
    }));
}

/**
 * The week most of this muscle's lifts are due, which is the one the card
 * suppresses per row. Ties go to the earliest week, so the row that prints its
 * own week is the later outlier rather than an arbitrary half of the list.
 */
function commonGoalWeek(lifts: readonly GoalMuscleLift[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const lift of lifts) counts.set(lift.goalWeek, (counts.get(lift.goalWeek) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return ranked[0]?.[0] ?? fallback;
}

/**
 * The taxonomy group a priority's `ref` names. `ref` is a CATALOG muscle string
 * (`back`, `shoulders`), not a taxonomy slug, so it goes through the same map
 * every per-muscle rollup uses; a composite takes its first slug, which is the
 * one the figure lights.
 */
function muscleGroupOf(ref: string): MuscleGroup | null {
  const slug = mapCatalogMuscle(ref)[0];
  return slug === undefined ? null : (MUSCLE_BY_SLUG.get(slug) ?? null);
}

const MUSCLE_BY_SLUG = new Map<string, MuscleGroup>(
  Object.values(MuscleGroup).map((group) => [group, group]),
);

/**
 * Which face of the figure shows each muscle. `MuscleGlyph` draws one side at a
 * time and a muscle lit on the other face renders nothing, so each row follows
 * the drawing that carries the slug `MUSCLE_TO_SVG_SLUGS` maps it to. The
 * muscles both drawings carry (`triceps`, `forearm`, `calves`) take the face
 * they are named for.
 */
const MUSCLE_SIDE: Record<MuscleGroup, 'front' | 'back'> = {
  [MuscleGroup.CHEST]: 'front',
  [MuscleGroup.FRONT_DELTS]: 'front',
  [MuscleGroup.SIDE_DELTS]: 'front',
  [MuscleGroup.REAR_DELTS]: 'back',
  [MuscleGroup.TRICEPS]: 'back',
  [MuscleGroup.LATS]: 'back',
  [MuscleGroup.UPPER_BACK]: 'back',
  [MuscleGroup.BICEPS]: 'front',
  [MuscleGroup.FOREARMS]: 'front',
  [MuscleGroup.QUADS]: 'front',
  [MuscleGroup.HAMSTRINGS]: 'back',
  [MuscleGroup.GLUTES]: 'back',
  [MuscleGroup.CALVES]: 'back',
  [MuscleGroup.ABS]: 'front',
  [MuscleGroup.OBLIQUES]: 'front',
};

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
