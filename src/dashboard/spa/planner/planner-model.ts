/**
 * Pure view helpers for the plan-builder and session-completion pages (VW-120).
 *
 * Same seam as `adapter.ts` / the `*-view.ts` mappers: every derivation the two
 * pages need lives here as a plain function over the server's wire types, so the
 * `.tsx` files stay markup and the logic is unit-testable headlessly (the vitest
 * suite only globs `*.test.ts`, so a mapper that lived inside a component could
 * not be covered at all).
 */
import { estimateE1RMFromReps } from '@voltras/workout-analytics';

import type { PlanExerciseView, PlanTemplateView, PlanTreeView } from '../../read-models/plan-tree';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
  SessionSummarySet,
  SessionSummaryView,
} from '../../read-models/session-summary-view';

/** A workout template plus the block/week trail that locates it in the program. */
export interface FlatTemplate {
  template: PlanTemplateView;
  blockName: string;
  weekName: string;
}

/**
 * Flatten the program tree to the list of workouts the builder shows, in
 * block → week → template order. The builder edits ONE workout at a time, so a
 * flat list with a breadcrumb reads better than three levels of nesting; the
 * tree endpoint still returns the real structure.
 */
export function flattenTemplates(tree: PlanTreeView | null): FlatTemplate[] {
  if (tree?.program == null) return [];
  const out: FlatTemplate[] = [];
  for (const block of tree.program.blocks) {
    for (const week of block.weeks) {
      for (const template of week.templates) {
        out.push({
          template,
          blockName: block.name,
          weekName: week.name ?? `Week ${week.orderIndex + 1}`,
        });
      }
    }
  }
  return out;
}

/**
 * Keep the caller's selected workout selected across polls, falling back to the
 * one being trained right now, then to the first. Without this, every 2 s poll
 * would bounce the editor back to workout #1 mid-edit.
 */
export function resolveSelectedTemplateId(
  templates: readonly FlatTemplate[],
  selected: string | null,
  activeTemplateId: string | null,
): string | null {
  if (selected !== null && templates.some((t) => t.template.id === selected)) return selected;
  if (activeTemplateId !== null && templates.some((t) => t.template.id === activeTemplateId)) {
    return activeTemplateId;
  }
  return templates[0]?.template.id ?? null;
}

/**
 * One-line prescription for a planned exercise, e.g. `3 × 8-12 @ 135 lb`. Only
 * the parts the plan actually specifies appear — a bare "do 3 sets" prescription
 * renders `3 sets`, never an invented rep range or load.
 */
export function prescriptionLine(exercise: PlanExerciseView): string {
  const reps = repRange(exercise.targetRepsLow, exercise.targetRepsHigh);
  const head = reps === null ? `${exercise.targetSets} sets` : `${exercise.targetSets} × ${reps}`;
  const parts = [head];
  if (exercise.targetWeightLbs !== undefined) parts.push(`@ ${exercise.targetWeightLbs} lb`);
  if (exercise.targetRpe !== undefined) parts.push(`RPE ${exercise.targetRpe}`);
  if (exercise.restSec !== undefined) parts.push(`${exercise.restSec}s rest`);
  return parts.join(' · ');
}

/** `8-12`, `8`, or null when the plan prescribes no rep band. */
export function repRange(low: number | undefined, high: number | undefined): string | null {
  if (low === undefined) return null;
  if (high === undefined || high === low) return `${low}`;
  return `${low}-${high}`;
}

/** Signed lb delta as a label: `+5 lb`, `-5 lb`, or `hold`. */
export function progressionLabel(progression: SessionSummaryProgression | null): string {
  if (progression === null) return '—';
  if (progression.delta === 0) return 'hold';
  return `${progression.delta > 0 ? '+' : ''}${progression.delta} lb`;
}

/**
 * Next session's target load: the exercise's top working load plus the
 * recommended delta. Null when neither the session nor the plan recorded a load
 * to move from — a recommendation without a starting weight is not a number.
 */
export function nextTargetWeightLbs(exercise: SessionSummaryExercise): number | null {
  const base = exercise.topWeightLbs ?? exercise.progression?.targetWeightLbs ?? null;
  if (base === null || exercise.progression === null) return null;
  return base + exercise.progression.delta;
}

/**
 * `2 / 3 sets` completion readout against the plan, or just the count.
 *
 * Overshoot does NOT render as a fraction (VW-121 / F5): an extra set produced
 * literally `3 / 2 sets`, which parses as "three out of two" — a fraction above
 * 1 that means nothing to a reader. Past target it becomes `3 sets · target 2`:
 * the same two numbers, said in a way that is true.
 */
export function setsAgainstPlan(exercise: SessionSummaryExercise): string {
  const done = exercise.workingSetCount;
  if (exercise.progression === null) return `${done} working ${done === 1 ? 'set' : 'sets'}`;
  const target = exercise.progression.targetSets;
  if (done > target) return `${done} sets · target ${target}`;
  return `${done} / ${target} sets`;
}

/** One decimal place, or `'—'` for an absent measurement. Never invents a zero. */
export function formatNumber(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return unit === '' ? `${rounded}` : `${rounded} ${unit}`;
}

// ── Session-completion derivations ───────────────────────────────────────────

/**
 * One point on an exercise's within-session estimated-1RM curve, in the exact
 * shape titan's `StrengthTrendChart` consumes.
 *
 * `date` is the SET's ISO timestamp, not a calendar day: the chart's x-axis is
 * ordinal (it lays points out evenly and labels them from `sessionLabel`), so
 * feeding it a set-level timestamp draws the intra-session curve without lying
 * about the axis. `sessionLabel` carries the human label the chart actually
 * prints (`Set 3`).
 */
export interface E1RMPoint {
  date: string;
  e1rm: number;
  isPR?: boolean;
  sessionLabel?: string;
}

/**
 * The exercise's working sets as an estimated-1RM curve.
 *
 * e1RM is the honest way to put sets of DIFFERENT loads and rep counts on one
 * axis — a raw load line reads as "got weaker" whenever a back-off set follows a
 * top set, and a raw rep line ignores load entirely. It is computed by
 * `@voltras/workout-analytics`'s `estimateE1RMFromReps`, the same estimator the
 * rest of the system uses, rather than a second Epley formula transcribed here.
 *
 * Warm-ups are excluded (they are not evidence about strength) and so is any set
 * with no recorded load or no reps — an e1RM from a missing weight is a fabricated
 * number, so those sets simply have no point rather than a zero one.
 *
 * `isPR` marks the session's best point, which is what the chart's ★ means here:
 * best OF THIS SESSION. It deliberately does NOT claim an all-time PR — this page
 * only ever receives one session, so it cannot know (see `sources/design/`).
 */
export function e1rmSeries(exercise: SessionSummaryExercise): E1RMPoint[] {
  const points: E1RMPoint[] = [];
  for (const set of exercise.sets) {
    if (set.isWarmup) continue;
    if (set.weightLbs === null || set.weightLbs <= 0 || set.repCount <= 0) continue;
    points.push({
      date: set.startedAt,
      e1rm: Math.round(estimateE1RMFromReps(set.weightLbs, set.repCount).e1RM * 10) / 10,
      sessionLabel: `Set ${set.index}`,
    });
  }
  const best = points.reduce<number>((max, p) => Math.max(max, p.e1rm), 0);
  return points.map((p) => (p.e1rm === best && points.length > 1 ? { ...p, isPR: true } : p));
}

/**
 * Percentage change in estimated 1RM from the exercise's first working set to its
 * last — the one-line "how did this exercise decay" readout under the chart.
 *
 * Deliberately NOT `analyzeTrend`/`detectPlateau` from workout-analytics: those
 * fit a slope PER DAY over a multi-session window, and every point here lands
 * inside the same ~45-minute session, so the per-day slope they'd report is an
 * artefact of the tiny time denominator rather than a fact about the athlete.
 * They become the right call the moment this page can see history (see the
 * component-gap note).
 *
 * Null with fewer than two points — a single set has no direction.
 */
export function e1rmChangePct(points: readonly E1RMPoint[]): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2 || first.e1rm === 0) {
    return null;
  }
  return ((last.e1rm - first.e1rm) / first.e1rm) * 100;
}

/** Session-wide totals for the summary header. */
export interface SessionRollup {
  exerciseCount: number;
  setCount: number;
  totalReps: number;
  /** Σ per-exercise volume. Null when NO exercise recorded a load — a gap, not a 0. */
  volumeLbs: number | null;
  /** Wall-clock minutes from first set to session end, or null while in progress. */
  durationMin: number | null;
}

/** Fold the per-exercise cards into the header's session-level totals. */
export function sessionRollup(summary: SessionSummaryView): SessionRollup {
  let volume: number | null = null;
  let setCount = 0;
  let totalReps = 0;
  for (const exercise of summary.exercises) {
    setCount += exercise.setCount;
    totalReps += exercise.totalReps;
    if (exercise.volumeLbs !== null) volume = (volume ?? 0) + exercise.volumeLbs;
  }
  return {
    exerciseCount: summary.exercises.length,
    setCount,
    totalReps,
    volumeLbs: volume,
    durationMin: sessionDurationMin(summary),
  };
}

/** Whole minutes the session ran, or null while it is still open. */
function sessionDurationMin(summary: SessionSummaryView): number | null {
  const { startedAt, endedAt } = summary.session;
  if (endedAt === null) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

/** `4 × 8 @ 135 lb`-style one-liner for a completed set. */
export function setLine(set: SessionSummarySet): string {
  const load = set.weightLbs === null ? '—' : `${set.weightLbs} lb`;
  return `${set.repCount} × ${load}`;
}
