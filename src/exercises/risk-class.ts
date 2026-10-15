// Which set-risk class a catalog exercise belongs to (VW-611, VW-152 section 3.2).
//
// `exerciseType` decides isolation versus compound. A squat or hinge compound loads
// the spine or legs and reads as loaded; a push, pull or rotation compound reads as
// supported unless the curated table below names it. Unlike the ramp class, an
// exercise the catalog cannot place reads as null: the scorer treats a missing class
// as missing signal, and a guessed default would read as a real answer.

import type { ExerciseRiskClass } from '../analytics/set-risk.js';
import { ExerciseService, type Exercise } from './exercise-service.js';

type PromotionReason = 'overhead' | 'single_leg' | 'free_bar';

const LOADED_PATTERNS: ReadonlySet<string> = new Set(['squat', 'hinge']);
const SUPPORTED_PATTERNS: ReadonlySet<string> = new Set(['push', 'pull', 'rotation']);

// Placeholder promotions; VW-616 replaces them with owner-accepted values.
const LOADED_COMPOUND_PROMOTIONS: Readonly<Record<string, PromotionReason>> = {
  'cable-shoulder-press': 'overhead',
  'barbell-overhead-press': 'overhead',
  'dumbbell-shoulder-press': 'overhead',
  'machine-overhead-press': 'overhead',
  'barbell-bench-press': 'free_bar',
  'barbell-close-grip-bench-press': 'free_bar',
  'barbell-pin-bench-press': 'free_bar',
  'barbell-row': 'free_bar',
};

const lookup = new ExerciseService();

type RiskClassifiable = Pick<Exercise, 'id' | 'exerciseType' | 'movementPattern'>;

function classOfEntry(exercise: RiskClassifiable): ExerciseRiskClass | null {
  if (exercise.exerciseType === 'isolation') return 'isolation';
  if (exercise.exerciseType !== 'compound') return null;
  if (Object.hasOwn(LOADED_COMPOUND_PROMOTIONS, exercise.id)) return 'loaded_compound';
  if (LOADED_PATTERNS.has(exercise.movementPattern)) return 'loaded_compound';
  return SUPPORTED_PATTERNS.has(exercise.movementPattern) ? 'supported_compound' : null;
}

/** An absent id, one the catalog does not carry, or an unplaceable row all read as null. */
export function riskClassOf(exerciseId: string | null | undefined): ExerciseRiskClass | null {
  if (exerciseId === null || exerciseId === undefined) return null;
  const exercise = lookup.getById(exerciseId);
  return exercise === undefined ? null : classOfEntry(exercise);
}
