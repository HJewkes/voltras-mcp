// The shape of TrueCoach's `GET /clients/{id}/workouts` compound document.
//
// TrueCoach publishes no API and no schema; these field names come from three
// independent reverse-engineered OSS clients that agree on them (see
// `sources/notes/2026-09-08-truecoach-integration-research.md` §4). Nothing
// here is guaranteed by the vendor, so EVERY field is optional and every
// interface carries an index signature: an unknown extra key is kept verbatim
// and a missing known key is absent, never a throw. A rename upstream degrades
// one field, not the import.

/** One assigned workout. `due` is the calendar date the coach scheduled it for. */
export interface RawWorkout {
  readonly id?: number | string;
  readonly title?: string | null;
  readonly due?: string | null;
  readonly state?: string | null;
  readonly warmup?: string | null;
  readonly cooldown?: string | null;
  readonly [key: string]: unknown;
}

/**
 * One exercise entry within a workout. `info` is the coach's freeform
 * instruction text (`50lbs x AMRAP x 4 sets`) and is the only place a target
 * is ever written; `result` is the athlete's freeform log and is not read here.
 */
export interface RawWorkoutItem {
  readonly id?: number | string;
  readonly workout_id?: number | string;
  readonly name?: string | null;
  readonly info?: string | null;
  readonly position?: number | null;
  readonly is_circuit?: boolean | null;
  readonly [key: string]: unknown;
}

/** One page of the paginated compound document. */
export interface RawWorkoutsPage {
  readonly workouts?: RawWorkout[];
  readonly workout_items?: RawWorkoutItem[];
  readonly meta?: { readonly total_pages?: number; readonly page?: number } | null;
  readonly [key: string]: unknown;
}

/** Coerce an unknown id to the string form used in `tc:workout:<id>` keys. */
export function idString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Coerce an unknown field to trimmed non-empty text, or `undefined`. */
export function textOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Read one page's arrays defensively — a non-array (or absent) key reads as empty. */
export function pageArray<T>(page: RawWorkoutsPage, key: 'workouts' | 'workout_items'): T[] {
  const value = page[key];
  return Array.isArray(value) ? (value as T[]) : [];
}
