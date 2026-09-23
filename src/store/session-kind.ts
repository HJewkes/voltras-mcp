// Test or training: the one predicate that decides whether recorded work is the
// lifter's HISTORY or a bench test (VW-489).
//
// The owner's ruling (2026-09-19): "Most of the historical data is from test
// sessions not actual training, we should have a way to mark accordingly", and,
// asked what unreviewed rows count as, "exclude them until marked training".
//
// THE RULE: a row counts as training only when it SAYS so. `kind IS NULL` means
// nobody has reviewed it, and unreviewed is excluded from every lifter-facing
// read. There is no stored cut-over instant: the cut-over is the moment this
// code starts writing, because from then on every row carries an explicit kind
// and every row from before it is NULL. A second source of truth for the same
// question could disagree with the column, and would count test data as
// training for any row an older server wrote after the instant.
//
// This module is the seam. The SQL half is applied at the store predicates that
// already carry `lifter IS NULL`, and the in-memory half at the paths that
// legitimately read a whole session and then have to drop rows — the same shape
// `scopeSetsToLifter` takes for guests (VW-169).

/** The two things a recorded session can be. NULL on the row means neither yet. */
export const SESSION_KINDS = ['training', 'test'] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * What a reader asks for. Omitted means `'training'`, so a caller that says
 * nothing gets the lifter-facing view. `'any'` is the EXPLICIT opt-out, and the
 * only readers entitled to it are the ones the review itself runs on:
 * `session.list`, `session.get`, `session.review_list` and the debug reads.
 */
export type SessionKindFilter = SessionKind | 'any';

/** Narrow a value read back from SQLite, which is free text under a CHECK. */
export function isSessionKind(value: string): value is SessionKind {
  return (SESSION_KINDS as readonly string[]).includes(value);
}

/**
 * The WHERE term a kind filter contributes, or `undefined` for `'any'`.
 * `column` takes the alias when the query joins (`s.kind`).
 */
export function sessionKindPredicate(
  filter: SessionKindFilter = 'training',
  column = 'kind',
): { where: string; params: string[] } | undefined {
  if (filter === 'any') return undefined;
  return { where: `${column} = ?`, params: [filter] };
}

/** A session or set row as far as its kind is concerned — live or stored. */
export interface KindBearing {
  kind?: SessionKind | undefined;
}

/**
 * Whether this row is part of the lifter's training history. Unreviewed rows
 * (`kind` absent) are not, which is the whole point of the flag.
 */
export function countsAsTraining(row: KindBearing): boolean {
  return row.kind === 'training';
}

/** Keep only the rows that count as training. The in-memory twin of the SQL above. */
export function scopeToTraining<T extends KindBearing>(rows: readonly T[]): T[] {
  return rows.filter(countsAsTraining);
}
