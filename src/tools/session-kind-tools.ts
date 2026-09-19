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

import type { z } from 'zod';

import { reviewDayOf, reviewDays, type ReviewDay } from '../analytics/session-review.js';
import { log } from '../logger.js';
import type { SessionMarkKindInput, SessionReviewListInput } from '../schemas/session.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type SessionReviewRow } from '../store/types.js';
import type { SessionKind } from '../store/session-kind.js';

/** Same shape every other tool module's local one has; `wrapHandler` keeps the code. */
class ToolError extends Error {
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
  /** Exercises whose baseline and RIR fit were re-derived, or would be on a real run. */
  rederived: string[];
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
  const unreviewed = selected.filter((row) => row.kind === undefined);
  const otherKind = selected.filter((row) => row.kind !== undefined && row.kind !== input.kind);
  const pending = mayReclassify ? [...unreviewed, ...otherKind] : unreviewed;

  const dryRun = input.dryRun === true;
  const result: MarkKindResult = {
    kind: input.kind,
    dryRun,
    newlyClassified: idsOf(unreviewed),
    reclassified: mayReclassify ? idsOf(otherKind) : [],
    skippedAlreadyMarked: mayReclassify ? [] : idsOf(otherKind),
    alreadyThisKind: idsOf(selected.filter((row) => row.kind === input.kind)),
    setsChanged: pending.reduce((total, row) => total + row.setCount, 0),
    days: [...new Set(selected.map((row) => reviewDayOf(row)))].sort(),
    rederived: exercisesOf(pending),
  };
  assertExpectedSessions(input, selected.length, dryRun);
  if (dryRun || pending.length === 0) return result;

  await state.store.setSessionKind(idsOf(pending), input.kind);
  await rederive(state, result.rederived);
  return result;
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
function idsOf(rows: readonly SessionReviewRow[]): string[] {
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

function exercisesOf(rows: readonly SessionReviewRow[]): string[] {
  return [
    ...new Set(rows.flatMap((row) => (row.exerciseId === undefined ? [] : [row.exerciseId]))),
  ].sort();
}

/**
 * Re-derive each affected exercise's baseline and RIR-velocity fit.
 *
 * Best effort, for the reason `set.update {lifter}`'s resync is: the durable
 * record is the flag on the row, and every derived value here is re-derivable
 * from it with `baselines.recalc` and `rir_velocity.fit`.
 */
async function rederive(state: ServerState, exerciseIds: readonly string[]): Promise<void> {
  for (const exerciseId of exerciseIds) {
    try {
      await state.store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId });
      await state.store.refitRirVelocityModel(LOCAL_USER_ID, exerciseId);
    } catch (err) {
      log.warn(`re-derivation failed for ${exerciseId} after marking session kind`, err);
    }
  }
}
