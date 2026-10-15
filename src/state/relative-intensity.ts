// Relative intensity at set start: shared by the effort pin and the set-risk readers.

import { constantLoadSets, referenceOneRepMax } from '../store/rir-velocity-candidates.js';
import { LOCAL_USER_ID, type SessionStore } from '../store/types.js';

/** Load over the same reference 1RM the curve was fitted against, or `null` when either is unknown. */
export async function relativeIntensityOf(
  store: SessionStore,
  exerciseId: string,
  loadLbs: number | undefined,
): Promise<number | null> {
  if (loadLbs === undefined || loadLbs <= 0) return null;
  const sets = await store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId,
    purpose: ['working'],
  });
  const reference = referenceOneRepMax(constantLoadSets(sets));
  return reference === undefined ? null : loadLbs / reference;
}
