// The `feel` check-in answer (VW-993): how a session felt, -5 to +5. It only describes the session
// when given close to it, so an answer given after the capture window, or on a session with no set,
// is withheld rather than stored.

import { RETURN_FEEL_CAPTURE_MINUTES } from '../analytics/re-entry.js';
import type { SessionStore } from '../store/types.js';

const MINUTE_MS = 60 * 1000;

/** Whether `now` is inside the capture window after the session's last set ended. */
export async function feelOnTime(
  store: Pick<SessionStore, 'getSetsForSession'>,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const sets = await store.getSetsForSession(sessionId);
  const lastEndedMs = Math.max(...sets.map((set) => Date.parse(set.endedAt)));
  if (!Number.isFinite(lastEndedMs)) return false;
  return now.getTime() - lastEndedMs <= RETURN_FEEL_CAPTURE_MINUTES.value * MINUTE_MS;
}
