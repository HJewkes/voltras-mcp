// `accountability.declare_commitment` — the lifter's own commitment for one week (VW-505).
//
// TWO RECORDS, ONE OWNER EACH. The `sessions_28d` goal target owns HOW MANY sessions, banded
// and accepted through `goal.propose_targets` / `goal.accept_target`. This tool owns WHICH
// DAYS, the named fallback for each, the if-then sentence and the commitment in the lifter's
// own words. It states no number of its own, never reads a goal target and never refuses on
// one's behalf: coupling them would give the count two writers.
//
// The two sentences are the LIFTER's. They are stored byte for byte and rendered byte for
// byte — no trim, no tightening, no paraphrase — because a commitment in someone else's words
// carries none of the weight the whole mechanism depends on (LIT section 1.2).

import { commitmentWeekOf } from '../accountability/commitment-week.js';
import { isIsoDate, isMonday } from '../plan/block-calendar.js';
import { mondaysAround } from '../plan/block-placement.js';
import type { AccountabilityDeclareCommitmentInput } from '../schemas/accountability.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type CommitmentDay, type StoredCommitment } from '../store/types.js';
import type { z } from 'zod';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

export const ACCOUNTABILITY_DECLARE_COMMITMENT_DESCRIPTION =
  "Record the lifter's own training commitment for one week: which days, the named fallback " +
  'day for each, the if-then sentence, and the commitment in their own words. `ifThen` and ' +
  '`wording` are stored and rendered VERBATIM — never rewrite, tighten or paraphrase them, ' +
  'and never write your own words into them. `weekOf` is a local Monday and defaults to the ' +
  'week being committed to (a declaration made on a Sunday files against the next day). ' +
  'Declaring again for the same week is a CORRECTION: it appends the next `revision` and ' +
  'keeps the superseded wording; an identical declaration writes nothing and returns ' +
  '`unchanged: true`. Returns `weekOf`, `revision`, `days`, `ifThen`, `wording` and ' +
  '`unchanged`. This tool does NOT set how many sessions a week — that is the attendance goal ' +
  'target, via `goal.propose_targets` and `goal.accept_target`. Local write, no device traffic, ' +
  'no network.';

/** The commitment as the tool surface reports it: the lifter's four answers and their revision. */
export interface CommitmentRead {
  weekOf: string;
  revision: number;
  days: CommitmentDay[];
  ifThen: string;
  wording: string;
  declaredAt: string;
}

export interface DeclareCommitmentResult extends CommitmentRead {
  /** True when this declaration matched the week's latest revision and wrote nothing. */
  unchanged: boolean;
}

export function commitmentRead(stored: StoredCommitment): CommitmentRead {
  return {
    weekOf: stored.effectiveFrom,
    revision: stored.revision,
    days: stored.days,
    ifThen: stored.ifThen,
    wording: stored.wording,
    declaredAt: stored.declaredAt,
  };
}

export async function declareCommitment(
  state: ServerState,
  input: z.infer<typeof AccountabilityDeclareCommitmentInput>,
  now: Date = new Date(),
): Promise<DeclareCommitmentResult> {
  assertDistinctDays(input.days);
  assertOwnWords(input.ifThen, 'The if-then sentence');
  assertOwnWords(input.wording, 'The commitment wording');
  const weekOf = input.weekOf === undefined ? commitmentWeekOf(now) : assertMonday(input.weekOf);
  const declared = await state.store.declareCommitment({
    userId: LOCAL_USER_ID,
    effectiveFrom: weekOf,
    days: input.days.map((entry) => ({ day: entry.day, fallbackDay: entry.fallbackDay })),
    ifThen: input.ifThen,
    wording: input.wording,
    declaredAt: now.toISOString(),
  });
  return { ...commitmentRead(declared.commitment), unchanged: declared.unchanged };
}

/**
 * A day may be the fallback for another committed day — real schedules do that — but it may
 * not be its own fallback, and no day may be committed twice.
 */
function assertDistinctDays(days: readonly CommitmentDay[]): void {
  const seen = new Set<string>();
  for (const entry of days) {
    if (entry.fallbackDay === entry.day) {
      throw new ToolError(
        'INVALID_INPUT',
        `A fallback day cannot be the day it falls back from (${entry.day}). Name a different day.`,
      );
    }
    if (seen.has(entry.day)) {
      throw new ToolError(
        'INVALID_INPUT',
        `${entry.day} is committed twice. Name each training day once.`,
      );
    }
    seen.add(entry.day);
  }
}

/** Whitespace-only is refused; everything else is stored exactly as given, spaces included. */
function assertOwnWords(text: string, subject: string): void {
  if (text.trim().length > 0) return;
  throw new ToolError('INVALID_INPUT', `${subject} is the lifter's own and cannot be empty.`);
}

function assertMonday(date: string): string {
  if (!isIsoDate(date)) {
    throw new ToolError('INVALID_INPUT', `weekOf ${date} is not a calendar date.`);
  }
  if (isMonday(date)) return date;
  const { before, after } = mondaysAround(date);
  throw new ToolError(
    'INVALID_INPUT',
    `A commitment week starts on a Monday; ${date} is not one. ` +
      `The Mondays either side are ${before} and ${after}.`,
  );
}
