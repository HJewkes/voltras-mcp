/**
 * Default target-tempo lookup for the dashboard prescription path (VW-41).
 *
 * A planned set may carry no coach-set tempo, yet the live page can still show a
 * sensible *target* to pace against. This module supplies that default as pure,
 * static fitness data — a per-movement-pattern table with a short per-exercise
 * override map — plus the resolver that collapses coach-override / exercise-default
 * / none into the single tuple the dashboard renders.
 *
 * ── Canonical order ──────────────────────────────────────────────────────────
 * EVERY tuple here is `[eccentric, pauseBottom, concentric, pauseTop]` in seconds,
 * matching `@voltras/workout-analytics`' `getSetTempoSeconds`
 * (`workout-analytics/src/analytics/view-model.ts:83`) which titan `TempoDisplay`
 * consumes. This is the ONE true order at this boundary — do NOT use WA's
 * `formatTempo`/`TempoParts` string order, which differs.
 *
 * This is plan metadata / fitness knowledge, NOT protocol data — no protocol bytes
 * appear here — so it is publishable, matching the muscle-group precedent (NF-07).
 */

/** Prescribed tempo, seconds: `[eccentric, pauseBottom, concentric, pauseTop]`. */
export type TempoTuple = [number, number, number, number];

/**
 * Default tempo by movement pattern (the coarse, always-available fallback).
 *
 * Grounded in hypertrophy/strength practice: controlled eccentric, deliberate
 * concentric, a brief bottom pause to kill momentum where the stretch is
 * momentum-sensitive, minimal top pause. `carry` is intentionally absent — a loaded
 * carry has no rep tempo, so it resolves to none and the UI hides the readout.
 */
export const byPattern: Readonly<Record<string, TempoTuple>> = {
  push: [3, 0, 1, 0],
  pull: [2, 0, 1, 1],
  squat: [3, 1, 1, 0],
  hinge: [2, 1, 1, 1],
  lunge: [3, 0, 1, 0],
  isolation: [2, 0, 2, 1],
  rotation: [2, 0, 2, 0],
};

/**
 * Per-exercise overrides, applied where the pattern default misleads. Keyed on the
 * cable exercise ids the plan store uses. Anything absent falls back to `byPattern`.
 */
export const byExercise: Readonly<Record<string, TempoTuple>> = {
  cable_fly: [3, 1, 1, 1],
  cable_crossover: [3, 1, 1, 1],
  cable_lateral_raise: [3, 0, 1, 1],
  cable_crunch: [2, 0, 2, 1],
  cable_hip_thrust: [2, 1, 1, 2],
};

/**
 * Resolve the exercise's DEFAULT tempo (no coach input): the per-exercise override
 * when one exists, else the movement-pattern default when a pattern is known, else
 * `null` (unknown exercise / no pattern / a `carry` → the UI hides the tempo).
 */
export function resolveExerciseDefaultTempo(
  exerciseId: string,
  movementPattern?: string,
): TempoTuple | null {
  const override = byExercise[exerciseId];
  if (override !== undefined) return override;
  if (movementPattern !== undefined) {
    const patternDefault = byPattern[movementPattern];
    if (patternDefault !== undefined) return patternDefault;
  }
  return null;
}

/**
 * Resolve the TARGET tempo for a planned set, in priority order:
 *   1. coach-set tempo on the planned set (`plannedTempo`), when present;
 *   2. the exercise default (override → pattern);
 *   3. `null` — no target; the UI hides the tempo readout entirely.
 *
 * Pure; no I/O. `plannedTempo` is the branch-1 seam for the coach-override feature
 * (VW-41.1) — no coach data source exists yet, so callers pass `undefined` today.
 */
export function resolveTargetTempo(
  exerciseId: string,
  plannedTempo?: TempoTuple,
  movementPattern?: string,
): TempoTuple | null {
  if (plannedTempo !== undefined) return plannedTempo;
  return resolveExerciseDefaultTempo(exerciseId, movementPattern);
}
