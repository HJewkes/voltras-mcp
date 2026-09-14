// The one store read behind VW-277's tolerance table, shared by every consumer
// so `plan.suggest_progression` and the readiness/plateau reads can never
// disagree about which phase the lifter is in.
//
// `diet_phases` IS THE SOURCE OF TRUTH, not `sessions.diet_phase` (VW-150) —
// the table is retroactively correctable and the session column is a stamp
// taken at write time. A window straddling two declared ranges has no covering
// range and answers `'unknown'`, exactly as `plateauWindowPhase` already does:
// "half fat-loss" is not a phase and must not earn half a tolerance.

import type { DietPhaseState } from '../analytics/diet-phase-tolerance.js';
import { weeksInPhaseAt } from '../analytics/diet-phase-tolerance.js';
import { isDietPhase, type RecompMode } from '../store/diet-phase.js';
import { LOCAL_USER_ID, type SessionStore } from '../store/types.js';

/**
 * The declared phase plus the recomposition mode the lifter chose with it
 * (VW-378). The mode rides here rather than on `DietPhaseState` because the
 * VW-277 tolerance table does not read it — only the goal band does.
 */
export interface DeclaredDietPhaseState extends DietPhaseState {
  /** Present only under `'recomposition'`, and only when it was declared. */
  recompMode?: RecompMode;
  /**
   * The covering range's own `startedAt` (VW-376). `weeksInPhase` is already
   * derived from it, and the bodyweight trend needs the instant itself — the
   * settling window and the cumulative-loss baseline both measure from it.
   * Absent whenever the phase is unknown.
   */
  startedAt?: string;
}

/** What an undeclared (or straddled) phase answers: the table runs unmodified. */
export const UNKNOWN_DIET_PHASE_STATE: DietPhaseState = { phase: 'unknown', weeksInPhase: null };

/**
 * The one store method this read needs. Declared as a slice rather than
 * `ServerState` so a caller outside the MCP tool layer — the dashboard's
 * muscle-strength route (VW-330) — can reach the same read without
 * fabricating a whole server state. Every existing caller passes a
 * `ServerState`, which satisfies this structurally.
 */
export interface DietPhaseReadState {
  store: Pick<SessionStore, 'getDietPhaseCovering'>;
}

/**
 * The declared phase covering `[from, to]` and how many weeks the lifter has
 * been in it as of `to`.
 *
 * `weeksInPhase` counts from the RANGE's own `startedAt`, never from `from`:
 * the question the table asks is how long the lifter has been eating this way,
 * and the window being judged is usually much shorter than the phase.
 *
 * Both arguments default to now, which is the point lookup every live caller
 * wants. A historical read passes the window it is judging.
 */
export async function readDietPhaseState(
  state: DietPhaseReadState,
  from: string = new Date().toISOString(),
  to: string = from,
): Promise<DeclaredDietPhaseState> {
  const covering = await state.store.getDietPhaseCovering(LOCAL_USER_ID, from, to);
  if (covering === undefined || !isDietPhase(covering.phase)) return UNKNOWN_DIET_PHASE_STATE;
  const read: DeclaredDietPhaseState = {
    phase: covering.phase,
    weeksInPhase: weeksInPhaseAt(covering.startedAt, to),
    startedAt: covering.startedAt,
  };
  if (covering.recompMode !== undefined) read.recompMode = covering.recompMode;
  return read;
}
