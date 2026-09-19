// Which programmed-ramp class a catalog exercise belongs to (VW-482).
//
// Read from the two fields every catalog row already carries: `exerciseType`
// decides isolation versus compound, and a compound's `movementPattern` decides
// the body half. A squat or hinge ramps as a lower-body compound; a push, pull
// or rotation as an upper-body one. An exercise the catalog cannot place gets
// the band's own default class rather than a guess.

import { GOAL_BAND_CONSTANTS, type RampClass } from '../analytics/goal-band.js';
import { ExerciseService, type Exercise } from './exercise-service.js';

const LOWER_BODY_PATTERNS: ReadonlySet<string> = new Set(['squat', 'hinge']);

const lookup = new ExerciseService();

/** The one pair of fields the classifier reads, so callers can pass any catalog-shaped row. */
export type RampClassifiable = Pick<Exercise, 'exerciseType' | 'movementPattern'>;

export function rampClassOf(exercise: RampClassifiable | undefined): RampClass {
  if (exercise === undefined) return GOAL_BAND_CONSTANTS.rampClassWhenUnknown;
  if (exercise.exerciseType === 'isolation') return 'isolation';
  return LOWER_BODY_PATTERNS.has(exercise.movementPattern) ? 'lower_compound' : 'upper_compound';
}

/** An absent id, or one the catalog does not carry, reads as the unknown-class default. */
export function rampClassForExerciseId(exerciseId: string | null | undefined): RampClass {
  if (exerciseId === null || exerciseId === undefined) {
    return GOAL_BAND_CONSTANTS.rampClassWhenUnknown;
  }
  return rampClassOf(lookup.getById(exerciseId));
}
