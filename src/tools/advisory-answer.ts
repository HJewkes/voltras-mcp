// The one door every advisory answer goes through (VW-587).
//
// The store records the first answer to reach an unanswered row and refuses
// the rest, so an answer is never read as open and then written over another.
// A caller that lost is told so, with the answer that stands, never a silent
// success.
//
// Confidentiality: coaching metadata only, no protocol data.

import type {
  AdvisoryAnswer,
  AdvisoryAnswerRetire,
  SessionStore,
  StoredAdvisoryDecision,
  StoredAdvisoryResponse,
} from '../store/types.js';

export type AdvisoryAnswerOutcome =
  | { kind: 'answered'; decision: StoredAdvisoryDecision }
  | { kind: 'already_answered'; standing?: StoredAdvisoryResponse };

type AnswerStore = Pick<SessionStore, 'answerAdvisoryIfOpen' | 'listAdvisoryDecisions'>;

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

/** Answer `open` if nothing else has; `retire` happens only with a recorded answer. */
export async function answerIfOpen(
  store: AnswerStore,
  open: StoredAdvisoryDecision,
  answer: AdvisoryAnswer,
  retire?: AdvisoryAnswerRetire,
): Promise<AdvisoryAnswerOutcome> {
  const decision = await store.answerAdvisoryIfOpen(open.id, answer, retire);
  if (decision !== undefined) return { kind: 'answered', decision };
  return lostAnswer(store, open);
}

/** What a caller whose answer to `open` was not recorded is told: the answer that stands. */
export async function lostAnswer(
  store: Pick<SessionStore, 'listAdvisoryDecisions'>,
  open: StoredAdvisoryDecision,
): Promise<Extract<AdvisoryAnswerOutcome, { kind: 'already_answered' }>> {
  const stored = (await store.listAdvisoryDecisions(open.userId, { code: open.code })).find(
    (row) => row.id === open.id,
  );
  return stored?.userResponse === undefined
    ? { kind: 'already_answered' }
    : { kind: 'already_answered', standing: stored.userResponse };
}

/** The refusal a lifter's losing answer gets: what they answered is not what was recorded. */
export function alreadyAnsweredError(
  subject: string,
  standing: StoredAdvisoryResponse | undefined,
): Error {
  const recorded = standing === undefined ? '' : ` as ${standing}`;
  return new ToolError(
    'ADVISORY_ALREADY_ANSWERED',
    `${subject} was already answered${recorded} by another call, so this answer was not ` +
      'recorded. The first answer stands; re-read before answering again.',
  );
}
