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

import { localDate } from '../analytics/training-days.js';
import { reviewDays, type ReviewDay } from '../analytics/session-review.js';
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
  /** Sessions the selector matched that do not already carry `kind`. */
  sessionsChanged: number;
  /** Sessions the selector matched that already carried it — idempotence, reported. */
  sessionsAlready: number;
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
  const pending = selected.filter((row) => row.kind !== input.kind);
  const dryRun = input.dryRun === true;
  const result: MarkKindResult = {
    kind: input.kind,
    dryRun,
    sessionsChanged: pending.length,
    sessionsAlready: selected.length - pending.length,
    setsChanged: pending.reduce((total, row) => total + row.setCount, 0),
    days: [...new Set(selected.map((row) => localDate(row.startedAt)))].sort(),
    rederived: exercisesOf(pending),
  };
  if (dryRun || pending.length === 0) return result;

  await state.store.setSessionKind(
    pending.map((row) => row.sessionId),
    input.kind,
  );
  await rederive(state, result.rederived);
  return result;
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
 * The rows one selector names. Days are LOCAL days of the session's START, the
 * same grouping the review list shows, so the date the owner reads off a row is
 * the date he can mark.
 */
function selectRows(
  rows: readonly SessionReviewRow[],
  input: z.infer<typeof SessionMarkKindInput>,
): SessionReviewRow[] {
  if (input.sessionId !== undefined) {
    return rows.filter((row) => row.sessionId === input.sessionId);
  }
  if (input.day !== undefined) {
    return rows.filter((row) => localDate(row.startedAt) === input.day);
  }
  const from = input.from ?? '';
  const to = input.to ?? '';
  return rows.filter((row) => {
    const day = localDate(row.startedAt);
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
