// The mesocycle the goals page is in (VW-480), for the header VW-466 specifies: which block,
// what it is for, the dates it runs, which week this is and which weeks are off.
//
// Everything comes from the one current-block rule (VW-475) and that block's live calendar
// (VW-473), so the header and the goal cards cannot disagree about a week. `null` while no
// block has dates: the page then says "No dated block" rather than drawing a header.
//
// A gap (a block ended, none current) reports the block that ended with state `ended`, so the
// header can say "Ended Sun 4 Oct" and name the next block when there is one.

import { blockCalendar, planWeeksOf } from '../../plan/block-calendar.js';
import { resolveCurrentBlock, type CurrentBlockStore } from '../../plan/current-block.js';
import type { SessionStore } from '../../store/types.js';

export type MesocycleStore = CurrentBlockStore & Pick<SessionStore, 'getTrainingBlock'>;

export interface MesocycleWeek {
  index: number;
  isDeload: boolean;
  name?: string;
  /** `hold` kept the calendar and skipped the plan week; `extend` added this week off. */
  skipped: 'hold' | 'extend' | null;
}

export interface MesocycleView {
  programName: string;
  blockId: string;
  blockName: string;
  focus: string | null;
  /** The block's place in its program, counting from 1, and how many blocks the program has. */
  blockIndex: number;
  blockCount: number;
  startsOn: string;
  endsOn: string;
  state: 'upcoming' | 'current' | 'ended';
  week: { n: number; of: number; isDeload: boolean; name?: string } | null;
  weeks: MesocycleWeek[];
  nextBlock: { id: string; name: string; startsOn: string } | null;
}

/** The dated block in force, or `null` when no block has dates. */
export async function fetchMesocycle(
  store: MesocycleStore,
  today: string,
): Promise<MesocycleView | null> {
  const read = await resolveCurrentBlock(store, today);
  const block = read.block ?? (await upcomingBlock(store, read.nextBlock?.id));
  if (read.program === null || block === undefined) return null;
  const live = await store.getLiveBlockSchedule(block.id);
  const calendar = blockCalendar(
    live,
    planWeeksOf(await store.getTrainingWeeksForBlock(block.id)),
    today,
  );
  if (calendar.startsOn === null || calendar.endsOn === null) return null;
  const siblings = await store.getTrainingBlocksForProgram(block.programId);
  const weeks = calendar.weeks.map((week) => ({
    index: week.calendarWeek,
    isDeload: week.isDeload,
    ...(week.name !== undefined ? { name: week.name } : {}),
    skipped: week.skipped,
  }));
  return {
    programName: read.program.name,
    blockId: block.id,
    blockName: block.name,
    focus: block.focus ?? null,
    blockIndex: siblings.findIndex((sibling) => sibling.id === block.id) + 1,
    blockCount: siblings.length,
    startsOn: calendar.startsOn,
    endsOn: calendar.endsOn,
    // A gap reports the block that ended; `upcoming` and `current` are the calendar's own.
    state: calendar.state === 'undated' ? 'ended' : calendar.state,
    week: weekOf(read, weeks),
    weeks,
    nextBlock: read.nextBlock,
  };
}

/** Before the first dated block starts, the header describes that block. */
async function upcomingBlock(store: MesocycleStore, blockId: string | undefined) {
  return blockId === undefined ? undefined : await store.getTrainingBlock(blockId);
}

function weekOf(
  read: Awaited<ReturnType<typeof resolveCurrentBlock>>,
  weeks: readonly MesocycleWeek[],
): MesocycleView['week'] {
  if (read.week === null) return null;
  const week = weeks[read.week.n - 1];
  return {
    n: read.week.n,
    of: read.week.of,
    isDeload: read.week.isDeload,
    ...(week?.name !== undefined ? { name: week.name } : {}),
  };
}
