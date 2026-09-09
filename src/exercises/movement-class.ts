// Movement-class lookup for the exercise catalog (VMCP-02.63).
//
// The catalog already tags every entry with a `movementPattern`
// (`push` / `pull` / `isolation` / `squat` / `hinge` / `rotation`). This module
// narrows that free-form string to a closed union and adds the one value the
// catalog cannot supply: `unknown`, for a set whose exercise was never
// identified or whose id is not in the catalog.
//
// Why it exists as its own module rather than a method on `ExerciseService`:
// the consumers are the live event bridge and the progression heuristic, both
// of which want a value they can stamp and compare without holding a service
// reference. `ExerciseService` is documented stateless, so the module-level
// instance here is a lookup table, not shared mutable state.

import { ExerciseService } from './exercise-service.js';

/**
 * The catalog's movement patterns plus `unknown`. `unknown` is not a catalog
 * value — it is what a set carries when its exercise is unidentified, and it
 * deliberately behaves as "no class-specific handling" everywhere.
 */
export type MovementClass =
  | 'push'
  | 'pull'
  | 'isolation'
  | 'squat'
  | 'hinge'
  | 'rotation'
  | 'unknown';

const CATALOG_PATTERNS = new Set<string>([
  'push',
  'pull',
  'isolation',
  'squat',
  'hinge',
  'rotation',
]);

/** The one field the classifier reads, so callers can pass any catalog-shaped row. */
export interface MovementClassifiable {
  movementPattern: string;
}

const lookup = new ExerciseService();

/**
 * Narrow a catalog row's `movementPattern` to a {@link MovementClass}. An
 * absent row, or a pattern the catalog has grown since this union was written,
 * both read as `unknown` — a value nothing gates on.
 */
export function movementClassOf(exercise: MovementClassifiable | undefined): MovementClass {
  if (exercise === undefined) return 'unknown';
  return CATALOG_PATTERNS.has(exercise.movementPattern)
    ? (exercise.movementPattern as MovementClass)
    : 'unknown';
}

/**
 * Resolve the movement class of a catalog id. Returns `unknown` for an absent
 * id and for an id the catalog does not carry, so an unidentified set is
 * always treated exactly as it was before this ticket.
 */
export function movementClassForExerciseId(exerciseId: string | undefined): MovementClass {
  if (exerciseId === undefined) return 'unknown';
  return movementClassOf(lookup.getById(exerciseId));
}

/**
 * Whether velocity-loss fatigue inference is valid for this class.
 *
 * VMCP-02.63: on a ballistic pull (cable row) peak concentric velocity does not
 * decay with fatigue — the 2026-07-05 capture held 1.8-2.4 m/s across 50/80/115
 * lb with the HIGHEST peak on the last rep — because the concentric is explosive
 * and momentum-assisted. The same lifter's chest press decayed textbook-style.
 * So the signal is invalid for pulls, not merely noisy, and the watch and the
 * progression hold both read it.
 *
 * `unknown` keeps the signal: a set we cannot classify must behave as it did
 * before the gate existed.
 */
export function velocityLossIsValidFor(movementClass: MovementClass): boolean {
  return movementClass !== 'pull';
}
