// The row every history read model takes, and the evidence grade it carries (VW-558, S5a).
//
// A history row is one set line: a reported line from an imported log, or a
// measured live set. Every payload built from these rows says which, how sure
// the parser was, and whether the line's block had no warm-up divider, so a
// view can never draw a reported figure as if the device had measured it.
//
// PURE. Days are local 'YYYY-MM-DD' strings the caller already resolved; every
// helper here reads them as UTC midnight so no zone can shift a day.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import type { StoredSide } from '../../store/types.js';

export type HistoryEvidenceKind = 'reported' | 'measured';

/** How a figure was obtained. Every history payload point carries one. */
export interface HistoryEvidence {
  evidence: HistoryEvidenceKind;
  /** The lowest parser confidence behind the figure; `null` when every row was measured. */
  confidence: number | null;
  /** A row behind the figure was read as work because its block had no warm-up divider. */
  dividerAbsent: boolean;
}

/** One set line, reported or measured. */
export interface HistorySetRow {
  day: string;
  /** `null` for a name the catalog map does not hold: a set and a training day, never a muscle. */
  exerciseId: string | null;
  exerciseName: string;
  side?: StoredSide | null;
  load: number | null;
  reps: number | null;
  /** Identical sets the line holds. */
  sets: number;
  warmup: boolean;
  /** The lifter wrote this set out, rather than the parser filling a bare load line. */
  writtenOut: boolean;
  /** Kept as work by the assigned-count rule although it exceeded the assigned sets. */
  surplusKeptAsWork: boolean;
  evidence: HistoryEvidenceKind;
  confidence: number | null;
  dividerAbsent: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** The Monday of the ISO week `day` falls in. */
export function isoWeekStart(day: string): string {
  const weekday = new Date(Date.parse(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** A noon-UTC instant for `day`, which reads as the same date in any zone within 11 hours. */
export function noonInstant(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/** Rows that count as work. Warm-ups never reach a history figure. */
export function workRows(rows: readonly HistorySetRow[]): HistorySetRow[] {
  return rows.filter((row) => !row.warmup && row.sets > 0);
}

/** Distinct days holding a work row, oldest first. Unmapped rows count. */
export function historyTrainingDays(rows: readonly HistorySetRow[]): string[] {
  return [...new Set(workRows(rows).map((row) => row.day))].sort();
}

/**
 * The grade of a figure built from `rows`: reported when any row was, at the
 * lowest confidence among them. `null` when no row stands behind the figure.
 */
export function evidenceOf(rows: readonly HistorySetRow[]): HistoryEvidence | null {
  if (rows.length === 0) return null;
  const confidences = rows.flatMap((row) => (row.confidence === null ? [] : [row.confidence]));
  return {
    evidence: rows.some((row) => row.evidence === 'reported') ? 'reported' : 'measured',
    confidence: confidences.length === 0 ? null : Math.min(...confidences),
    dividerAbsent: rows.some((row) => row.dividerAbsent),
  };
}

/** Rows grouped by a key, in first-seen order. */
export function groupRows<K>(
  rows: readonly HistorySetRow[],
  keyOf: (row: HistorySetRow) => K,
): Map<K, HistorySetRow[]> {
  const groups = new Map<K, HistorySetRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}
