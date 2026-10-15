/**
 * The review-days calls (VW-847 S3). Reads go through `readJson` and writes through VW-894's
 * `postAction`, so the action id, the stale-token retry and `ActionRefusedError` are not
 * reimplemented here.
 */
import { postAction, readJson, type ActionResponse } from '../api-client.js';
import type { SessionReviewPage } from '../../session-review-api.js';
import {
  expectSessions,
  flowStepOf,
  markInput,
  settleFailure,
  type AttemptIds,
  type MarkResult,
  type PreviewGate,
  type Selection,
} from './days-model.js';

/** `GET /api/session-review`: waiting days by default, every day with `kind: 'any'`. */
export function fetchSessionReview(
  kind: 'unreviewed' | 'any' = 'unreviewed',
  limit?: number,
): Promise<SessionReviewPage> {
  const params = new URLSearchParams({ kind });
  if (limit !== undefined) params.set('limit', String(limit));
  return readJson<SessionReviewPage>(`/api/session-review?${params.toString()}`);
}

/** Thrown for a confirm with no fresh preview of the selection behind it. */
export class NoFreshPreviewError extends Error {
  constructor() {
    super('Preview this selection before confirming it');
    this.name = 'NoFreshPreviewError';
  }
}

export interface MarkPost {
  selection: Selection;
  phase: 'preview' | 'mark';
  flowId: string;
  ids: AttemptIds;
  gate: PreviewGate;
}

/** A mark's input carries the count of the gate's current preview, or the post does not happen. */
function inputOf(post: MarkPost): Record<string, unknown> {
  if (post.phase === 'preview') return markInput(post.selection, 'preview');
  const preview = post.gate.previewFor(post.selection);
  if (preview === null) throw new NoFreshPreviewError();
  return markInput(post.selection, 'mark', expectSessions(preview));
}

/**
 * Post one preview or mark. A preview is recorded in the gate and a mark needs one. The id
 * comes from `ids`: Retry after a transport failure reuses it, and a settled outcome (success or
 * a tool refusal) ends the attempt so a repeat is a new post, never a replay of the old answer.
 */
export async function postMarkKind(post: MarkPost): Promise<MarkResult> {
  const flowStep = flowStepOf(post.selection, post.phase);
  const input = inputOf(post);
  try {
    const response: ActionResponse<MarkResult> = await postAction<MarkResult>(
      'session.mark_kind',
      input,
      { actionId: post.ids.idFor(flowStep, input), flowId: post.flowId, flowStep },
    );
    post.ids.forget(flowStep);
    if (post.phase === 'preview') post.gate.record(post.selection, response.result);
    else post.gate.clear();
    return response.result;
  } catch (err) {
    settleFailure(err, flowStep, post.ids, post.gate);
    throw err;
  }
}
