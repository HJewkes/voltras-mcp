// Shared reap for the bridge-minted guided-load scaffold (session + set the
// event-bridge auto-creates on the `armed` phase so direct-load rep/set
// boundaries have a real attribution target).
//
// Three callers converge here so the teardown shape stays identical:
//   * `device.exit_guided_load` / `device.unload` (tool paths) — the caller
//     has already asserted a guided-load teardown, so the active set is
//     finalized unconditionally.
//   * the event-bridge's `timeout` transition (VMCP-02.62) — an autonomous
//     failure path, so it passes `requireAutoCreated` to guarantee a
//     legitimately-active explicit set is never torn down.
//
// Order: set first, then session, published as separate channel signals
// (`set_ended`, then the session-ended persist) — the F4+F8 brief forbids
// bundling them into one event.

import { getSlot, type ServerState } from './server-state.js';
import { finalizeSet } from '../tools/set-tools.js';
import type { StoredSession } from '../store/types.js';
import { log } from '../logger.js';

export interface GuidedLoadReapOptions {
  /**
   * VMCP-02.62: when true, reap ONLY if the active session is tagged
   * `autoCreatedBy: 'guided_load'`. The autonomous failure path (bridge
   * `timeout` phase) sets this so a legitimately-active explicit set that
   * happened to be open when the flow timed out is never finalized. The
   * tool paths (`exit_guided_load` / `unload`) leave it false — the caller
   * has already committed to a guided-load teardown.
   */
  requireAutoCreated?: boolean;
}

/**
 * Reap the guided-load scaffold on the supplied slot.
 *
 * Set reap: `finalizeSet` with `partialReason: 'guided_load_exited'` and
 * `disengageMotor: false` (the exit frame / poll-window teardown already
 * released the motor; a redundant `Workout.STOP` would just churn state).
 * `cause: 'tool'` marks it a tool-consistent close for channel subscribers.
 *
 * Session reap: only when the active session is `autoCreatedBy:
 * 'guided_load'` AND no set remains in flight. Errors on the persist path
 * are caught + logged — the caller's real work already succeeded.
 */
export async function reapGuidedLoadScaffold(
  state: ServerState,
  slotId: string,
  opts: GuidedLoadReapOptions = {},
): Promise<void> {
  const slot = getSlot(state, slotId);
  const isAutoCreated = slot.live.session?.autoCreatedBy === 'guided_load';
  if (opts.requireAutoCreated === true && !isAutoCreated) {
    return;
  }
  if (slot.live.set !== undefined) {
    try {
      await finalizeSet(state, slotId, {
        cause: 'tool',
        disengageMotor: false,
        partialReason: 'guided_load_exited',
      });
    } catch (err) {
      log.warn('guided-load reap: set finalize failed', err);
    }
  }
  await reapAutoCreatedSession(state, slotId);
}

/**
 * End + persist the auto-created guided-load session, but only once the set
 * has been finalized (no in-flight set) and only when the session carries
 * the `guided_load` auto-create tag — an explicit session that happened to
 * be running during a guided-load flow is left untouched.
 */
async function reapAutoCreatedSession(state: ServerState, slotId: string): Promise<void> {
  const slot = getSlot(state, slotId);
  const session = slot.live.session;
  if (
    session === undefined ||
    session.autoCreatedBy !== 'guided_load' ||
    slot.live.set !== undefined
  ) {
    return;
  }
  const finalizedSession = slot.live.endSession();
  if (finalizedSession === undefined) {
    return;
  }
  const stored: StoredSession = {
    id: finalizedSession.sessionId,
    startedAt: finalizedSession.startedAt,
    endedAt: new Date().toISOString(),
    ...(finalizedSession.exerciseId !== undefined
      ? { exerciseId: finalizedSession.exerciseId }
      : {}),
    ...(finalizedSession.exerciseName !== undefined
      ? { exerciseName: finalizedSession.exerciseName }
      : {}),
  };
  try {
    await state.store.putSession(stored);
  } catch (err) {
    log.warn('guided-load reap: session persist failed', err);
  }
}
