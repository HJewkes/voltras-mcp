// Range validation for planned-exercise target fields (VW-121).
//
// ── Why this is one shared module ─────────────────────────────────────────
//
// VW-120 shipped the same "is it finite?" check twice — `numberOrUndefined()`
// in `PlanBuilderPage.tsx` and `optionalNumber()` in `plan-api.ts` — and neither
// carried a range, so `-999 lb` saved and then persisted as a real prescription.
// The client needs the check for immediate feedback and the server needs it
// because a client can't be trusted, so the RULES live here once and both sides
// import them. Two copies of a bound is how one of them drifts.
//
// Type-only-adjacent: no store, no node, no React import, so the SPA bundle can
// take it the same way it already takes `read-models/*`.
//
// Confidentiality: fitness units only — no protocol data (NF-07).

/** The numeric target fields a human can set on a planned exercise. */
export type TargetField =
  | 'targetSets'
  | 'targetRepsLow'
  | 'targetRepsHigh'
  | 'targetWeightLbs'
  | 'targetRpe'
  | 'restSec';

interface TargetRule {
  /** Human label used in error messages and as the field's accessible name. */
  label: string;
  min: number;
  max: number;
  integer: boolean;
}

/**
 * Bounds per field. Chosen to be permissive enough that no real lifter hits
 * them and tight enough that a fat-fingered or hostile value cannot become a
 * prescription: nothing here is a training recommendation, it is a sanity gate.
 */
export const TARGET_RULES: Record<TargetField, TargetRule> = {
  targetSets: { label: 'Sets', min: 1, max: 20, integer: true },
  targetRepsLow: { label: 'Rep range low', min: 1, max: 100, integer: true },
  targetRepsHigh: { label: 'Rep range high', min: 1, max: 100, integer: true },
  targetWeightLbs: { label: 'Weight (lb)', min: 0, max: 2000, integer: false },
  targetRpe: { label: 'RPE', min: 1, max: 10, integer: false },
  restSec: { label: 'Rest (s)', min: 0, max: 3600, integer: true },
};

/** A field's value after parsing, keyed by field. Absent ⇒ "leave unchanged". */
export type TargetValues = Partial<Record<TargetField, number>>;

/**
 * Check one field's parsed value against its rule. Returns a human-readable
 * message, or null when the value is acceptable.
 */
export function validateTargetField(field: TargetField, value: number): string | null {
  const rule = TARGET_RULES[field];
  if (!Number.isFinite(value)) return `${rule.label} must be a number.`;
  if (rule.integer && !Number.isInteger(value)) return `${rule.label} must be a whole number.`;
  if (value < rule.min || value > rule.max) {
    return `${rule.label} must be between ${rule.min} and ${rule.max}.`;
  }
  return null;
}

/**
 * Check a whole target set, including the cross-field rule a per-field check
 * cannot see: a rep band whose high bound sits below its low bound is not a
 * band. Callers that PATCH a single bound must pass the MERGED values (existing
 * row + patch), or `hi < lo` slips through one field at a time.
 */
export function validateTargets(values: TargetValues): string | null {
  for (const [field, value] of Object.entries(values) as [TargetField, number][]) {
    const message = validateTargetField(field, value);
    if (message !== null) return message;
  }
  const { targetRepsLow: lo, targetRepsHigh: hi } = values;
  if (lo !== undefined && hi !== undefined && hi < lo) {
    return `Rep range high (${hi}) must be at least rep range low (${lo}).`;
  }
  return null;
}
