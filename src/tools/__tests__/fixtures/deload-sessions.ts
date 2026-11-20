// Synthetic weekly sessions for the deload advisory tests (VW-592, VW-593). Every
// session is one set at a matched load, so rep count alone moves volume load
// from week to week.

import type { Exercise, Phase } from '@voltras/workout-analytics';

import { LOCAL_USER_ID } from '../../../store/sqlite-store.js';
import type { SessionStore, SetPurpose, StoredRep } from '../../../store/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
};

export const DELOAD_CATALOG: Record<string, string[]> = {
  'synthetic-press': ['chest'],
  'synthetic-fly': ['chest'],
  'synthetic-curl': ['biceps'],
};

/** An `ExerciseService.getById` over {@link DELOAD_CATALOG}. */
export function catalogExercise(id: string): Exercise | undefined {
  const muscleGroups = DELOAD_CATALOG[id];
  return muscleGroups === undefined ? undefined : ({ id, muscleGroups } as Exercise);
}

export interface SessionSpec {
  daysAgo: number;
  reps: number;
  exerciseId?: string;
  romM?: number;
  purpose?: SetPurpose;
  lifter?: string;
}

function makeRep(setId: string, index: number, romM: number): StoredRep {
  const start = index * 10_000;
  return {
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, startTime: start, endTime: start + 1000, endPosition: romM },
    eccentric: {
      ...EMPTY_PHASE,
      startTime: start + 1000,
      endTime: start + 3000,
      startPosition: romM,
    },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

/** Records synthetic sessions relative to `now`, numbering their ids `s1`, `s2`, ... */
export function deloadSessionRecorder(store: SessionStore, now: Date) {
  let sessionCount = 0;
  const instant = (daysAgo: number): string =>
    new Date(now.getTime() - daysAgo * DAY_MS).toISOString();

  async function recordSet(sessionId: string, setId: string, spec: SessionSpec): Promise<void> {
    const at = instant(spec.daysAgo);
    await store.putSet({
      userId: LOCAL_USER_ID,
      exerciseId: spec.exerciseId ?? 'synthetic-press',
      id: setId,
      sessionId,
      startedAt: at,
      endedAt: at,
      partial: false,
      weightLbs: 100,
      reps: Array.from({ length: spec.reps }, (_, i) => makeRep(setId, i, spec.romM ?? 0.5)),
      ...(spec.purpose === undefined ? {} : { setPurpose: spec.purpose }),
      ...(spec.lifter === undefined ? {} : { lifter: spec.lifter }),
    });
  }

  async function recordSession(spec: SessionSpec): Promise<string> {
    sessionCount += 1;
    const sessionId = `s${String(sessionCount)}`;
    const lifter = spec.lifter === undefined ? {} : { lifter: spec.lifter };
    await store.putSession({
      kind: 'training',
      id: sessionId,
      startedAt: instant(spec.daysAgo),
      ...lifter,
    });
    await recordSet(sessionId, `${sessionId}-set`, spec);
    return sessionId;
  }

  /** Three sessions a week apart, the newest one day before `now`. */
  async function recordWeekly(
    reps: [number, number, number],
    exerciseId?: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, count] of reps.entries()) {
      const exercise = exerciseId === undefined ? {} : { exerciseId };
      ids.push(await recordSession({ daysAgo: 15 - i * 7, reps: count, ...exercise }));
    }
    return ids;
  }

  return { recordSet, recordSession, recordWeekly };
}
