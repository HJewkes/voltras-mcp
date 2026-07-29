// Set-level exercise scoping (VMCP-01.72a).
//
// A session's `exerciseId` is write-once at `session.start`, so today every
// session holds exactly one exercise and "the sets of session S" and "the sets
// of exercise E in session S" happen to be the same list. Every read path that
// filtered SESSIONS by exercise and then consumed `getSetsForSession()`
// unfiltered was relying on that coincidence. The moment a session can hold two
// exercises those reads go silently wrong — a squat set registering as a bench
// PR, a bench delta computed from the squat load.
//
// This module is the one place that narrows a session's sets down to a single
// exercise, reading each set's OWN `exerciseId` rather than its session's.

/** The only field scoping reads. Structural, so both `StoredSet` and the
 *  dashboard's `HistorySet`-shaped rows pass without a conversion. */
export interface ExerciseScopedSet {
  exerciseId?: string | undefined;
}

/**
 * Keep the sets belonging to one exercise, as decided by `belongs` against each
 * set's own `exerciseId`.
 *
 * A set that recorded NO exercise of its own is KEPT. Such a set is
 * unattributed, not attributed elsewhere: pre-v7 rows inherited a NULL from a
 * session that never named an exercise, and the live path leaves the field
 * absent when a set closes after its session was torn down. The session it was
 * recorded in remains the only signal there is about it, and dropping it here
 * would blank out the entire history of the older name-only sessions — a
 * behaviour change, where this migration is meant to be none.
 *
 * `belongs` takes the id rather than an equality argument so callers matching
 * on more than a catalog id (the dashboard also matches a free-text exercise
 * label) share this policy instead of re-deriving it.
 */
export function scopeSetsToExercise<T extends ExerciseScopedSet>(
  sets: readonly T[],
  belongs: (exerciseId: string) => boolean,
): T[] {
  return sets.filter((set) => set.exerciseId === undefined || belongs(set.exerciseId));
}

/** `scopeSetsToExercise` for the common case: an exact catalog-id match. An
 *  `undefined` target means the caller has no exercise to scope to, and the
 *  sets pass through untouched. */
export function scopeSetsToExerciseId<T extends ExerciseScopedSet>(
  sets: readonly T[],
  exerciseId: string | undefined,
): T[] {
  if (exerciseId === undefined) return [...sets];
  return scopeSetsToExercise(sets, (id) => id === exerciseId);
}
