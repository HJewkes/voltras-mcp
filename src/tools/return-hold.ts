// The return clearance hold on opening a session, shared by every tool that can open one:
// `session.start` (VW-976) and `device.start_guided_load` (VW-984).

import { localDate } from '../analytics/training-days.js';
import { UserFacingError } from '../errors.js';
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
