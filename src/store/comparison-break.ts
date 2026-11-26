// Whether the sessions of one cross-session comparison span a layoff (VW-975).
//
// The days read are the compared sessions' own days plus every training day of the same lifter
// between them, so training on other lifts in between closes the gap the way `re-entry.ts`
// counts it. The compared sessions are read whatever their kind: a diagnostic may be asked about
// sessions the training-day rule would not count.

import { longestBreak } from '../analytics/layoff-break.js';
import { trainingDaysOf, type TrainingGap } from '../analytics/training-days.js';
import type { SessionStore, StoredSession } from './types.js';

export type ComparisonBreakStore = Pick<SessionStore, 'getSession' | 'listTrainingDayInstants'>;

/** The longest break between the given sessions, or `null` when none spans 15+ days. */
export async function breakBetweenSessions(
  store: ComparisonBreakStore,
  sessionIds: readonly string[],
  lifter?: string,
): Promise<TrainingGap | null> {
  const found = await Promise.all(sessionIds.map((id) => store.getSession(id)));
  const sessions = found.filter((session): session is StoredSession => session !== undefined);
  if (sessions.length < 2) return null;
  const starts = sessions.map((session) => session.startedAt).sort();
  const ends = sessions.map((session) => session.endedAt ?? session.startedAt).sort();
  const between = await store.listTrainingDayInstants({
    from: starts[0]!,
    to: ends[ends.length - 1]!,
    ...(lifter !== undefined ? { lifter } : {}),
  });
  return longestBreak(trainingDaysOf([...ends, ...between]));
}
