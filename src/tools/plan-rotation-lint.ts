// The store read behind the beginner rotation lint (VW-622): every exercise planned in the
// written template's block, against every exercise planned in the block before it.

import { lintBeginnerRotation } from '../plan/lint-rotation.js';
import type { PlanWarning } from '../plan/lint-plan.js';
import type { Tier } from '../profile/tier.js';
import type { SessionStore } from '../store/types.js';

type RotationStore = Pick<
  SessionStore,
  | 'getWorkoutTemplate'
  | 'getTrainingWeek'
  | 'getTrainingBlock'
  | 'getTrainingBlocksForProgram'
  | 'getTrainingWeeksForBlock'
  | 'getWorkoutTemplatesForWeek'
  | 'getPlannedExercisesForTemplate'
>;

/** The rotation lint for the block holding `templateId`; silent for a program's first block. */
export async function lintTemplateBlockRotation(
  store: RotationStore,
  templateId: string,
  tier: Tier,
): Promise<PlanWarning[]> {
  if (tier !== 'beginner') return [];
  const template = await store.getWorkoutTemplate(templateId);
  const week = template && (await store.getTrainingWeek(template.weekId));
  const block = week && (await store.getTrainingBlock(week.blockId));
  if (block === undefined) return [];
  const previous = (await store.getTrainingBlocksForProgram(block.programId))
    .filter((candidate) => candidate.orderIndex < block.orderIndex)
    .sort((a, b) => b.orderIndex - a.orderIndex)[0];
  if (previous === undefined) return [];
  return lintBeginnerRotation({
    previousBlockExerciseIds: await blockExerciseIds(store, previous.id),
    blockExerciseIds: await blockExerciseIds(store, block.id),
    tier,
  });
}

async function blockExerciseIds(store: RotationStore, blockId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const week of await store.getTrainingWeeksForBlock(blockId)) {
    for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
      const rows = await store.getPlannedExercisesForTemplate(template.id);
      ids.push(...rows.map((row) => row.exerciseId));
    }
  }
  return ids;
}
