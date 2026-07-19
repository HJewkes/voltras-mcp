// Pure warm-up classification helpers.
//
// The automated warm-up ramp needs two inputs it can derive from the exercise
// fields `exercise.get` already surfaces (`muscleGroups`,
// `secondaryMuscleGroups`, `movementPattern`, `exerciseType`):
//
//   1. How much warm-up an exercise demands — `warmupDemand`, which sizes the
//      pyramid (a heavy compound needs a deeper ramp than a curl).
//   2. Which muscles an exercise works — `workedMuscles`, the set the "already
//      warm" check intersects against exercises done earlier this session.
//
// Both are pure functions over a structural view of an exercise; the
// `Exercise` type from `exercise-service.ts` satisfies `WarmupClassifiable`
// structurally, so callers pass an `exercise.get` result straight through. No
// catalog access or side effects live here — that keeps the warm-up policy
// unit-testable and decoupled from how exercises are fetched.

/** The classification fields the warm-up helpers read off an exercise. */
export interface WarmupClassifiable {
  muscleGroups: string[];
  secondaryMuscleGroups?: string[];
  movementPattern: string;
  exerciseType: 'compound' | 'isolation';
}

/** How much warm-up an exercise demands, sizing the ramp's pyramid. */
export type WarmupDemand = 'high' | 'medium' | 'low';

/**
 * Movement patterns that recruit the most tissue through the longest range —
 * a compound lift in one of these earns the deepest warm-up ramp.
 */
const HIGH_DEMAND_PATTERNS: ReadonlySet<string> = new Set(['squat', 'hinge', 'push', 'pull']);

/**
 * Classify how much warm-up an exercise needs. Isolation lifts always ramp
 * lightest; a compound lift is `high` when it moves through a big pattern
 * (squat/hinge/push/pull) and `medium` otherwise. `exerciseType` is checked
 * first so an isolation lift that happens to carry a big pattern (e.g. a
 * face pull tagged `pull`) still classifies as `low`.
 *
 * NOTE: the "heavy isolation → medium" case has no backing field — the catalog
 * carries no load/intensity signal — so every isolation lift maps to `low`
 * here. See the PR discussion for the pending definition of "heavy".
 */
export function warmupDemand(exercise: WarmupClassifiable): WarmupDemand {
  if (exercise.exerciseType === 'isolation') return 'low';
  return HIGH_DEMAND_PATTERNS.has(exercise.movementPattern) ? 'high' : 'medium';
}

/**
 * The set of muscles an exercise works: primary ∪ secondary. Deduplicated by
 * the `Set`. The warm-up "already warm" check intersects this against the
 * muscles worked by exercises done earlier in the same session.
 */
export function workedMuscles(exercise: WarmupClassifiable): Set<string> {
  return new Set([...exercise.muscleGroups, ...(exercise.secondaryMuscleGroups ?? [])]);
}
