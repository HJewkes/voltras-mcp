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
// VW-181: the arm waits for a SECOND closed rep before it fires. The
// 2026-09-07 dogfood opened most sets with a rope-positioning pull, and arming
// on it made the pull rep 1 of the set, the velocity-loss baseline, and the
// event that cancelled the rest timer. One rep tells us nothing about itself;
// the rep after it does. When the two agree, both are adopted and no rep is
// lost — the wait costs the couple of seconds until the next rep begins.
//
// Opt out with `VMCP_AUTO_ARM=off`; `server.health` reports the live value.

import { randomUUID } from 'node:crypto';
import type { Rep } from '@voltras/workout-analytics';

import { buildSetStartedPayload } from './channel-payloads.js';
import { movementClassForExerciseId } from '../exercises/movement-class.js';
import type { ActiveSet, IdleRepReclaim } from './live-state.js';
import { isTailPairConsistent } from './rep-eligibility.js';
import { getSlot, type ServerState } from './server-state.js';

/**
 * Reps adopted when the rep before the trigger corroborates it: that rep, the
 * trigger rep, and the in-progress rep opened behind the trigger by the same
 * eccentric→concentric transition. Nothing the lifter performed is lost.
 */
const ADOPTED_WITH_CORROBORATION = 3;

/**
 * Reps adopted when the rep before the trigger contradicts it (VW-181): the
 * trigger rep and the in-progress one only. The contradicting rep — the
 * rope-positioning pull of the 2026-09-07 dogfood — stays in the idle ledger
 * and is still reported through `idle_rep_summary`.
 */
const ADOPTED_WITHOUT_CORROBORATION = 2;

/**
 * Outcome of one arm attempt. When it armed, `reclaimed` describes the
 * idle-rep ledger entries the new set adopted: the caller subtracts the
 * `pending` ones from its `idle_rep_summary` batch so the same rep isn't
 * reported as lost work and counted into the set, and corrects the `published`
 * ones on the wire (VW-185) because their summary already went out.
 */
export type AutoArmResult =
  | { armed: false }
  | { armed: true; setId: string; reclaimed: IdleRepReclaim };

const NOT_ARMED: AutoArmResult = { armed: false };

/**
 * Open a set on `slotId` because an idle rep landed with a session active.
 * Returns `armed: true` when a set was opened; when it wasn't (auto-arm off,
 * no session, a set already recording, or a window that can't yet tell work
 * from a positioning pull) the caller falls through to the ordinary idle-rep
 * reporting path and nothing is lost.
 *
 * The device motor is deliberately NOT engaged: the lifter is already lifting
 * — that is what produced the rep — so there is nothing to engage, and a
 * strength-mode GO mid-rep would be a load change nobody asked for. Mirrors
 * the guided-load bootstrap, which also mints its set without re-engaging.
 */
export function autoArmSet(state: ServerState, slotId: string): AutoArmResult {
  if (state.config?.autoArm === 'off') return NOT_ARMED;
  const slot = getSlot(state, slotId);
  const session = slot.live.session;
  if (session === undefined || slot.live.set !== undefined) return NOT_ARMED;

  const adopt = repsToAdopt(slot.live.idleTailClosedReps(2));
  if (adopt === null) return NOT_ARMED;

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
    // VMCP-02.63: stamped from the same pointer, in the same tick.
    movementClass: movementClassForExerciseId(session.exerciseId),
    // VW-169: an auto-armed set inherits the session's lifter default. The
    // whole point of the default is that the reps a guest starts before
    // anyone can call a tool are still attributed to the guest.
    ...(session.lifter !== undefined ? { lifter: session.lifter } : {}),
  });
  slot.live.adoptIdleTail(adopt);
  const reclaimed = slot.live.forgetIdleReps(adopt - ADOPTED_WITHOUT_CORROBORATION);
  const device = slot.live.snapshotDevice();
  state.setStartDeviceSnapshots.set(setId, device);
  publishAutoArmed(state, slotId, setId, startedAt, session.sessionId, session.lifter);
  return { armed: true, setId, reclaimed };
}

/**
 * How many idle reps the new set should adopt, or `null` to hold off arming.
 *
 * The arm needs TWO closed reps (VW-181). At the first boundary of an idle
 * window there is only one, and one rep says nothing about itself: a
 * positioning pull and a working rep look identical until something else in
 * the window disagrees with one of them. The in-progress rep can't break the
 * tie either — it carries a single sample at that instant — so the decision
 * waits one boundary, roughly the two seconds until the next rep begins, and
 * the held rep is adopted retroactively when it turns out to be work.
 */
function repsToAdopt(closedTail: readonly Rep[]): number | null {
  if (closedTail.length < 2) return null;
  const [earlier, trigger] = closedTail;
  return isTailPairConsistent(earlier, trigger)
    ? ADOPTED_WITH_CORROBORATION
    : ADOPTED_WITHOUT_CORROBORATION;
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
  lifter: string | undefined,
): void {
  const slot = getSlot(state, slotId);
  const ordinal = (slot.live.snapshotSession()?.setIds.length ?? 0) + 1;
  const activeSet: ActiveSet = {
    setId,
    sessionId,
    startedAt,
    reps: [],
    status: 'active',
    ...(lifter !== undefined ? { lifter } : {}),
  };
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
