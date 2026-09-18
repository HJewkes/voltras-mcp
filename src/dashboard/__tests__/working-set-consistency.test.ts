// VW-283: the wall tally, the session-summary page and `plan.suggest_progression`
// used to run THREE separately-maintained "is this a working set" rules. This
// proves the same fixture — an unflagged heavy primer below the session's top
// load, plus two real working sets — counts identically everywhere:
//
//   * `plan.suggest_progression`'s basis is `selectWorkingSets` over `StoredSet[]`
//     (`plan-tools.ts`'s `computeProgressionDelta`, verbatim).
//   * the session-summary page's `workingSetCount` is `buildSessionSummary`'s
//     REAL output — not a hand-mirrored count — so this also proves the
//     server's `StoredSet -> SessionSummarySet` boundary doesn't drop the
//     heuristic.
//   * the wall's tally is `workingCompletedSets` over the `CompletedSet[]`
//     shape the live page reads.

import { describe, expect, it } from 'vitest';
import { addSampleToSet, createSet, MovementPhase, type Rep } from '@voltras/workout-analytics';

import { buildSessionSummary } from '../read-models/session-summary.js';
import type { DashboardPlanStore } from '../plan-api.js';
import type { DashboardSessionStore } from '../read-models/session-summary.js';
import { selectWorkingSets } from '../../store/working-sets.js';
import type { StoredSet, StoredSession } from '../../store/types.js';
import {
  workingCompletedSets,
  type CompletedSet,
  type SessionModel,
} from '../spa/live-page/model.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

/** One rep of real WA samples so the fatigue/verdict calls don't throw. */
function buildReps(repCount: number): Rep[] {
  let set = createSet();
  let t = 1000;
  for (let i = 0; i < repCount; i += 1) {
    set = addSampleToSet(set, {
      sequence: i * 2,
      timestamp: t,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: 0.8,
      force: 100,
    });
    set = addSampleToSet(set, {
      sequence: i * 2 + 1,
      timestamp: t + 600,
      phase: MovementPhase.ECCENTRIC,
      position: 0.5,
      velocity: 0.4,
      force: 80,
    });
    t += 2000;
  }
  return [...set.reps];
}

const SESSION: StoredSession = {
  id: 'sess-1',
  startedAt: '2026-09-13T10:00:00.000Z',
  endedAt: '2026-09-13T10:30:00.000Z',
  status: 'ended',
} as StoredSession;

/**
 * The fixture: `primer` is a heavy-primer warm-up never flagged
 * `setPurpose`/`isWarmup` — only its sub-top load marks it — followed by two
 * real working sets at the session's top load.
 */
function fixture(): StoredSet[] {
  return [
    {
      id: 'primer',
      sessionId: SESSION.id,
      startedAt: '2026-09-13T10:00:00.000Z',
      endedAt: '2026-09-13T10:01:00.000Z',
      partial: false,
      weightLbs: 95,
      exerciseId: 'cable-row',
      reps: buildReps(8) as StoredSet['reps'],
    },
    {
      id: 'w1',
      sessionId: SESSION.id,
      startedAt: '2026-09-13T10:02:00.000Z',
      endedAt: '2026-09-13T10:03:00.000Z',
      partial: false,
      weightLbs: 135,
      exerciseId: 'cable-row',
      reps: buildReps(8) as StoredSet['reps'],
    },
    {
      id: 'w2',
      sessionId: SESSION.id,
      startedAt: '2026-09-13T10:04:00.000Z',
      endedAt: '2026-09-13T10:05:00.000Z',
      partial: false,
      weightLbs: 135,
      exerciseId: 'cable-row',
      reps: buildReps(8) as StoredSet['reps'],
    },
  ];
}

function asCompletedSets(sets: StoredSet[]): CompletedSet[] {
  return sets.map((set) => ({
    fatigueStop: exerciseFatigueStop(undefined),
    fatigueVerdict: null,
    exerciseName: 'Cable Row',
    weightLbs: set.weightLbs ?? null,
    mode: 'weight',
    repCount: set.reps.length,
    reps: [0.8, 0.75],
    peakForceLbs: null,
    setPurpose: 'working',
  }));
}

describe('working-set count parity across the wall, the summary page and progression (VW-283)', () => {
  it('drops the same unflagged heavy primer everywhere', async () => {
    const sets = fixture();

    // plan.suggest_progression's basis (plan-tools.ts's computeProgressionDelta
    // calls exactly this over the exercise-scoped StoredSet[]).
    expect(selectWorkingSets(sets).length).toBe(2);

    // The session-summary page's real workingSetCount, end to end.
    const store: DashboardSessionStore & DashboardPlanStore = {
      getSession: async (id) => (id === SESSION.id ? SESSION : undefined),
      getSetsForSession: async () => sets,
      getSetsForExercise: async () => sets,
      getBaseline: async () => undefined,
      listSessions: async () => [SESSION],
      listTrainingPrograms: async () => [],
      getTrainingProgram: async () => undefined,
      getTrainingBlock: async () => undefined,
      getTrainingBlocksForProgram: async () => [],
      getTrainingWeek: async () => undefined,
      getTrainingWeeksForBlock: async () => [],
      getWorkoutTemplatesForWeek: async () => [],
      getWorkoutTemplate: async () => undefined,
      getPlannedExercisesForTemplate: async () => [],
      getPlannedExercise: async () => undefined,
      getAssignmentsForTemplate: async () => [],
      getAssignmentsForSession: async () => [],
      putTrainingProgram: async () => undefined,
      putTrainingBlock: async () => undefined,
      putTrainingWeek: async () => undefined,
      putWorkoutTemplate: async () => undefined,
      putPlannedExercise: async () => undefined,
      deletePlannedExercise: async () => true,
    };
    const summary = await buildSessionSummary({ store, nameOf: () => undefined }, SESSION.id);
    expect(summary?.exercises[0]?.workingSetCount).toBe(2);

    // The wall's session-wide tally over the CompletedSet wire shape.
    const session: SessionModel = {
      hasSession: true,
      exerciseName: 'Cable Row',
      lifter: null,
      title: null,
      weightLbs: 135,
      unit: 'lbs',
      completedSets: asCompletedSets(sets),
      plannedExercises: [],
      restSec: null,
      restBasis: null,
      plannedSets: null,
      targetReps: null,
      expectedSetupCard: null,
      sessionPace: null,
    };
    expect(workingCompletedSets(session).length).toBe(2);
  });
});
