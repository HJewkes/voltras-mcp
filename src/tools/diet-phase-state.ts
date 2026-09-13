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
import { isDietPhase } from '../store/diet-phase.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID } from '../store/types.js';

/** What an undeclared (or straddled) phase answers: the table runs unmodified. */
export const UNKNOWN_DIET_PHASE_STATE: DietPhaseState = { phase: 'unknown', weeksInPhase: null };

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
  state: ServerState,
  from: string = new Date().toISOString(),
  to: string = from,
): Promise<DietPhaseState> {
  const covering = await state.store.getDietPhaseCovering(LOCAL_USER_ID, from, to);
  if (covering === undefined || !isDietPhase(covering.phase)) return UNKNOWN_DIET_PHASE_STATE;
  return { phase: covering.phase, weeksInPhase: weeksInPhaseAt(covering.startedAt, to) };
}
