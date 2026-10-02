// The planning brief's frequency-progression advisory (VW-623, B28): the block being planned adds
// a training day before the program has held its current day count for two blocks. RP holds the
// count for 2-3 mesocycles before adding a day (rp-s5-frequency-progression-conservative). Advisory
// copy only: the hold is a planning prior, and nothing here blocks a plan.

import type { LintOffDayTemplate } from '../plan/lint-plan.js';
import { trainingDaysOf } from '../plan/muscle-frequency.js';
import type { StoredTrainingBlock } from '../store/types.js';
import type { BriefAdvisory } from './plan-brief-advisories.js';

const FREQUENCY_PROGRESSION = 'rp:rp-s5-frequency-progression-conservative';

/** The low end of RP's 2-3 mesocycle hold. */
const MIN_HELD_BLOCKS = 2;

/** A block of the program in order, with its training days a week, or `null` when none are planned. */
export interface BlockDays {
  name: string;
  trainingDays: number | null;
}

/**
 * Warns when the last block (the one being planned) trains more days a week than the block before
 * it, and that earlier day count held for fewer than two blocks in a row.
 */
export function trainingDayAddAdvisory(blocks: readonly BlockDays[]): BriefAdvisory | null {
  const next = blocks.at(-1);
  if (next === undefined || next.trainingDays === null) return null;
  const earlier = blocks.slice(0, -1).filter((b) => b.trainingDays !== null);
  const previous = earlier.at(-1);
  if (previous?.trainingDays == null || next.trainingDays <= previous.trainingDays) return null;
  const held = heldBlocks(earlier);
  if (held >= MIN_HELD_BLOCKS) return null;
  return {
    kind: 'frequency_progression',
    exerciseId: null,
    text:
      `"${next.name}" plans ${next.trainingDays} training days a week, up from ` +
      `${previous.trainingDays}, which held for ${held} ${held === 1 ? 'block' : 'blocks'}. RP ` +
      'holds the day count for 2 to 3 mesocycles before adding a day, because a new day is a ' +
      `large jump in weekly stimulus and fatigue (${FREQUENCY_PROGRESSION}). The hold is a ` +
      'planning prior, and the sitting decides whether to add the day now.',
    rpIds: [FREQUENCY_PROGRESSION],
  };
}

/** How many blocks in a row, ending at the last one, share its day count. */
function heldBlocks(planned: readonly BlockDays[]): number {
  const count = planned.at(-1)?.trainingDays;
  let held = 0;
  for (let i = planned.length - 1; i >= 0 && planned[i]?.trainingDays === count; i--) held++;
  return held;
}

/** The store reads the advisory needs, narrowed so a test can fake them. */
export interface BlockDaysStore {
  getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]>;
  getTrainingWeeksForBlock(
    blockId: string,
  ): Promise<readonly { id: string; orderIndex: number; isDeload: boolean }[]>;
  getWorkoutTemplatesForWeek(weekId: string): Promise<readonly LintOffDayTemplate[]>;
}

/** The program's blocks up to and including `next`, in order, each with its training days. */
export async function readProgramBlockDays(
  store: BlockDaysStore,
  next: StoredTrainingBlock | null,
): Promise<BlockDays[]> {
  if (next === null) return [];
  const blocks = (await store.getTrainingBlocksForProgram(next.programId))
    .filter((block) => block.id === next.id || block.orderIndex < next.orderIndex)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  return Promise.all(
    blocks.map(async (block) => ({
      name: block.name,
      trainingDays: await blockTrainingDays(store, block.id),
    })),
  );
}

/** The most training days any non-deload week of the block plans; `null` when none plans one. */
async function blockTrainingDays(store: BlockDaysStore, blockId: string): Promise<number | null> {
  let most: number | null = null;
  for (const week of await store.getTrainingWeeksForBlock(blockId)) {
    if (week.isDeload) continue;
    const days = trainingDaysOf(await store.getWorkoutTemplatesForWeek(week.id));
    if (days > 0) most = Math.max(most ?? 0, days);
  }
  return most;
}
