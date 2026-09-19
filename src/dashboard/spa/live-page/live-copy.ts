/**
 * User-facing copy for the live stages, kept as pure functions.
 *
 * Separate from the `.tsx` for the same reason as `diverging-stage-model.ts`: those
 * files import `react-native`, which the node-side vitest run cannot parse, so
 * anything defined in them is untestable. Copy that formats real numbers belongs on
 * the testable side — both defects fixed here shipped to the wall precisely because
 * nothing could assert on an inline template literal.
 */

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
export function exertionMessage(velocityLossPct: number | null): string {
  if (velocityLossPct === null) return 'warming up — velocity loss needs a second rep';
  return `VL${Math.round(velocityLossPct)}% · approaching threshold — 1–2 productive reps left`;
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
  const base = basis.intent === null ? 'Default rest' : `Default rest for ${basis.intent}`;
  if (basis.source === 'intent_default') return base;
  return `${base} +${basis.extensionSeconds} s`;
}
