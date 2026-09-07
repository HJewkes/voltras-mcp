// Auto-arm (VW-164) — open a set on the first idle rep of an open session.
//
// Reps begin within ~1s of a weight change on the unit, while `set.start`
// needs a model turn plus a tool round-trip. The 2026-09-07 dogfood lost 2-5
// reps at the head of most sets to that gap and fired 30+ `idle_rep_summary`
// events instead. When a session is open on the slot and nothing else is
// recording, the server has everything it needs to open the set itself.
//
// The rep that triggered the arm is NOT dropped: `adoptIdleTail` moves it (and
// the in-progress rep behind it) out of the idle pipeline and into the new
// set, so rep 1 is the rep the lifter actually performed. From there the
// normal active-set path in event-bridge takes over.
//
// Opt out with `VMCP_AUTO_ARM=off`; `server.health` reports the live value.

import { randomUUID } from 'node:crypto';

import { buildSetStartedPayload } from './channel-payloads.js';
import type { ActiveSet } from './live-state.js';
import { getSlot, type ServerState } from './server-state.js';

/**
 * Reps handed from the idle pipeline to the freshly-armed set: the rep that
 * just closed (the trigger) and the in-progress rep opened behind it by the
 * same eccentric→concentric transition.
 */
const ADOPTED_IDLE_REP_COUNT = 2;

/**
 * Open a set on `slotId` because an idle rep landed with a session active.
 * Returns true when a set was armed, false when the conditions don't hold
 * (auto-arm off, no session, a set already recording) and the caller should
 * fall through to the ordinary idle-rep reporting path.
 *
 * The device motor is deliberately NOT engaged: the lifter is already lifting
 * — that is what produced the rep — so there is nothing to engage, and a
 * strength-mode GO mid-rep would be a load change nobody asked for. Mirrors
 * the guided-load bootstrap, which also mints its set without re-engaging.
 */
export function autoArmSet(state: ServerState, slotId: string): boolean {
  if (state.config?.autoArm === 'off') return false;
  const slot = getSlot(state, slotId);
  const session = slot.live.session;
  if (session === undefined || slot.live.set !== undefined) return false;

  const setId = randomUUID();
  const startedAt = new Date().toISOString();
  slot.live.startSet({
    setId,
    sessionId: session.sessionId,
    startedAt,
    reps: [],
    status: 'active',
    autoCreatedBy: 'idle_rep',
    ...(session.exerciseId !== undefined ? { exerciseId: session.exerciseId } : {}),
  });
  slot.live.adoptIdleTail(ADOPTED_IDLE_REP_COUNT);
  const device = slot.live.snapshotDevice();
  state.setStartDeviceSnapshots.set(setId, device);
  publishAutoArmed(state, slotId, setId, startedAt, session.sessionId);
  return true;
}

/**
 * Publish the `set_started` push and the dashboard SSE echo for an auto-armed
 * set. `previous_set_summary` is null rather than fetched: this runs inside
 * the synchronous frame handler, and awaiting a store read here would let rep
 * events for the new set overtake its own `set_started`.
 */
function publishAutoArmed(
  state: ServerState,
  slotId: string,
  setId: string,
  startedAt: string,
  sessionId: string,
): void {
  const slot = getSlot(state, slotId);
  const ordinal = (slot.live.snapshotSession()?.setIds.length ?? 0) + 1;
  const activeSet: ActiveSet = { setId, sessionId, startedAt, reps: [], status: 'active' };
  const payload = buildSetStartedPayload(activeSet, slot.live.snapshotDevice(), ordinal, null, {
    autoArmed: true,
  });
  state.channels.forSlot(slotId).publish(payload);
  state.liveSignals?.emit({
    type: 'set',
    data: { slot: slotId, kind: 'started', setId, sessionId },
  });
  state.restTimers.cancel(slotId, 'next_set');
}
