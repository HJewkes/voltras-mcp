// `plan.block.planning_brief` (VW-476): the read the coach brings to a planning sitting. How
// the finishing block went, the block to plan next with a suggested start and length, the
// priorities re-ask, the diet phase and the history of both blocks' dates.
//
// READ ONLY. The sitting is prompted and never automatic (owner, VW-447): this writes nothing,
// and the suggestion is a starting point the lifter accepts, changes or declines.

import { todayLocal } from '../analytics/training-days.js';
import { addDays, isMonday, type BlockCalendar } from '../plan/block-calendar.js';
import { resolveCurrentBlock, type CurrentBlockRead } from '../plan/current-block.js';
import { scheduleHistory, type ScheduleHistory } from '../plan/schedule-history.js';
import type { ServerState } from '../state/server-state.js';
import type { RecompMode } from '../store/diet-phase.js';
import type { StoredTrainingBlock } from '../store/types.js';
import { readUnreviewed } from '../analytics/session-review.js';
import { readDietPhaseState } from './diet-phase-state.js';
import { buildGoalRealignment, type GoalRealignment } from './goal-realignment.js';
import { readBriefAdvisories, type BriefAdvisory } from './plan-brief-advisories.js';
import { calendarOf, placedBlocks, trainingDaysBetween } from './plan-schedule-tools.js';

export interface PlanningBrief {
  state: CurrentBlockRead['state'];
  planning: CurrentBlockRead['planning'];
  finishing: FinishingBlock | null;
  next: NextBlock | null;
  suggested: Suggestion;
  conflicts: string[];
  realignment: GoalRealignment | null;
  dietPhase: { phase: string; weeksInPhase: number | null; recompMode: RecompMode | null } | null;
  /**
   * Past local days nobody has marked training or test (VW-489). They are excluded
   * from every count here, so a zero beside a non-zero `unreviewedDays` means the
   * history is withheld pending review, not absent.
   */
  unreviewedDays: number;
  /** Those days themselves, newest first, so a coach can name them. */
  unreviewedDayList: string[];
  /** Staleness and deload-cadence notes for the sitting to weigh; never a block (VW-558). */
  advisories: BriefAdvisory[];
}

interface FinishingBlock {
  block: StoredTrainingBlock;
  calendar: BlockCalendar;
  trained: { templatesPlanned: number; templatesDone: number; trainingDays: string[] };
  history: ScheduleHistory;
}

interface NextBlock {
  block: StoredTrainingBlock;
  weekRows: number;
  calendar: BlockCalendar;
  history: ScheduleHistory;
}

interface Suggestion {
  startsOn: string;
  endsOn: string | null;
  weeksCount: number | null;
  deloadWeek: number | null;
  basis: string;
}

export async function buildPlanningBrief(
  state: ServerState,
  forBlockId: string | undefined,
): Promise<PlanningBrief> {
  const today = todayLocal();
  const read = await resolveCurrentBlock(state.store, today);
  const finishingBlock = read.state === 'current' || read.state === 'gap' ? read.block : null;
  const nextRow = await blockToPlan(state, read, finishingBlock, forBlockId);
  const next = nextRow === null ? null : await nextBlockView(state, nextRow, today);
  const suggested = await suggest(state, read, finishingBlock, next, today);
  return {
    state: read.state,
    planning: read.planning,
    finishing:
      finishingBlock === null ? null : await finishingView(state, finishingBlock, read, today),
    next,
    suggested,
    conflicts: await conflictsWith(state, next?.block.id ?? null, suggested),
    realignment:
      finishingBlock === null ? null : await buildGoalRealignment(state, finishingBlock.id),
    dietPhase: await dietPhaseView(state),
    ...(await readUnreviewed(state.store)),
    advisories: await readBriefAdvisories(state, finishingBlock),
  };
}

/**
 * The block the sitting plans: the one named, else the block after the finishing one in its
 * program, else (nothing current or ended) the upcoming block, else the first block of the
 * program in force that has never been trained.
 */
async function blockToPlan(
  state: ServerState,
  read: CurrentBlockRead,
  finishing: StoredTrainingBlock | null,
  forBlockId: string | undefined,
): Promise<StoredTrainingBlock | null> {
  if (forBlockId !== undefined) return (await state.store.getTrainingBlock(forBlockId)) ?? null;
  if (read.program === null) return null;
  const blocks = await state.store.getTrainingBlocksForProgram(read.program.id);
  if (finishing !== null) return blocks.find((b) => b.orderIndex > finishing.orderIndex) ?? null;
  if (read.nextBlock !== null) return blocks.find((b) => b.id === read.nextBlock?.id) ?? null;
  for (const block of blocks) {
    if (!(await anyTemplateTrained(state, block))) return block;
  }
  return null;
}

async function blockTemplates(state: ServerState, block: StoredTrainingBlock) {
  const templates = [];
  for (const week of await state.store.getTrainingWeeksForBlock(block.id)) {
    templates.push(...(await state.store.getWorkoutTemplatesForWeek(week.id)));
  }
  return templates;
}

async function anyTemplateTrained(
  state: ServerState,
  block: StoredTrainingBlock,
): Promise<boolean> {
  for (const template of await blockTemplates(state, block)) {
    if ((await state.store.getAssignmentsForTemplate(template.id)).length > 0) return true;
  }
  return false;
}

async function finishingView(
  state: ServerState,
  block: StoredTrainingBlock,
  read: CurrentBlockRead,
  today: string,
): Promise<FinishingBlock> {
  const calendar = read.calendar ?? (await calendarOf(state, block.id, today));
  const templates = await blockTemplates(state, block);
  let done = 0;
  for (const template of templates) {
    if ((await state.store.getAssignmentsForTemplate(template.id)).length > 0) done++;
  }
  const until = calendar.endsOn !== null && calendar.endsOn < today ? calendar.endsOn : today;
  return {
    block,
    calendar,
    trained: {
      templatesPlanned: templates.length,
      templatesDone: done,
      trainingDays: await trainingDaysBetween(state, calendar.startsOn, until),
    },
    history: scheduleHistory(await state.store.listBlockScheduleHistory(block.id)),
  };
}

async function nextBlockView(
  state: ServerState,
  block: StoredTrainingBlock,
  today: string,
): Promise<NextBlock> {
  return {
    block,
    weekRows: (await state.store.getTrainingWeeksForBlock(block.id)).length,
    calendar: await calendarOf(state, block.id, today),
    history: scheduleHistory(await state.store.listBlockScheduleHistory(block.id)),
  };
}

/** Today when it is a Monday, else the Monday after it. */
export function mondayOnOrAfter(date: string): string {
  let monday = date;
  while (!isMonday(monday)) monday = addDays(monday, 1);
  return monday;
}

async function suggest(
  state: ServerState,
  read: CurrentBlockRead,
  finishing: StoredTrainingBlock | null,
  next: NextBlock | null,
  today: string,
): Promise<Suggestion> {
  const weeksCount = next?.block.weeksCount ?? finishing?.weeksCount ?? null;
  const deloadWeek = next === null ? null : await lastDeloadWeek(state, next.block);
  const start = suggestedStart(read, next, today);
  return {
    ...start,
    endsOn: weeksCount === null ? null : addDays(start.startsOn, 7 * weeksCount - 1),
    weeksCount,
    deloadWeek,
  };
}

function suggestedStart(
  read: CurrentBlockRead,
  next: NextBlock | null,
  today: string,
): { startsOn: string; basis: string } {
  const nextStart = next?.calendar.startsOn ?? null;
  if (nextStart !== null)
    return { startsOn: nextStart, basis: 'the date the next block already has' };
  const endsOn = read.state === 'current' ? (read.calendar?.endsOn ?? null) : null;
  if (endsOn !== null) {
    return { startsOn: addDays(endsOn, 1), basis: 'the Monday after this block ends' };
  }
  return {
    startsOn: mondayOnOrAfter(today),
    basis: 'the first Monday from today, counting today when it is a Monday',
  };
}

async function lastDeloadWeek(
  state: ServerState,
  block: StoredTrainingBlock,
): Promise<number | null> {
  const deloads = (await state.store.getTrainingWeeksForBlock(block.id)).filter((w) => w.isDeload);
  const last = deloads.at(-1);
  return last === undefined ? null : last.orderIndex + 1;
}

/** Dated blocks the suggested range would overlap, named with their dates. */
async function conflictsWith(
  state: ServerState,
  blockId: string | null,
  suggested: Suggestion,
): Promise<string[]> {
  const { startsOn, endsOn } = suggested;
  if (endsOn === null) return [];
  return (await placedBlocks(state))
    .filter((b) => b.blockId !== blockId && b.startsOn <= endsOn && startsOn <= b.endsOn)
    .map((b) => `"${b.name}" runs ${b.startsOn} to ${b.endsOn}.`);
}

async function dietPhaseView(state: ServerState): Promise<PlanningBrief['dietPhase']> {
  const diet = await readDietPhaseState(state);
  if (diet.phase === 'unknown') return null;
  return {
    phase: diet.phase,
    weeksInPhase: diet.weeksInPhase,
    recompMode: diet.recompMode ?? null,
  };
}
