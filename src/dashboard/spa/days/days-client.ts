/**
 * The review-days calls (VW-847 S3). Reads go through `readJson` and writes through VW-894's
 * `postAction`, so the action id, the stale-token retry and `ActionRefusedError` are not
 * reimplemented here.
 */
import type { ReviewDay } from '../../../analytics/session-review.js';
import { postAction, readJson, type ActionResponse } from '../api-client.js';
import {
  flowStepOf,
  markInput,
  type AttemptIds,
  type MarkResult,
  type Selection,
} from './days-model.js';

export interface SessionReviewPage {
  days: ReviewDay[];
  unreviewedDays: number;
}

/** `GET /api/session-review`: waiting days by default, every day with `kind: 'any'`. */
export function fetchSessionReview(
  kind: 'unreviewed' | 'any' = 'unreviewed',
  limit?: number,
): Promise<SessionReviewPage> {
  const params = new URLSearchParams({ kind });
  if (limit !== undefined) params.set('limit', String(limit));
  return readJson<SessionReviewPage>(`/api/session-review?${params.toString()}`);
}

export interface MarkPost {
  selection: Selection;
  phase: 'preview' | 'mark';
  /** Required for a range mark: the preview's `expectSessions`. */
  expected?: number;
  flowId: string;
  ids: AttemptIds;
}

/**
 * Post one preview or mark. The id comes from `ids`, so Retry with the same input reuses it and
 * an edited selection mints a new one.
 */
export async function postMarkKind(post: MarkPost): Promise<MarkResult> {
  const flowStep = flowStepOf(post.selection, post.phase);
  const input = markInput(post.selection, post.phase, post.expected);
  const response: ActionResponse<MarkResult> = await postAction<MarkResult>(
    'session.mark_kind',
    input,
    { actionId: post.ids.idFor(flowStep, input), flowId: post.flowId, flowStep },
  );
  return response.result;
}
