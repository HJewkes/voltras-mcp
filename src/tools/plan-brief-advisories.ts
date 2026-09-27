// Advisories the planning brief carries into the sitting (VW-558 S10): a main lift going in on
// an open flatline, and a finishing block run past the accumulation-to-deload ratio. Advisory
// copy only: the sitting decides, and nothing here blocks a plan.

import type { Flatline } from '../analytics/flatline.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type StoredTrainingBlock } from '../store/types.js';
import { computeHistoryTrend } from './metrics-tools.js';

/**
 * The longest accumulation run before a deload is due, in weeks: the long end of 3:1 to 5:1.
 * rp:rp-s2-fatigue-reduction-ladder (intermediates roughly 4:1 or 5:1, advanced 3:1 or 4:1).
 */
export const MAX_ACCUMULATION_WEEKS = 5;

export interface BriefAdvisory {
  kind: 'staleness' | 'deload_cadence';
  exerciseId: string | null;
  text: string;
  rpIds: string[];
}

type AdvisoryState = Pick<ServerState, 'store'>;

/** The trailing flatline on a lift's top-load trend, or `null` when it has none or no history. */
export type FlatlineReader = (state: AdvisoryState, exerciseId: string) => Promise<Flatline | null>;

export async function readBriefAdvisories(
  state: AdvisoryState,
  finishing: StoredTrainingBlock | null,
  readFlatline: FlatlineReader = openFlatline,
): Promise<BriefAdvisory[]> {
  const advisories: BriefAdvisory[] = [];
  for (const exerciseId of await mainLiftIds(state)) {
    const found = await readFlatline(state, exerciseId);
    if (found !== null) advisories.push(stalenessAdvisory(exerciseId, found));
  }
  const cadence = finishing === null ? null : await deloadCadenceAdvisory(state, finishing);
  return cadence === null ? advisories : [...advisories, cadence];
}

/** The lifts the lifter declared as priorities: the main lifts a sitting plans around. */
async function mainLiftIds(state: AdvisoryState): Promise<string[]> {
  const priorities = await state.store.listPriorities(LOCAL_USER_ID);
  return [...new Set(priorities.filter((p) => p.kind === 'lift').map((p) => p.ref))];
}

async function openFlatline(state: AdvisoryState, exerciseId: string): Promise<Flatline | null> {
  try {
    const result = await computeHistoryTrend(state as ServerState, { exerciseId });
    return result.plateau?.flatline ?? null;
  } catch {
    // A lift with no working sets in the window has no trend, so it cannot be stale.
    return null;
  }
}

function stalenessAdvisory(exerciseId: string, found: Flatline): BriefAdvisory {
  return {
    kind: 'staleness',
    exerciseId,
    text:
      `${exerciseId} goes into this sitting on an open flatline: ${found.reasoning}. A lift that ` +
      'has stopped responding is the one to swap at the end of the mesocycle, after checking the ' +
      'stall is not fatigue or a diet phase (rp:rp-s7-sfr-staleness-exercise-swap-trigger).',
    rpIds: ['rp:rp-s7-sfr-staleness-exercise-swap-trigger'],
  };
}

async function deloadCadenceAdvisory(
  state: AdvisoryState,
  finishing: StoredTrainingBlock,
): Promise<BriefAdvisory | null> {
  const weeks = await state.store.getTrainingWeeksForBlock(finishing.id);
  const run = longestAccumulationRun(weeks.map((week) => week.isDeload));
  const hasDeload = weeks.some((week) => week.isDeload);
  if (weeks.length === 0 || (hasDeload && run <= MAX_ACCUMULATION_WEEKS)) return null;
  const record = await deloadRecord(state, finishing.programId);
  const shape = hasDeload
    ? `runs ${run} accumulation weeks before its deload`
    : `has ${run} weeks and no deload week`;
  return {
    kind: 'deload_cadence',
    exerciseId: null,
    text:
      `"${finishing.name}" ${shape}, past the 3:1 to 5:1 accumulation-to-deload ratio ` +
      `(rp:rp-s2-fatigue-reduction-ladder). ${record} Beginners may go months without one ` +
      '(rp:rp-s4-beginner-no-deload-for-months); the trigger stays performance-based.',
    rpIds: ['rp:rp-s2-fatigue-reduction-ladder', 'rp:rp-s4-beginner-no-deload-for-months'],
  };
}

function longestAccumulationRun(deloads: readonly boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const isDeload of deloads) {
    current = isDeload ? 0 : current + 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** The lifter's own record: how many of the program's blocks planned a deload week. */
async function deloadRecord(state: AdvisoryState, programId: string): Promise<string> {
  const blocks = await state.store.getTrainingBlocksForProgram(programId);
  let withDeload = 0;
  for (const block of blocks) {
    const weeks = await state.store.getTrainingWeeksForBlock(block.id);
    if (weeks.some((week) => week.isDeload)) withDeload += 1;
  }
  return `${withDeload} of this program's ${blocks.length} blocks planned a deload week.`;
}
