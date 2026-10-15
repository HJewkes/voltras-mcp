// A persona's program tree: one program, its blocks laid end to end from the
// first history week, a template per workout per week, and a dated schedule per
// block. A block may run past the history, so the plan shows weeks still to come.

import type { PersonaStore } from './write.js';
import { localAt, localDay, weekLoadLbs, weekMonday, weekSlot } from './calendar.js';
import type { PersonaTraining } from './types.js';

export function templateId(personaId: string, week: number, workoutIndex: number): string {
  return `${personaId}-week-${week + 1}-workout-${workoutIndex + 1}`;
}

export async function seedPlan(
  store: PersonaStore,
  personaId: string,
  training: PersonaTraining,
  now: Date,
): Promise<void> {
  if (training.blocks.length === 0) return;
  const programId = `${personaId}-program`;
  const createdAt = localAt(weekMonday(training, now, 0), 0, 8).toISOString();
  await store.putTrainingProgram({ id: programId, name: 'Upper / Lower', createdAt });
  let firstWeek = 0;
  for (const [orderIndex, block] of training.blocks.entries()) {
    const blockId = `${personaId}-block-${orderIndex + 1}`;
    await store.putTrainingBlock({
      id: blockId,
      programId,
      orderIndex,
      name: block.name,
      weeksCount: block.weeks,
    });
    for (let week = firstWeek; week < firstWeek + block.weeks; week++) {
      await seedWeek(store, personaId, training, { blockId, week, orderIndex: week - firstWeek });
    }
    await store.appendBlockSchedule({
      blockId,
      startsOn: localDay(weekMonday(training, now, firstWeek)),
      weeksCount: block.weeks,
      skips: [],
      kind: 'planned',
      changedBy: 'user',
      declaredAt: createdAt,
    });
    firstWeek += block.weeks;
  }
}

async function seedWeek(
  store: PersonaStore,
  personaId: string,
  training: PersonaTraining,
  at: { blockId: string; week: number; orderIndex: number },
): Promise<void> {
  const weekId = `${personaId}-week-${at.week + 1}`;
  const deload = weekSlot(training, at.week)?.deload === true;
  await store.putTrainingWeek({
    id: weekId,
    blockId: at.blockId,
    orderIndex: at.orderIndex,
    name: deload ? 'Deload' : `Week ${at.orderIndex + 1}`,
    isDeload: deload,
  });
  for (const [workoutIndex, workout] of training.workouts.entries()) {
    const id = templateId(personaId, at.week, workoutIndex);
    await store.putWorkoutTemplate({ id, weekId, name: workout.name, orderIndex: workoutIndex });
    for (const [orderIndex, lift] of workout.lifts.entries()) {
      await store.putPlannedExercise({
        id: `${id}-exercise-${orderIndex + 1}`,
        workoutTemplateId: id,
        exerciseId: lift.exerciseId,
        orderIndex,
        targetSets: deload ? Math.max(1, training.setsPerLift - 1) : training.setsPerLift,
        targetRepsLow: training.targetReps,
        targetRepsHigh: training.targetReps,
        targetWeightLbs: weekLoadLbs(training, lift, at.week),
        restSec: training.restSec,
      });
    }
  }
}
