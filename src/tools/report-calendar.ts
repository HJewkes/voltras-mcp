// What a dated calendar adds to `report.weekly` (VW-478): which weeks the range covered, and
// what changed about a block's dates inside it.
//
// Adherence used to count only the weeks a session touched, so a week nobody trained counted
// 0 planned and 0 done and read as nothing missed. A dated week is planned whether or not it
// was trained, which is what makes a fully skipped week visible.
//
// A store with no dated block keeps the old rule: there is no calendar to read.

import { localDate } from '../analytics/training-days.js';
import { blockCalendar, planWeeksOf, type CalendarWeek } from '../plan/block-calendar.js';
import { shortDate } from '../plan/schedule-history.js';
import { scheduleRange } from '../plan/block-calendar.js';
import type {
  SessionStore,
  StoredBlockSchedule,
  StoredTrainingBlock,
  StoredTrainingWeek,
} from '../store/types.js';

export type ReportCalendarStore = Pick<
  SessionStore,
  | 'listTrainingPrograms'
  | 'getTrainingBlocksForProgram'
  | 'getTrainingWeeksForBlock'
  | 'getLiveBlockSchedule'
  | 'listBlockScheduleHistory'
>;

/** One dated calendar week the report's range overlaps. */
export interface DatedWeek {
  blockName: string;
  /** The plan week's row, or `undefined` for a week an extend left with no plan week. */
  weekRow: StoredTrainingWeek | undefined;
  startsOn: string;
  endsOn: string;
  skipped: CalendarWeek['skipped'];
}

/** Every dated calendar week of every live block that the local range [from, to] overlaps. */
export async function datedWeeksOverlapping(
  store: ReportCalendarStore,
  fromIso: string,
  toIso: string,
): Promise<DatedWeek[]> {
  const from = localDate(fromIso);
  const to = localDate(toIso);
  const weeks: DatedWeek[] = [];
  for (const { block, live } of await datedBlocks(store)) {
    const rows = await store.getTrainingWeeksForBlock(block.id);
    const calendar = blockCalendar(live, planWeeksOf(rows), from);
    for (const week of calendar.weeks) {
      if (week.endsOn < from || to < week.startsOn) continue;
      weeks.push({
        blockName: block.name,
        weekRow: rows.find((row) => row.orderIndex + 1 === week.planWeek),
        startsOn: week.startsOn,
        endsOn: week.endsOn,
        skipped: week.skipped,
      });
    }
  }
  return weeks.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
}

/**
 * One line per schedule row DECLARED inside the range: what the coach changed about a block's
 * dates that week, and what it means for the end date. A row declared earlier is already the
 * calendar the rest of the report is read on, so it is not news.
 */
export async function scheduleChangeLines(
  store: ReportCalendarStore,
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  const lines: string[] = [];
  for (const { block } of await datedBlocks(store)) {
    const history = await store.listBlockScheduleHistory(block.id);
    for (const [index, row] of history.entries()) {
      if (row.declaredAt < fromIso || row.declaredAt > toIso) continue;
      lines.push(changeLine(block, row, history[index - 1]));
    }
  }
  return lines;
}

function changeLine(
  block: StoredTrainingBlock,
  row: StoredBlockSchedule,
  previous: StoredBlockSchedule | undefined,
): string {
  const now = scheduleRange(row);
  const was = previous === undefined ? null : scheduleRange(previous);
  const reason = row.reason === undefined ? '' : `: ${row.reason}`;
  if (row.kind === 'cleared') return `${block.name} was un-dated${reason}.`;
  if (row.kind === 'planned') {
    return `${block.name} planned: ${shortDate(now!.startsOn)} to ${shortDate(now!.endsOn)}${reason}.`;
  }
  if (row.kind === 'week_skipped') return `${block.name}: ${skipLine(row, previous)}${reason}.`;
  const ending = was === null ? '' : ` (was ${shortDate(was.endsOn)})`;
  const verb = row.kind === 'moved' ? 'moved' : 'resized';
  return `${block.name} ${verb}: now ${shortDate(now!.startsOn)} to ${shortDate(now!.endsOn)}${ending}${reason}.`;
}

function skipLine(row: StoredBlockSchedule, previous: StoredBlockSchedule | undefined): string {
  const before = new Set((previous?.skips ?? []).map((skip) => skip.weekOf));
  const added = row.skips.find((skip) => !before.has(skip.weekOf));
  if (added === undefined) return 'a missed week was recorded';
  const verb = added.mode === 'hold' ? 'held' : 'extended';
  return `the week of ${shortDate(added.weekOf)} was ${verb}`;
}

async function datedBlocks(
  store: ReportCalendarStore,
): Promise<{ block: StoredTrainingBlock; live: StoredBlockSchedule }[]> {
  const out: { block: StoredTrainingBlock; live: StoredBlockSchedule }[] = [];
  for (const program of await store.listTrainingPrograms({ includeArchived: false })) {
    for (const block of await store.getTrainingBlocksForProgram(program.id)) {
      const live = await store.getLiveBlockSchedule(block.id);
      if (live?.startsOn !== undefined) out.push({ block, live });
    }
  }
  return out;
}
