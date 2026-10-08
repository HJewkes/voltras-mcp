// Closes sessions nobody ended (VW-856). A session that was never ended is
// invisible to every reader that wants an ended one, so a forgotten session
// leaks out of the day it belongs to.
//
// Runs once, at boot, and only there: a fresh process holds no connected
// device, no open set and no live session, so nothing it finds in the store can
// be live. Mid-run the rule would have to prove that, and the cheapest proof is
// not running.

import type { SessionStore, StoredSession } from '../store/types.js';
import { log } from '../logger.js';

/**
 * Hours without a rep before an unended session counts as abandoned. Six hours
 * outlasts a long session with a meal in the middle, yet closes the same day's
 * forgotten session before the next morning.
 */
export const IDLE_SESSION_CLOSE_HOURS = 6;

export const IDLE_SESSION_CLOSER = 'rule:idle';

const HOUR_MS = 3_600_000;
const SESSION_SCAN_LIMIT = 1000;

/** The instant of the session's last rep: a counted set's end or an idle rep, else its start. */
async function lastRepAt(store: SessionStore, session: StoredSession): Promise<string> {
  const sets = await store.getSetsForSession(session.id);
  const idle = await store.listIdleReps({ sessionId: session.id });
  const instants = [
    ...sets.filter((s) => s.reps.length > 0).map((s) => s.endedAt),
    ...idle.map((r) => r.observedAt),
  ];
  return instants.reduce((latest, at) => (at > latest ? at : latest), session.startedAt);
}

function closedNote(session: StoredSession): string {
  const note = `Closed by ${IDLE_SESSION_CLOSER}: no rep for ${String(IDLE_SESSION_CLOSE_HOURS)} h.`;
  return session.notes === undefined || session.notes === '' ? note : `${session.notes}\n${note}`;
}

/**
 * End every owner session still open whose last rep is at least
 * {@link IDLE_SESSION_CLOSE_HOURS} old, stamping `endedAt` with that last rep
 * (not `now`) so a session that ran past midnight stays on its own day. The
 * closer is written into the session's notes through `putSession`, the same
 * path `session.end` uses. Returns the ids it closed.
 */
export async function closeIdleSessions(store: SessionStore, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - IDLE_SESSION_CLOSE_HOURS * HOUR_MS;
  const open = (await store.listSessions({ kind: 'any', limit: SESSION_SCAN_LIMIT })).filter(
    (s) => s.endedAt === undefined,
  );
  const closed: string[] = [];
  for (const session of open) {
    const lastRep = await lastRepAt(store, session);
    if (Date.parse(lastRep) > cutoff) continue;
    await store.putSession({ ...session, endedAt: lastRep, notes: closedNote(session) });
    closed.push(session.id);
  }
  return closed;
}

/** Boot hook: a failure leaves the sessions open rather than failing the boot. */
export async function closeIdleSessionsAtBoot(store: SessionStore): Promise<void> {
  try {
    const closed = await closeIdleSessions(store, new Date());
    if (closed.length > 0) log.info(`closed ${String(closed.length)} idle session(s) by rule`);
  } catch (err) {
    log.warn('bootstrapState: closing idle sessions failed', err);
  }
}
