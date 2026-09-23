// One helper for the fixtures that mean "the owner trained that day" (VW-489).
//
// Two rules make a session a training day, and a bare `putSession` satisfies
// neither: it must be marked `kind: 'training'`, and it must hold at least one
// working set. Spelling both out at every call site is how one of them ends up
// missing and a test passes for the wrong reason.

import type { SessionStore, StoredSession } from '../../store/types.js';

type TrainingDayStore = Pick<SessionStore, 'putSession' | 'putSet'>;

/** Persist `session` as training, with one working set on it. */
export async function seedTrainingDay(
  store: TrainingDayStore,
  session: StoredSession,
): Promise<void> {
  await store.putSession({ kind: 'training', ...session });
  const endedAt = session.endedAt ?? session.startedAt;
  await store.putSet({
    id: `${session.id}-work`,
    sessionId: session.id,
    startedAt: session.startedAt,
    endedAt,
    partial: false,
    reps: [],
    ...(session.exerciseId === undefined ? {} : { exerciseId: session.exerciseId }),
    ...(session.lifter === undefined ? {} : { lifter: session.lifter }),
  });
}
