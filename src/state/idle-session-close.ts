// Closes sessions nobody ended (VW-856). A session that was never ended is
// invisible to every reader that wants an ended one, so a forgotten session
// leaks out of the day it belongs to.
//
// Two triggers share one rule. At boot, a fresh process holds no connected
// device, no open set and no live session, so nothing the store shows open can
// be live. In a long-lived process, the first rep or session start after a long
// pause ends the stale in-memory session at its last rep before the new
// activity attaches. Neither runs while a set is open.

import { getSlot, type ServerState } from './server-state.js';
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

function isIdle(lastRepAt: string, now: Date): boolean {
  return Date.parse(lastRepAt) <= now.getTime() - IDLE_SESSION_CLOSE_HOURS * HOUR_MS;
}

function closedNote(session: StoredSession): string {
  const note = `Closed by ${IDLE_SESSION_CLOSER}: no rep for ${String(IDLE_SESSION_CLOSE_HOURS)} h.`;
  return session.notes === undefined || session.notes === '' ? note : `${session.notes}\n${note}`;
}

async function endAtLastRep(
  store: SessionStore,
  session: StoredSession,
  lastRepAt: string,
): Promise<void> {
  await store.putSession({ ...session, endedAt: lastRepAt, notes: closedNote(session) });
}

/**
 * End every open session, whoever the lifter, whose last rep is at least
 * {@link IDLE_SESSION_CLOSE_HOURS} old, stamping `endedAt` with that last rep
 * (not `now`) so a session that ran past midnight stays on its own day. The
 * closer is written into the session's notes through `putSession`, the same
 * path `session.end` uses. A session with no rep ends at its start. Returns
 * the ids it closed.
 */
export async function closeIdleSessions(store: SessionStore, now: Date): Promise<string[]> {
  const closed: string[] = [];
  for (const session of await store.listOpenSessions()) {
    const lastRepAt = (await store.getLastRepAt(session.id)) ?? session.startedAt;
    if (!isIdle(lastRepAt, now)) continue;
    await endAtLastRep(store, session, lastRepAt);
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

/** Note a rep the idle pipeline saw, so a stale live session can be told from a busy one. */
export function noteLiveRep(state: ServerState, slotId: string, at: Date): void {
  state.lastIdleRepAtMs?.set(slotId, at.getTime());
}

/** The newest of the session's start, its last idle rep and its last set end on the slot. */
function liveLastRepAt(state: ServerState, slotId: string, startedAt: string): string {
  const startMs = Date.parse(startedAt);
  const candidates = [
    startMs,
    state.lastIdleRepAtMs?.get(slotId) ?? 0,
    (state.lastSetEndedAtMs as Map<string, number> | undefined)?.get(slotId) ?? 0,
  ].filter((ms) => ms >= startMs);
  return new Date(Math.max(...candidates)).toISOString();
}

/**
 * If the slot's live session has had no rep for the idle window and no set is
 * open, drop it from memory NOW (so the caller sees no session) and return the
 * promise that persists its end at the last rep. `undefined` means the session
 * is live, or there is none, and nothing was touched.
 */
export function endStaleLiveSession(
  state: ServerState,
  slotId: string,
  now: Date,
): Promise<void> | undefined {
  const slot = getSlot(state, slotId);
  const session = slot.live.session;
  if (session === undefined || slot.live.set !== undefined) return undefined;
  const lastRepAt = liveLastRepAt(state, slotId, session.startedAt);
  if (!isIdle(lastRepAt, now)) return undefined;
  slot.live.endSession();
  return persistEnd(state.store, session.sessionId, lastRepAt);
}

async function persistEnd(
  store: SessionStore,
  sessionId: string,
  lastRepAt: string,
): Promise<void> {
  try {
    const stored = await store.getSession(sessionId);
    if (stored !== undefined && stored.endedAt === undefined) {
      await endAtLastRep(store, stored, lastRepAt);
    }
  } catch (err) {
    log.warn('idle-session close: persisting the end failed', err);
  }
}
