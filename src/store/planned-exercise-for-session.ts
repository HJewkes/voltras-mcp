// The planned exercise a session is training for one exercise, shared by
// `timer.start`, `set.end`'s load-drift check and the dashboard snapshot.

import type { StoredPlannedExercise, StoredProgramAssignment } from './types.js';

/** The three store reads the lookup needs; the sqlite store and the dashboard slice both satisfy it. */
export interface PlannedExerciseReader {
  getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]>;
  getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]>;
  getPlannedExercise(id: string): Promise<StoredPlannedExercise | undefined>;
}

/**
 * The planned exercise (if any) carrying `exerciseId`, resolved through either
 * assignment shape: a whole template, or a single planned exercise.
 */
export async function findPlannedExerciseForSession(
  store: PlannedExerciseReader,
  sessionId: string,
  exerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  for (const assignment of await store.getAssignmentsForSession(sessionId)) {
    if (assignment.workoutTemplateId !== undefined) {
      const planned = await store.getPlannedExercisesForTemplate(assignment.workoutTemplateId);
      const match = planned.find((p) => p.exerciseId === exerciseId);
      if (match !== undefined) return match;
    } else if (assignment.plannedExerciseId !== undefined) {
      const one = await store.getPlannedExercise(assignment.plannedExerciseId);
      if (one?.exerciseId === exerciseId) return one;
    }
  }
  return undefined;
}
