// The log-specific rules every check shares: what a work row is, what a training day is, and the blocks.

import { trainingDaysOf } from '../../../src/analytics/training-days.js';

import { noonInstant } from './dates.js';
import type { Block, SetRecord } from './types.js';

/** Below this the extraction guessed; such rows are kept and counted, never dropped. */
export const LOW_CONFIDENCE = 0.6;

/** A work row: dated and not above a warm-up divider. A block with no divider reads as all work. */
export function isWorkRow(row: SetRecord): row is SetRecord & { workout_due_date: string } {
  return row.workout_due_date !== null && row.is_warmup !== true;
}

/** A work row the lifter wrote out, not one the parser filled from a bare load and the prescription. */
export function isReportedSet(row: SetRecord): boolean {
  return isWorkRow(row) && !row.decided_by.includes('bare_load');
}

/** Training days: dates holding at least one work row, oldest first. */
export function trainingDays(rows: readonly SetRecord[]): string[] {
  const dates = rows.filter(isWorkRow).map((row) => noonInstant(row.workout_due_date));
  return trainingDaysOf(dates);
}

/** Rows grouped by email and exercise header, in first-seen order. */
export function groupBlocks(rows: readonly SetRecord[]): Block[] {
  const blocks = new Map<string, Block>();
  for (const row of rows) {
    if (row.workout_due_date === null) continue;
    const key = [row.message_id, row.exercise_label, row.exercise_name].join('|');
    const block = blocks.get(key) ?? {
      date: row.workout_due_date,
      exercise: row.exercise_name,
      prescriptionLines: row.prescription_lines,
      rows: [],
    };
    block.rows.push(row);
    blocks.set(key, block);
  }
  return [...blocks.values()];
}

/** Work sets in a row: the `sets` field, never assumed to be one. */
export function workSetsIn(rows: readonly SetRecord[]): number {
  return rows.filter(isWorkRow).reduce((sum, row) => sum + row.sets, 0);
}
