/**
 * User-facing copy for the live stages, kept as pure functions.
 *
 * Separate from the `.tsx` for the same reason as `diverging-stage-model.ts`: those
 * files import `react-native`, which the node-side vitest run cannot parse, so
 * anything defined in them is untestable. Copy that formats real numbers belongs on
 * the testable side — both defects fixed here shipped to the wall precisely because
 * nothing could assert on an inline template literal. The wording and its source live in
 * `coach-copy/dashboard.ts`.
 */
import { LIVE_FRAGMENTS as LINES } from '../../../coach-copy/dashboard.js';
import { fillSlots } from '../../../coach-copy/fill.js';

/**
 * The exertion message shown beside the verdict.
 *
 * Two defects the old inline template carried, both visible on the wall:
 *   - it interpolated the RAW ratio, so the alert read `VL23.958333333333336`;
 *   - a null loss (fewer than 2 reps — no loss to measure yet) rendered the literal
 *     string `VLnull`.
 *
 * One definition, because the single and the diverging dual stage show the SAME
 * message — one athlete, one verdict — and two copies of a format string is how one
 * of them ends up stale.
 */
export function exertionMessage(velocityLossPct: number | null, stopPct: number): string {
  if (velocityLossPct === null) return LINES.exertionWarmingUp.text;
  // Loss only: a reps-left claim read off velocity loss is the conversion VW-302 forbids (VW-485).
  return fillSlots(LINES.exertionReading.text, {
    lossPct: String(Math.round(velocityLossPct)),
    stopPct: String(Math.round(stopPct)),
  });
}

/**
 * The caption that marks a derived rest (VW-441), so a goal default never reads as the
 * coach's number. Null for a coach-set rest, which needs no marking.
 */
export function restBasisCaption(basis: {
  source: 'explicit_plan' | 'intent_default' | 'intent_default_extended';
  intent: string | null;
  extensionSeconds: number;
}): string | null {
  if (basis.source === 'explicit_plan') return null;
  const base =
    basis.intent === null
      ? LINES.restDefault.text
      : fillSlots(LINES.restDefaultForIntent.text, { intent: basis.intent });
  if (basis.source === 'intent_default') return base;
  return fillSlots(LINES.restExtended.text, {
    base,
    extensionSeconds: String(basis.extensionSeconds),
  });
}

/**
 * Which source set an auto-armed set's stop (VW-720): `Plan · strength · stop 20%` or
 * `Default · stop 30% (assumed)`. Null when the server applied nothing, or an agent's own
 * watch replaced it, or the watch carries no loss threshold to name.
 */
export function armSourceLabel(set: {
  armDefaultsSource?: 'plan_row' | 'default';
  watch?: { notifyOn?: Array<{ type: string; pct?: number; intent?: string }> };
}): string | null {
  const stop = set.watch?.notifyOn?.find((trigger) => trigger.type === 'velocity_loss_exceeded');
  if (set.armDefaultsSource === undefined || stop?.pct === undefined) return null;
  const stopPct = String(Math.round(stop.pct));
  if (set.armDefaultsSource === 'default')
    return fillSlots(LINES.armSourceDefault.text, { stopPct });
  if (stop.intent === undefined) return fillSlots(LINES.armSourcePlan.text, { stopPct });
  return fillSlots(LINES.armSourcePlanIntent.text, { intent: stop.intent, stopPct });
}

/** The basis `derivePrescription` gives a coach-written RPE. */
const PLAN_EFFORT_BASIS = 'plan';

/** The caption with its basis appended, for the accessible label (the tooltip needs hover). */
export function effortAccessibleLabel(caption: string, basis: string): string {
  return fillSlots(LINES.effortAccessibleLabel.text, { caption, basis });
}

/**
 * The effort target caption under the prescription lockup (VW-670), labelled as a target so
 * it never reads as a reading (VW-485). A tier nobody declared is marked assumed. Null hides it.
 */
export function effortCaption(
  effort: { text: string; basis: string; assumed: boolean } | null,
): string | null {
  if (effort === null) return null;
  if (effort.basis === PLAN_EFFORT_BASIS) {
    return fillSlots(LINES.effortPlanTarget.text, { text: effort.text });
  }
  if (effort.assumed) return fillSlots(LINES.effortAssumedTier.text, { text: effort.text });
  return effort.text;
}
