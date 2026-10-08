// `GET /api/session-review` (VW-899, S2 of VW-847): the past local days, each
// reduced to what it takes to mark it training or test from the wall.
//
// No arithmetic of its own. The days are `reviewDays`, the same grouping
// `session.review_list` serves, and "waiting" is `readUnreviewed`, the read
// behind `/api/goals` `review.unreviewedDays`. So the goals line, the tool and
// the review screen cannot disagree about which days still need a mark.

import {
  readUnreviewed,
  reviewDays,
  type ReviewDay,
  type UnreviewedStore,
} from '../analytics/session-review.js';

/** `unreviewed` lists the days still waiting for a mark; `any` lists every day. */
export type SessionReviewListKind = 'unreviewed' | 'any';

export const SESSION_REVIEW_DEFAULT_LIMIT = 60;
/** Any larger `?limit=` is clamped to this, as `/api/activity` does. */
export const SESSION_REVIEW_MAX_LIMIT = 200;

export interface SessionReviewQuery {
  kind: SessionReviewListKind;
  limit: number;
}

export interface SessionReviewPage {
  /** Newest first, at most `limit` of them. */
  days: ReviewDay[];
  /** Every waiting day, not only the ones on this page. Equals `/api/goals` `review.unreviewedDays`. */
  unreviewedDays: number;
}

const LIST_KINDS: readonly SessionReviewListKind[] = ['unreviewed', 'any'];

/** Parse the query string, or say which parameter is wrong. */
export function parseSessionReviewQuery(
  params: URLSearchParams,
): SessionReviewQuery | { error: string } {
  const kind = params.get('kind') ?? 'unreviewed';
  if (!LIST_KINDS.includes(kind as SessionReviewListKind)) {
    return { error: 'kind must be unreviewed or any' };
  }
  const limit = parseLimit(params.get('limit'));
  if (limit === undefined) return { error: 'limit must be a positive integer' };
  return { kind: kind as SessionReviewListKind, limit };
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return SESSION_REVIEW_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  if (parsed <= 0) return undefined;
  return Math.min(parsed, SESSION_REVIEW_MAX_LIMIT);
}

/**
 * One page of review days. A waiting day is served whole, marked sessions
 * included, so a day that is half training reads `mixed` rather than
 * `unreviewed` and the screen can say what a mark would leave alone.
 */
export async function readSessionReview(
  store: UnreviewedStore,
  query: SessionReviewQuery,
): Promise<SessionReviewPage> {
  const rows = await store.listSessionReviewRows({ kind: 'any' });
  const waiting = await readUnreviewed(store);
  const waitingDays = new Set(waiting.unreviewedDayList);
  const days = reviewDays(rows).filter((day) => query.kind === 'any' || waitingDays.has(day.day));
  return { days: days.slice(0, query.limit), unreviewedDays: waiting.unreviewedDays };
}
