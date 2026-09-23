// A goal target on its block's calendar (VW-477). A target that carries `blockId` for a dated
// block takes its weeks, deloads, week 1 and end from that block's LIVE schedule, so a move of
// an upcoming block moves its targets without editing a target row. A target with no block, or
// whose block is undated, keeps its own measured frame.

import { localMidnightIso } from '../analytics/training-days.js';
import type { GoalBandWeek } from '../analytics/goal-band.js';
import { addDays, blockCalendar, planWeeksOf } from '../plan/block-calendar.js';
import { resolveCurrentBlock, type CurrentBlockStore } from '../plan/current-block.js';
import type { SessionStore, StoredPriority } from '../store/types.js';
import type { GoalDerivationContext } from './goal-derivation.js';

export type GoalBlockFrameStore = Pick<
  SessionStore,
  'getLiveBlockSchedule' | 'getTrainingWeeksForBlock'
>;

export interface GoalBlockFrame {
  blockId: string;
  weeks: GoalBandWeek[];
  /** Local midnight of the block's first Monday: week 1 of the goal grid. */
  weekOneAt: string;
  /** Local midnight of the Monday after the block's last week (exclusive end). */
  endsAt: string;
  /** The block's start date while it has not started; absent once it has. */
  startsOn?: string;
}

/**
 * The frame a dated block gives its targets, or `null` when the block is undated. An
 * `extend` off week runs no plan week, so it reads like a deload: flat band, no verdict. A
 * `hold` week keeps its place on the calendar and its band row.
 */
export async function goalBlockFrame(
  store: GoalBlockFrameStore,
  blockId: string | undefined,
  today: string,
): Promise<GoalBlockFrame | null> {
  if (blockId === undefined) return null;
  const live = await store.getLiveBlockSchedule(blockId);
  const rows = await store.getTrainingWeeksForBlock(blockId);
  const calendar = blockCalendar(live, planWeeksOf(rows), today);
  if (calendar.startsOn === null || calendar.endsOn === null) return null;
  return {
    blockId,
    weeks: calendar.weeks.map((week, index) => ({
      index: index + 1,
      isDeload: week.isDeload || week.skipped === 'extend',
    })),
    weekOneAt: localMidnightIso(calendar.startsOn),
    endsAt: localMidnightIso(addDays(calendar.endsOn, 1)),
    ...(calendar.state === 'upcoming' ? { startsOn: calendar.startsOn } : {}),
  };
}

/** The derivation context with the block's weeks in place of the priority's horizon. */
export function contextInFrame(
  context: GoalDerivationContext,
  frame: GoalBlockFrame | null,
): GoalDerivationContext {
  if (frame === null) return context;
  return { ...context, weeks: frame.weeks, horizonWeeks: frame.weeks.length };
}

/**
 * The block a new target is set for: the priority's own block when it is dated, else the
 * upcoming dated block, else the current one (the default `goal.declare_priorities` uses).
 */
export async function targetBlockId(
  store: CurrentBlockStore,
  priority: StoredPriority,
  today: string,
): Promise<string | undefined> {
  if (priority.blockId !== undefined) {
    const live = await store.getLiveBlockSchedule(priority.blockId);
    if (live?.startsOn !== undefined) return priority.blockId;
  }
  return defaultDatedBlockId(store, today);
}

/** The upcoming dated block, else the current one; undefined when neither exists. */
export async function defaultDatedBlockId(
  store: CurrentBlockStore,
  today: string,
): Promise<string | undefined> {
  const read = await resolveCurrentBlock(store, today);
  if (read.nextBlock !== null) return read.nextBlock.id;
  return read.state === 'current' ? read.block?.id : undefined;
}
