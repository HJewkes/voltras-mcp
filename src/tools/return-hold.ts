// The return clearance hold on working sessions, shared by the tools that start work:
// `session.start` (VW-976) and `device.start_guided_load` (VW-984, VW-989).

import { localDate } from '../analytics/training-days.js';
import { UserFacingError } from '../errors.js';
import type { ActiveSession } from '../state/live-state.js';
import type { ServerState } from '../state/server-state.js';
import type { SessionKind } from '../store/session-kind.js';
import { readClearanceBlock } from './re-entry-read.js';

class ToolError extends UserFacingError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

/**
 * The kind a NEW session gets (VW-489). A session someone deliberately started
 * is training unless they say otherwise, so the default is what makes the flag
 * cost nothing day to day. `VOLTRA_ADAPTER=mock` overrides whatever was asked
 * for: every rep came from a synthetic device, and calling that training would
 * feed the baselines the one corpus that is definitely not the lifter's.
 */
export function startingKind(state: ServerState, asked: SessionKind | undefined): SessionKind {
  if (state.config?.adapter === 'mock') return 'test';
  return asked ?? 'training';
}

/**
 * VW-976: while the owner's latest return clearance answer is "not yet" and a break or its
 * re-entry window is open, a working session is refused. A test session and a guest's session
 * are not the owner's training, so neither is held.
 */
export async function refuseUnclearedReturn(
  state: ServerState,
  kind: SessionKind,
  lifter: string | undefined,
): Promise<void> {
  if (kind !== 'training' || lifter !== undefined) return;
  const now = new Date().toISOString();
  const blocked = await readClearanceBlock(state.store, localDate(now), now);
  if (blocked !== null) throw new ToolError('RETURN_NOT_CLEARED', blocked);
}

/**
 * The same hold on a guided load. A slot with no session gets a new one when the flow arms
 * (VW-984). An open session is held by its stored kind and its lifter, however long ago it was
 * opened (VW-989); one with no stored kind to read is treated as a new one.
 */
export async function refuseUnclearedGuidedLoad(
  state: ServerState,
  open: ActiveSession | undefined,
): Promise<void> {
  const stored = open === undefined ? undefined : await state.store.getSession(open.sessionId);
  const kind = stored?.kind ?? startingKind(state, undefined);
  await refuseUnclearedReturn(state, kind, open?.lifter);
}
