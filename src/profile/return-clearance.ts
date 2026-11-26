// The return clearance question (VW-976): after a break for illness, injury or a procedure, the
// coach asks once whether the lifter has been cleared to lift, and this stores only which of three
// answers they gave and on what day.
//
// There is deliberately no field for what a limit is. `cleared_with_limit` records that a limit
// exists; the lifter keeps the detail. That is a privacy boundary: this server never reads, stores
// or reasons about the medical side of a return, so it has nothing to leak and nothing to
// misinterpret.

export const RETURN_CLEARANCES = ['cleared', 'cleared_with_limit', 'not_yet'] as const;

export type ReturnClearanceAnswer = (typeof RETURN_CLEARANCES)[number];

export interface StoredReturnClearance {
  readonly answer: ReturnClearanceAnswer;
  /** The local date the lifter gave the answer, 'YYYY-MM-DD'. */
  readonly answeredOn: string;
}

export function isReturnClearanceAnswer(value: unknown): value is ReturnClearanceAnswer {
  return (RETURN_CLEARANCES as readonly unknown[]).includes(value);
}

/**
 * The answer that stands after `incoming`: the later-dated one, so a backdated correction never
 * buries a newer answer. On the same day the new call wins, which is how a lifter fixes a slip.
 */
export function latestReturnClearance(
  existing: StoredReturnClearance | undefined,
  incoming: StoredReturnClearance,
): StoredReturnClearance {
  if (existing !== undefined && existing.answeredOn > incoming.answeredOn) return existing;
  return incoming;
}

export const RETURN_NOT_CLEARED_REASON =
  'Not cleared to train yet: the latest answer to the return clearance question is "not yet". ' +
  'Hold working sessions until the lifter says they are cleared, then record that answer.';

/** Why working sessions are held, or `null`: only a standing "not yet" during a return holds them. */
export function clearanceBlock(
  clearance: StoredReturnClearance | undefined,
  returnOpen: boolean,
): string | null {
  return returnOpen && clearance?.answer === 'not_yet' ? RETURN_NOT_CLEARED_REASON : null;
}
