// `session.mark_kind` and `session.review_list` (VW-489).
//
// The owner's history is mostly bench testing, and nothing in the data says
// which rows those are. These two tools are the whole marking loop: the list
// shows the local days nobody has classified, and `mark_kind` classifies one
// session, one day or a range of days.
//
// NEITHER TOOL GUESSES. A classifier that read "few sets, light load" as "test"
// would be wrong about a deload week, and being wrong here silently deletes
// training days from the lifter's own record. The list reports; a person rules.

import { UserFacingError } from '../errors.js';
import type { z } from 'zod';

import { reviewDayOf, reviewDays, type ReviewDay } from '../analytics/session-review.js';
import { log } from '../logger.js';
import type { SessionMarkKindInput, SessionReviewListInput } from '../schemas/session.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type SessionReviewRow } from '../store/types.js';
import type { SessionKind } from '../store/session-kind.js';

/** Same shape every other tool module's local one has; `wrapHandler` keeps the code. */
class ToolError extends UserFacingError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

export interface MarkKindResult {
  kind: SessionKind;
  dryRun: boolean;
  /** Sessions that carried no kind at all and now do. The ordinary case. */
  newlyClassified: string[];
  /**
   * Sessions that already carried the OTHER kind and were flipped. Reported
   * separately because this is the destructive half: promoting a bench test to
   * training injects it into every calibration, and demoting a real workout
   * deletes a day from the lifter's own record. A day or range call leaves
   * these alone unless `reclassify` says otherwise.
   */
  reclassified: string[];
  /** Sessions already carrying the OTHER kind that were LEFT ALONE. */
  skippedAlreadyMarked: string[];
  /** Sessions that already carried the requested kind — idempotence, reported. */
  alreadyThisKind: string[];
  setsChanged: number;
  days: string[];
  /**
   * Exercises whose baseline and RIR fit were re-derived. On a dry run, the ones
   * that WOULD be. Never an exercise whose re-derivation threw — see
   * `rederiveFailed`, so the list cannot claim work it did not do.
   */
  rederived: string[];
  /**
   * Exercises whose re-derivation threw and whose baseline and RIR fit are now
   * STALE against the flag just written. The flag itself is durable and the fix
   * is `baselines.recalc` plus `rir_velocity.fit` per exercise; this is reported
   * rather than thrown because the marking succeeded and re-running it would
   * change nothing.
   */
  rederiveFailed: string[];
}

export interface ReviewListResult {
  days: ReviewDay[];
  /** Days with at least one session nobody has classified. */
  unreviewedDays: number;
}

/**
 * Mark sessions test or training, then re-derive what depended on them.
 *
 * Re-derivation is not optional bookkeeping: a set leaving the owner's pool
 * takes its evidence out of the baseline and the RIR-velocity fit, and a stale
 * curve fitted over bench tests is exactly what this task exists to remove.
 */
export async function markSessionKind(
  state: ServerState,
  input: z.infer<typeof SessionMarkKindInput>,
): Promise<MarkKindResult> {
  const rows = await state.store.listSessionReviewRows({ kind: 'any' });
  const selected = selectRows(rows, input);
  if (selected.length === 0) {
    throw new ToolError('NOT_FOUND', 'No sessions match that selector.');
  }
  // Naming one session IS the deliberate act, so it may always reclassify. A
  // day or a range is a bulk gesture over rows the caller has not looked at one
  // by one, so it only classifies the unreviewed unless asked for more.
  const mayReclassify = input.sessionId !== undefined || input.reclassify === true;
  const dryRun = input.dryRun === true;
  assertExpectedSessions(input, selected.length, dryRun);
  if (dryRun) {
    const rehearsed = selected.map((row) => ({
      ...row,
      kind: row.kind,
      written: row.kind === undefined || (mayReclassify && row.kind !== input.kind),
    }));
    return markResult(input.kind, true, selected, rehearsed);
  }
  // The write judges each row on its live kind, so a mark that landed after the read above wins.
  const write = await state.store.setSessionKindWhere(idsOf(selected), input.kind, {
    mayReclassify,
  });
  const bySession = new Map(selected.map((row) => [row.sessionId, row]));
  const judged = write.rows.flatMap((row) => {
    const read = bySession.get(row.sessionId);
    return read === undefined ? [] : [{ ...read, kind: row.priorKind, written: row.written }];
  });
  const result = {
    ...markResult(input.kind, false, selected, judged),
    setsChanged: write.setsChanged,
  };
  if (result.rederived.length === 0) return result;
  return { ...result, ...(await rederive(state, result.rederived)) };
}

/** A selected row as the write judged it: its kind before the write, and whether it was written. */
type JudgedRow = Omit<SessionReviewRow, 'kind'> & {
  kind: SessionKind | undefined;
  written: boolean;
};

/** The counts, from the rows the write judged; `setsChanged` is each row's set count. */
function markResult(
  kind: SessionKind,
  dryRun: boolean,
  selected: readonly SessionReviewRow[],
  rows: readonly JudgedRow[],
): MarkKindResult {
  const written = rows.filter((row) => row.written);
  const otherKind = (row: JudgedRow) => row.kind !== undefined && row.kind !== kind;
  return {
    kind,
    dryRun,
    newlyClassified: idsOf(written.filter((row) => row.kind === undefined)),
    reclassified: idsOf(written.filter(otherKind)),
    skippedAlreadyMarked: idsOf(rows.filter((row) => !row.written && otherKind(row))),
    alreadyThisKind: idsOf(rows.filter((row) => row.kind === kind)),
    setsChanged: written.reduce((total, row) => total + row.setCount, 0),
    days: [...new Set(selected.map((row) => reviewDayOf(row)))].sort(),
    rederived: exercisesOf(written),
    rederiveFailed: [],
  };
}

/**
 * A real multi-day range must say how many sessions it expects, and be right.
 *
 * A range is the one selector whose blast radius the caller cannot see before
 * running it, and a mistyped year marks a whole history in one call. The dry run
 * returns the number; passing it back is the caller confirming it read it. Only
 * the WRITE is gated — a dry run is how you learn the number.
 */
function assertExpectedSessions(
  input: z.infer<typeof SessionMarkKindInput>,
  matched: number,
  dryRun: boolean,
): void {
  if (dryRun || input.from === undefined) return;
  if (input.expectSessions === matched) return;
  throw new ToolError(
    'EXPECTED_SESSIONS_MISMATCH',
    `That range matches ${String(matched)} session(s). Re-run with ` +
      `expectSessions: ${String(matched)}, or run it with dryRun: true first.`,
  );
}

/** Session ids in the review list's own order: newest first, so a reader can scan them. */
function idsOf(rows: readonly { sessionId: string }[]): string[] {
  return rows.map((row) => row.sessionId);
}

/** The past local days and what each holds, newest first. */
export async function listSessionReview(
  state: ServerState,
  input: z.infer<typeof SessionReviewListInput>,
): Promise<ReviewListResult> {
  const rows = await state.store.listSessionReviewRows({ kind: input.kind ?? 'unreviewed' });
  const days = reviewDays(rows);
  return {
    days: days.slice(0, input.limit ?? 60),
    unreviewedDays: days.filter((day) => day.kind === 'unreviewed' || day.kind === 'mixed').length,
  };
}

/**
 * The rows one selector names. Days are `reviewDayOf` — the same rule the review
 * list groups by and the training-day count dates by — so the date the owner
 * reads off a row is the date he marks and the date the report files it under.
 */
function selectRows(
  rows: readonly SessionReviewRow[],
  input: z.infer<typeof SessionMarkKindInput>,
): SessionReviewRow[] {
  if (input.sessionId !== undefined) {
    return rows.filter((row) => row.sessionId === input.sessionId);
  }
  if (input.day !== undefined) {
    return rows.filter((row) => reviewDayOf(row) === input.day);
  }
  const from = input.from ?? '';
  const to = input.to ?? '';
  return rows.filter((row) => {
    const day = reviewDayOf(row);
    return day >= from && day <= to;
  });
}

function exercisesOf(rows: readonly Pick<SessionReviewRow, 'exerciseId'>[]): string[] {
  return [
    ...new Set(rows.flatMap((row) => (row.exerciseId === undefined ? [] : [row.exerciseId]))),
  ].sort();
}

/**
 * Re-derive each affected exercise's baseline and RIR-velocity fit, and say which
 * ones did not make it.
 *
 * Best effort on the WRITE, for the reason `set.update {lifter}`'s resync is: the
 * durable record is the flag on the row, and every derived value here is
 * re-derivable from it with `baselines.recalc` and `rir_velocity.fit`. Not best
 * effort on the REPORT — a failure used to leave the exercise sitting in
 * `rederived` as though it had succeeded, with only a stderr line to catch it.
 * A bulk mark over a whole history is exactly where nobody is reading stderr.
 */
async function rederive(
  state: ServerState,
  exerciseIds: readonly string[],
): Promise<{ rederived: string[]; rederiveFailed: string[] }> {
  const rederived: string[] = [];
  const rederiveFailed: string[] = [];
  for (const exerciseId of exerciseIds) {
    try {
      await state.store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId });
      await state.store.refitRirVelocityModel(LOCAL_USER_ID, exerciseId);
      rederived.push(exerciseId);
    } catch (err) {
      log.warn(`re-derivation failed for ${exerciseId} after marking session kind`, err);
      rederiveFailed.push(exerciseId);
    }
  }
  return { rederived, rederiveFailed };
}
