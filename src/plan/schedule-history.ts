// The `history` fact (VW-476): what a block's schedule rows say happened to its dates, as
// counts and one sentence the coach can cite in a planning sitting. A fact, never a score.

import { scheduleRange } from './block-calendar.js';
import type { StoredBlockSchedule } from '../store/types.js';

export interface ScheduleHistory {
  moves: number;
  resizes: number;
  holds: number;
  extends: number;
  firstPlanned: { startsOn: string; endsOn: string; declaredAt: string } | null;
  fact: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'Mon 14 Sep' for a 'YYYY-MM-DD' date, independent of the process timezone. */
export function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${DAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
}

function times(n: number): string {
  if (n === 1) return 'once';
  return n === 2 ? 'twice' : `${n} times`;
}

/** Counts and the sentence for one block's rows, oldest `seq` first. */
export function scheduleHistory(rows: readonly StoredBlockSchedule[]): ScheduleHistory {
  const first = rows.find((row) => row.kind === 'planned');
  const firstRange = first === undefined ? null : scheduleRange(first);
  const last = rows.at(-1);
  const skips = last?.skips ?? [];
  const history = {
    moves: rows.filter((row) => row.kind === 'moved').length,
    resizes: rows.filter((row) => row.kind === 'resized').length,
    holds: skips.filter((skip) => skip.mode === 'hold').length,
    extends: skips.filter((skip) => skip.mode === 'extend').length,
    firstPlanned:
      first === undefined || firstRange === null
        ? null
        : { ...firstRange, declaredAt: first.declaredAt },
  };
  return { ...history, fact: factOf(rows, history) };
}

function factOf(
  rows: readonly StoredBlockSchedule[],
  history: Omit<ScheduleHistory, 'fact'>,
): string {
  const last = rows.at(-1);
  if (last === undefined) return 'This block has never had dates.';
  if (last.startsOn === undefined) return 'This block had dates and was un-dated.';
  const parts = [datesSentence(rows, history, last.startsOn)];
  if (history.resizes > 0) parts.push(`Its length changed ${times(history.resizes)}.`);
  const skipped = [
    history.holds > 0 ? `${history.holds} held` : null,
    history.extends > 0 ? `${history.extends} extended` : null,
  ].filter((part) => part !== null);
  if (skipped.length > 0) parts.push(`Missed weeks: ${skipped.join(', ')}.`);
  return parts.join(' ');
}

function datesSentence(
  rows: readonly StoredBlockSchedule[],
  history: Omit<ScheduleHistory, 'fact'>,
  startsOn: string,
): string {
  if (history.moves === 0) return `This block has kept its planned start, ${shortDate(startsOn)}.`;
  const reason = rows.filter((row) => row.kind === 'moved').at(-1)?.reason;
  const from = history.firstPlanned?.startsOn;
  const first = from === undefined ? '' : ` first planned for ${shortDate(from)},`;
  return (
    `This block has moved ${times(history.moves)}:${first} now ${shortDate(startsOn)}` +
    `${reason === undefined ? '' : ` (${reason})`}.`
  );
}
