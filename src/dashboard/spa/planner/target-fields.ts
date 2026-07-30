/**
 * Retarget-form parsing for the plan builder (VW-121).
 *
 * The four `sets` / `lo` / `hi` / `lb` boxes are free text, so turning them into
 * a PATCH body has three jobs, and VW-120 did only the first:
 *
 *   1. blank ⇒ "leave unchanged" (it did this),
 *   2. non-numeric ⇒ an ERROR the user sees — the old `numberOrUndefined`
 *      returned `undefined` for `abc`, i.e. a typo silently became "no change",
 *   3. out-of-range ⇒ an error, via the SAME `plan-targets` bounds the server
 *      enforces, so the two checks cannot drift apart.
 *
 * Lives outside the `.tsx` because the vitest suite only globs `*.test.ts`: a
 * parser inside a component could not be covered at all.
 */
import { validateTargets, type TargetValues } from '../../plan-targets';

/** The PATCH body the builder sends. Every key optional — absent ⇒ unchanged. */
export interface TargetPatch {
  targetSets?: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
}

/** The four raw field strings, exactly as typed. */
export interface TargetFormValues {
  sets: string;
  repsLow: string;
  repsHigh: string;
  weight: string;
}

/**
 * The rep bounds already stored on the row. Needed because a rep band is a
 * CROSS-field rule: typing `hi = 4` on a row whose stored `lo` is 8 inverts the
 * band, and a check that only sees the patch cannot tell.
 */
export interface ExistingRepRange {
  targetRepsLow?: number | undefined;
  targetRepsHigh?: number | undefined;
}

export type ParseResult =
  | { ok: true; patch: TargetPatch; empty: boolean }
  | { ok: false; message: string };

const FIELD_LABELS = {
  sets: 'Sets',
  repsLow: 'Rep range low',
  repsHigh: 'Rep range high',
  weight: 'Weight (lb)',
} as const;

/** Parse one box: blank ⇒ undefined, garbage ⇒ a message, else the number. */
function parseField(
  key: keyof TargetFormValues,
  raw: string,
): { value?: number; message?: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { message: `${FIELD_LABELS[key]} must be a number.` };
  return { value: parsed };
}

/**
 * Turn the form into a validated PATCH body, or the first problem with it.
 * `empty` distinguishes "nothing to save" from a real no-op patch, so the page
 * can say so instead of firing a write that changes nothing.
 */
export function parseTargetFields(form: TargetFormValues, existing: ExistingRepRange): ParseResult {
  const patch: TargetPatch = {};
  const entries: [keyof TargetFormValues, keyof TargetPatch][] = [
    ['sets', 'targetSets'],
    ['repsLow', 'targetRepsLow'],
    ['repsHigh', 'targetRepsHigh'],
    ['weight', 'targetWeightLbs'],
  ];
  for (const [formKey, patchKey] of entries) {
    const parsed = parseField(formKey, form[formKey]);
    if (parsed.message !== undefined) return { ok: false, message: parsed.message };
    if (parsed.value !== undefined) patch[patchKey] = parsed.value;
  }

  const merged: TargetValues = { ...patch };
  if (merged.targetRepsLow === undefined && existing.targetRepsLow !== undefined) {
    merged.targetRepsLow = existing.targetRepsLow;
  }
  if (merged.targetRepsHigh === undefined && existing.targetRepsHigh !== undefined) {
    merged.targetRepsHigh = existing.targetRepsHigh;
  }
  const message = validateTargets(merged);
  if (message !== null) return { ok: false, message };

  return { ok: true, patch, empty: Object.keys(patch).length === 0 };
}
