/**
 * Pure view helpers for the plan-builder and session-completion pages (VW-120).
 *
 * Same seam as `adapter.ts` / the `*-view.ts` mappers: every derivation the two
 * pages need lives here as a plain function over the server's wire types, so the
 * `.tsx` files stay markup and the logic is unit-testable headlessly (the vitest
 * suite only globs `*.test.ts`, so a mapper that lived inside a component could
 * not be covered at all).
 */
import type { PlanExerciseView, PlanTemplateView, PlanTreeView } from '../../read-models/plan-tree';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
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

/** `2 of 3 sets` style completion readout against the plan, or just the count. */
export function setsAgainstPlan(exercise: SessionSummaryExercise): string {
  const done = exercise.workingSetCount;
  if (exercise.progression === null) return `${done} working ${done === 1 ? 'set' : 'sets'}`;
  return `${done} / ${exercise.progression.targetSets} sets`;
}

/** One decimal place, or `'—'` for an absent measurement. Never invents a zero. */
export function formatNumber(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return unit === '' ? `${rounded}` : `${rounded} ${unit}`;
}
