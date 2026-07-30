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

// --- VMCP-01.72b: session-aware scoping -----------------------------------
//
// `session.set_exercise` lets one session hold more than one exercise. The
// "keep an unattributed set" leniency above is safe only while a session is
// (as far as its own sets show) single-exercise: an unattributed set that
// passes `belongs` for every exercise a MULTI-exercise session held would
// double-count that set's volume/reps/PR candidacy once per exercise.
//
// The functions below take the session's FULL set list (unfiltered by
// exercise) so they can decide, from the sets themselves, whether the
// leniency still applies — no schema change, no write-time bookkeeping.

/**
 * True when every set in `sets` that HAS an `exerciseId` agrees on it — i.e.
 * the session is, as far as its own sets show, single-exercise. A session
 * with zero attributed sets (all-unattributed, e.g. pre-v7 rows) counts as
 * single-exercise: there is nothing to disagree with, and treating it as
 * multi would blank out exactly the legacy history the leniency exists to
 * protect.
 */
function isSingleExerciseSession(sets: readonly ExerciseScopedSet[]): boolean {
  let seen: string | undefined;
  for (const set of sets) {
    if (set.exerciseId === undefined) continue;
    if (seen === undefined) {
      seen = set.exerciseId;
      continue;
    }
    if (set.exerciseId !== seen) return false;
  }
  return true;
}

/**
 * `scopeSetsToExercise`, but the "keep an unattributed set" leniency is
 * withdrawn once the session is known (from its OWN sets) to hold more than
 * one exercise. Single-exercise sessions — every historical session, and any
 * session that has never called `session.set_exercise` — behave identically
 * to `scopeSetsToExercise`, which is the byte-identical parity guarantee the
 * regression suite checks against existing data.
 *
 * `allSessionSets` MUST be the session's full, unfiltered set list (not
 * already narrowed to one exercise) — the single-vs-multi judgement needs to
 * see every set to be correct.
 */
export function scopeSessionSetsToExercise<T extends ExerciseScopedSet>(
  allSessionSets: readonly T[],
  belongs: (exerciseId: string) => boolean,
): T[] {
  if (isSingleExerciseSession(allSessionSets)) {
    return scopeSetsToExercise(allSessionSets, belongs);
  }
  // Multi-exercise session: an unattributed set can no longer be safely
  // attributed to every exercise queried against this session. Drop it from
  // every exercise-scoped read rather than guess which one it belongs to.
  return allSessionSets.filter((set) => set.exerciseId !== undefined && belongs(set.exerciseId));
}

/** `scopeSessionSetsToExercise` for the common exact-id-match case. Same
 *  full-set-list requirement as `scopeSessionSetsToExercise`. */
export function scopeSessionSetsToExerciseId<T extends ExerciseScopedSet>(
  allSessionSets: readonly T[],
  exerciseId: string | undefined,
): T[] {
  if (exerciseId === undefined) return [...allSessionSets];
  return scopeSessionSetsToExercise(allSessionSets, (id) => id === exerciseId);
}
