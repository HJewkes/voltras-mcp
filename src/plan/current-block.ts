// The current-block rule (VW-475): the ONE answer to "which plan is in force today". Every
// reader that defaults a program or a block asks this, so no two can disagree.
//
// Only non-archived programs count. By live schedule dates, in local calendar days:
// - current:      a dated block contains today; its program is the program.
// - upcoming:     nothing is current and nothing has ended, but a dated block lies ahead.
// - gap:          nothing is current and a dated block has ended. Training continues unplanned
//                 (owner, VW-447 Q3); the ended block is reported, never continued.
// - undated_only: no block is dated. The newest program with work remaining is the program,
//                 else the newest program, so a finished test program never outranks a real one.
// Once any block is dated, an undated program is never picked.
//
// The planning read says whether the next block is due to be planned. It is a read only: the
// prompts that use it belong to the planning sitting (VW-447 task 4).

import { blockCalendar, planWeeksOf, type BlockCalendar } from './block-calendar.js';
import type { SessionStore, StoredTrainingBlock, StoredTrainingProgram } from '../store/types.js';

export type CurrentBlockStore = Pick<
  SessionStore,
  | 'listTrainingPrograms'
  | 'getTrainingBlocksForProgram'
  | 'getTrainingWeeksForBlock'
  | 'getWorkoutTemplatesForWeek'
  | 'getAssignmentsForTemplate'
  | 'getLiveBlockSchedule'
>;

export type CurrentBlockState = 'current' | 'upcoming' | 'gap' | 'undated_only';

export interface CurrentWeek {
  n: number;
  of: number;
  isDeload: boolean;
  name?: string;
  startsOn: string;
  endsOn: string;
}

export interface PlanningRead {
  due: boolean;
  windowOpensOn: string | null;
  reason: string;
}

export interface CurrentBlockRead {
  state: CurrentBlockState;
  program: StoredTrainingProgram | null;
  /** current: the block in force; gap: the block that ended last; otherwise null. */
  block: StoredTrainingBlock | null;
  calendar: BlockCalendar | null;
  week: CurrentWeek | null;
  nextBlock: { id: string; name: string; startsOn: string } | null;
  planning: PlanningRead;
}

interface DatedBlock {
  program: StoredTrainingProgram;
  block: StoredTrainingBlock;
  calendar: BlockCalendar & { startsOn: string; endsOn: string };
}

export async function resolveCurrentBlock(
  store: CurrentBlockStore,
  today: string,
): Promise<CurrentBlockRead> {
  const programs = await store.listTrainingPrograms({ includeArchived: false });
  const dated = await datedBlocks(store, programs, today);
  if (dated.length === 0) return undatedOnly(store, programs);
  const current = dated.find((d) => d.calendar.state === 'current');
  const next = dated.find((d) => d.calendar.state === 'upcoming') ?? null;
  if (current !== undefined) return currentRead(current, next, today);
  const ended = dated.filter((d) => d.calendar.state === 'ended').at(-1);
  if (ended === undefined) return upcomingRead(next as DatedBlock);
  return gapRead(ended, next);
}

/** Every dated block of the given programs, in date order. */
async function datedBlocks(
  store: CurrentBlockStore,
  programs: readonly StoredTrainingProgram[],
  today: string,
): Promise<DatedBlock[]> {
  const out: DatedBlock[] = [];
  for (const program of programs) {
    for (const block of await store.getTrainingBlocksForProgram(program.id)) {
      const live = await store.getLiveBlockSchedule(block.id);
      if (live?.startsOn === undefined) continue;
      const weeks = await store.getTrainingWeeksForBlock(block.id);
      const calendar = blockCalendar(live, planWeeksOf(weeks), today);
      out.push({ program, block, calendar: calendar as DatedBlock['calendar'] });
    }
  }
  return out.sort((a, b) => a.calendar.startsOn.localeCompare(b.calendar.startsOn));
}

function nextRef(next: DatedBlock | null): CurrentBlockRead['nextBlock'] {
  if (next === null) return null;
  return { id: next.block.id, name: next.block.name, startsOn: next.calendar.startsOn };
}

function currentRead(
  current: DatedBlock,
  next: DatedBlock | null,
  today: string,
): CurrentBlockRead {
  const { calendar } = current;
  const index = calendar.weeks.findIndex((w) => w.startsOn <= today && today <= w.endsOn);
  const week = calendar.weeks[index];
  return {
    state: 'current',
    program: current.program,
    block: current.block,
    calendar,
    week: {
      n: index + 1,
      of: calendar.weeks.length,
      isDeload: week.isDeload,
      ...(week.name !== undefined ? { name: week.name } : {}),
      startsOn: week.startsOn,
      endsOn: week.endsOn,
    },
    nextBlock: nextRef(next),
    planning: currentPlanning(current, next, today),
  };
}

/**
 * The planning window opens on the Monday of the block's final calendar week, deload or not:
 * "during a deload week or the last week of the prior block or the weekend before" (owner,
 * VW-447) is about the end of the block, so a mid-block deload never opens it early.
 */
export function planningWindowOpensOn(calendar: BlockCalendar): string | null {
  return calendar.weeks.at(-1)?.startsOn ?? null;
}

function currentPlanning(
  current: DatedBlock,
  next: DatedBlock | null,
  today: string,
): PlanningRead {
  const windowOpensOn = planningWindowOpensOn(current.calendar);
  const name = current.block.name;
  if (next !== null) {
    return { due: false, windowOpensOn, reason: `${next.block.name} is already planned.` };
  }
  if (windowOpensOn === null || today < windowOpensOn) {
    return {
      due: false,
      windowOpensOn,
      reason: `The planning window for the block after ${name} opens on ${windowOpensOn}.`,
    };
  }
  return {
    due: true,
    windowOpensOn,
    reason: `${name} ends on ${current.calendar.endsOn} and nothing is planned after it.`,
  };
}

function upcomingRead(next: DatedBlock): CurrentBlockRead {
  return {
    state: 'upcoming',
    program: next.program,
    block: null,
    calendar: null,
    week: null,
    nextBlock: nextRef(next),
    planning: {
      due: false,
      windowOpensOn: null,
      reason: `${next.block.name} is planned to start on ${next.calendar.startsOn}.`,
    },
  };
}

function gapRead(ended: DatedBlock, next: DatedBlock | null): CurrentBlockRead {
  const endedOn = `${ended.block.name} ended on ${ended.calendar.endsOn}`;
  return {
    state: 'gap',
    program: ended.program,
    block: ended.block,
    calendar: ended.calendar,
    week: null,
    nextBlock: nextRef(next),
    planning:
      next === null
        ? { due: true, windowOpensOn: null, reason: `${endedOn} and no block is planned.` }
        : {
            due: false,
            windowOpensOn: null,
            reason: `${endedOn}; ${next.block.name} starts on ${next.calendar.startsOn}.`,
          },
  };
}

async function undatedOnly(
  store: CurrentBlockStore,
  programs: readonly StoredTrainingProgram[],
): Promise<CurrentBlockRead> {
  let program: StoredTrainingProgram | null = null;
  for (const candidate of programs) {
    if (await hasWorkRemaining(store, candidate)) {
      program = candidate;
      break;
    }
  }
  return {
    state: 'undated_only',
    program: program ?? programs[0] ?? null,
    block: null,
    calendar: null,
    week: null,
    nextBlock: null,
    planning: { due: true, windowOpensOn: null, reason: 'No block has dates yet.' },
  };
}

/** Whether any workout template in the program has no session assigned to it. */
async function hasWorkRemaining(
  store: CurrentBlockStore,
  program: StoredTrainingProgram,
): Promise<boolean> {
  for (const block of await store.getTrainingBlocksForProgram(program.id)) {
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        if ((await store.getAssignmentsForTemplate(template.id)).length === 0) return true;
      }
    }
  }
  return false;
}
