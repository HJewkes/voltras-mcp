// The store read behind the beginner rotation lint (VW-622): every exercise planned in the
// written template's block, against every exercise planned in the block before it.

import { lintBeginnerRotation } from '../plan/lint-rotation.js';
import type { PlanWarning } from '../plan/lint-plan.js';
import type { Tier, TierConfidence } from '../profile/tier.js';
import type { SessionStore, StoredPlannedExercise } from '../store/types.js';

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

/** The row just written, and the lift it held before the write when it overwrote one. */
export interface RotationWrite {
  templateId: string;
  writtenId: string;
  replacedExerciseId?: string;
}

/** The rotation lint for the block holding the written row; silent for a program's first block. */
export async function lintTemplateBlockRotation(
  store: RotationStore,
  write: RotationWrite,
  tier: Tier,
  confidence: TierConfidence,
): Promise<PlanWarning[]> {
  if (tier !== 'beginner') return [];
  const template = await store.getWorkoutTemplate(write.templateId);
  const week = template && (await store.getTrainingWeek(template.weekId));
  const block = week && (await store.getTrainingBlock(week.blockId));
  if (block === undefined) return [];
  const previous = (await store.getTrainingBlocksForProgram(block.programId))
    .filter((candidate) => candidate.orderIndex < block.orderIndex)
    .sort((a, b) => b.orderIndex - a.orderIndex)[0];
  if (previous === undefined) return [];
  const rows = await blockRows(store, block.id);
  const others = rows.filter((row) => row.id !== write.writtenId).map((row) => row.exerciseId);
  return lintBeginnerRotation({
    previousBlockExerciseIds: (await blockRows(store, previous.id)).map((row) => row.exerciseId),
    blockExerciseIds: rows.map((row) => row.exerciseId),
    blockExerciseIdsBefore:
      write.replacedExerciseId === undefined ? others : [...others, write.replacedExerciseId],
    tier,
    confidence,
  });
}

async function blockRows(store: RotationStore, blockId: string): Promise<StoredPlannedExercise[]> {
  const rows: StoredPlannedExercise[] = [];
  for (const week of await store.getTrainingWeeksForBlock(blockId)) {
    for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
      rows.push(...(await store.getPlannedExercisesForTemplate(template.id)));
    }
  }
  return rows;
}
