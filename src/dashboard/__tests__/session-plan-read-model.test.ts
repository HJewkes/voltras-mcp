// Unit tests for the session-plan read-model (VW-41/43/46/49).
//
// Pure shaping only — no store, no HTTP. Covers the properties `server.ts`'s
// `fetchSessionPlan` used to test end-to-end: target fields carried through
// verbatim, tempo resolution (coach override > exercise default > none), the
// ordered/named planned-exercise rail, and the pre-resolved title passthrough.

import { describe, expect, it } from 'vitest';

import {
  buildPlannedExerciseList,
  buildSessionPlanView,
  type ExerciseCatalogLookup,
  type SessionPlanRows,
} from '../read-models/session-plan.js';
import type { StoredPlannedExercise } from '../../store/types.js';

function plannedRow(overrides: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise {
  return {
    id: 'pe1',
    workoutTemplateId: 't1',
    exerciseId: 'bench',
    orderIndex: 0,
    targetSets: 3,
    ...overrides,
  };
}

describe('buildSessionPlanView', () => {
  it('carries target sets/reps/load/RPE/rest through verbatim', () => {
    const rows: SessionPlanRows = {
      activeExerciseId: 'bench',
      match: plannedRow({
        targetSets: 4,
        targetRepsLow: 8,
        targetRepsHigh: 10,
        targetWeightLbs: 135,
        targetRpe: 8,
        restSec: 120,
      }),
      planned: [plannedRow({ targetSets: 4 })],
      title: null,
    };
    const view = buildSessionPlanView(rows, undefined);
    expect(view).toMatchObject({
      sets: 4,
      repsLow: 8,
      repsHigh: 10,
      weightLbs: 135,
      rpe: 8,
      restSec: 120,
    });
  });

  it('omits optional fields the plan never set, rather than nulling them', () => {
    const rows: SessionPlanRows = {
      activeExerciseId: 'bench',
      match: plannedRow(),
      planned: [plannedRow()],
      title: null,
    };
    const view = buildSessionPlanView(rows, undefined);
    expect(view.repsLow).toBeUndefined();
    expect(view.restSec).toBeUndefined();
    expect(view.title).toBeUndefined();
  });

  it('resolves the coach-set tempo override over the exercise default', () => {
    const rows: SessionPlanRows = {
      activeExerciseId: 'cable-lateral-raise',
      match: plannedRow({
        exerciseId: 'cable-lateral-raise',
        targetTempo: { ecc: 4, pauseBottom: 2, con: 1, pauseTop: 0 },
      }),
      planned: [],
      title: null,
    };
    // cable-lateral-raise's byExercise default is [3, 0, 1, 1] — every slot
    // here differs from it, so a fallback to the default fails this assertion.
    expect(buildSessionPlanView(rows, undefined).tempo).toEqual([4, 2, 1, 0]);
  });

  it('falls back to the movement-pattern default when no coach tempo is set', () => {
    const catalog: ExerciseCatalogLookup = { getById: () => ({ movementPattern: 'push' }) };
    const rows: SessionPlanRows = {
      activeExerciseId: 'barbell-bench-press',
      match: plannedRow({ exerciseId: 'barbell-bench-press' }),
      planned: [],
      title: null,
    };
    expect(buildSessionPlanView(rows, catalog).tempo).toEqual([3, 0, 1, 0]);
  });

  it('omits tempo when neither a coach override nor a default resolves', () => {
    const rows: SessionPlanRows = {
      activeExerciseId: 'unknown_movement',
      match: plannedRow({ exerciseId: 'unknown_movement' }),
      planned: [],
      title: null,
    };
    expect(buildSessionPlanView(rows, undefined).tempo).toBeUndefined();
  });

  it('passes the pre-resolved title through when present', () => {
    const rows: SessionPlanRows = {
      activeExerciseId: 'bench',
      match: plannedRow(),
      planned: [],
      title: 'Push A · Hypertrophy',
    };
    expect(buildSessionPlanView(rows, undefined).title).toBe('Push A · Hypertrophy');
  });
});

describe('buildPlannedExerciseList', () => {
  it('orders by orderIndex regardless of input order, and flags the active row', () => {
    const catalog: ExerciseCatalogLookup = {
      getById: (id) => ({ squat: { name: 'Back Squat' }, bench: { name: 'Bench Press' } })[id],
    };
    const list = buildPlannedExerciseList(
      [
        plannedRow({ id: 'pe2', exerciseId: 'bench', orderIndex: 1 }),
        plannedRow({ id: 'pe1', exerciseId: 'squat', orderIndex: 0, targetSets: 4 }),
        plannedRow({ id: 'pe3', exerciseId: 'row', orderIndex: 2 }),
      ],
      'bench',
      catalog,
    );
    expect(list).toEqual([
      { name: 'Back Squat', order: 0, sets: 4, active: false },
      { name: 'Bench Press', order: 1, sets: 3, active: true },
      { name: 'row', order: 2, sets: 3, active: false },
    ]);
  });

  it('falls back to the raw exercise id when the catalog has no entry', () => {
    const list = buildPlannedExerciseList(
      [plannedRow({ exerciseId: 'mystery-lift' })],
      'bench',
      undefined,
    );
    expect(list[0]?.name).toBe('mystery-lift');
  });

  it('returns an empty list for an empty template', () => {
    expect(buildPlannedExerciseList([], 'bench', undefined)).toEqual([]);
  });
});
