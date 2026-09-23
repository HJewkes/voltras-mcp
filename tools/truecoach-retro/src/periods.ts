// Programme periods: the log shows a change of programme as a switch in how prescriptions are written.

import { isWorkRow } from './log-rules.js';
import type { SetRecord } from './types.js';

const LOAD_FIRST = /^\s*\d+(?:\.\d+)?\s*@/;

function loadFirstShare(rows: readonly SetRecord[]): number {
  const lines = rows.flatMap((row) => row.prescription_lines);
  if (lines.length === 0) return 0;
  return lines.filter((line) => LOAD_FIRST.test(line)).length / lines.length;
}

function groupBy(
  rows: readonly SetRecord[],
  key: (date: string) => string,
): Map<string, SetRecord[]> {
  const groups = new Map<string, SetRecord[]>();
  for (const row of rows) {
    if (!isWorkRow(row)) continue;
    const k = key(row.workout_due_date);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The first training day of the first month where load-first lines ('205 @ 5 x 5') are most of
 * the prescriptions, and that day's own lines are too. `null` when no month qualifies.
 */
export function detectProgrammeSplit(rows: readonly SetRecord[]): string | null {
  for (const [month, monthRows] of groupBy(rows, (date) => date.slice(0, 7))) {
    if (loadFirstShare(monthRows) <= 0.5) continue;
    const days = groupBy(monthRows, (date) => date);
    for (const [day, dayRows] of days) if (loadFirstShare(dayRows) > 0.5) return day;
    return [...days.keys()][0] ?? `${month}-01`;
  }
  return null;
}

export interface Period {
  name: string;
  from: string;
  /** Exclusive. */
  to: string;
}

export function periodsAround(split: string | null): Period[] {
  if (split === null) return [{ name: 'whole log', from: '0000-01-01', to: '9999-12-31' }];
  return [
    { name: 'programme period 1', from: '0000-01-01', to: split },
    { name: 'programme period 2', from: split, to: '9999-12-31' },
  ];
}

export function inPeriod(date: string, period: Period): boolean {
  return date >= period.from && date < period.to;
}
