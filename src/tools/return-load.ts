// The load a returning lifter's fresh basis is held to or climbs by (VW-988).
//
// `plan.suggest_progression` reads a stale basis itself (VW-907). This is the case after it: the
// lift was trained since the break, so its basis is a light session from the return window. Inside
// that window the load stays at the window load; after it, the climb-back ramp's week sets it. Both
// scale from the lift's last working load before the break, read here from the store.

import {
  lastClosedBreak,
  selectReEntry,
  selectReturnRamp,
  type ReturnRamp,
} from '../analytics/re-entry.js';
import { localMidnightIso, readTrainingDaysMatching } from '../analytics/training-days.js';
import { scopeSessionSetsToExerciseId, scopeSetsToLifter } from '../store/set-scope.js';
import { LOCAL_USER_ID, type SessionStore } from '../store/types.js';
import { selectWorkingSets } from '../store/working-sets.js';
import { reEntryLoad, type StaleBasisReEntry } from './re-entry-read.js';

export type ReturnLoad =
  | { readonly kind: 'window'; readonly reEntry: StaleBasisReEntry }
  | { readonly kind: 'ramp'; readonly ramp: ReturnRamp };

type ReturnLoadStore = Pick<
  SessionStore,
  'listTrainingDayInstants' | 'getMostRecentSessionIdForExercise' | 'getSetsForSession'
>;

/**
 * The owner's return load for one lift today, or `null` when no window or ramp is in force, or the
 * lift has no working load from before the break to scale.
 */
export async function readReturnLoad(
  store: ReturnLoadStore,
  exerciseId: string,
  today: string,
  nowIso: string,
): Promise<ReturnLoad | null> {
  const trainingDays = await readTrainingDaysMatching(store, { to: nowIso });
  const closed = lastClosedBreak(trainingDays);
  if (closed === null) return null;
  const preBreakLoadLbs = await readPreBreakLoad(store, exerciseId, closed.endsOn);
  if (preBreakLoadLbs === undefined) return null;
  const read = selectReEntry({ trainingDays, today });
  if (read.phase === 'returning' && (read.band === 'short' || read.band === 'medium')) {
    return { kind: 'window', reEntry: reEntryLoad(read.band, preBreakLoadLbs) };
  }
  const ramp = selectReturnRamp({ trainingDays, today, preBreakLoadLbs });
  return ramp === null ? null : { kind: 'ramp', ramp };
}

/** The top working load of the lift's last owner session before the first day back. */
async function readPreBreakLoad(
  store: ReturnLoadStore,
  exerciseId: string,
  firstDayBack: string,
): Promise<number | undefined> {
  const sessionId = await store.getMostRecentSessionIdForExercise({
    userId: LOCAL_USER_ID,
    exerciseId,
    startedBefore: localMidnightIso(firstDayBack),
  });
  if (sessionId === null) return undefined;
  const ownerSets = scopeSetsToLifter(await store.getSetsForSession(sessionId), undefined);
  const loads = selectWorkingSets(scopeSessionSetsToExerciseId(ownerSets, exerciseId))
    .map((set) => set.weightLbs)
    .filter((weight): weight is number => weight !== undefined);
  return loads.length > 0 ? Math.max(...loads) : undefined;
}
