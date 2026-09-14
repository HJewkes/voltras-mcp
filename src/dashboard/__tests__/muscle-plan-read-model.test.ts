// Unit tests for the muscle-plan read-model (VW-331, B4 of the body-map plan).
//
// Pure shaping only — no store, no HTTP. Covers: planned-vs-done set counts per
// titan muscle group (target-only, B47), the remaining-exercise list drawn only
// from templates not yet trained, a muscle with no planned work reading as
// zeros, the calendar-week boundary `doneSetsThisWeek` is scoped to, and the
// mock/non-owner/non-working set exclusions.

import { describe, expect, it } from 'vitest';

import {
  buildMusclePlanView,
  startOfCalendarWeekIso,
  type MusclePlanRows,
  type MusclePlanTemplateRow,
} from '../read-models/muscle-plan.js';
import { MUSCLE_MAP_VERSION } from '../../exercises/muscle-map.js';
import type { StoredPlannedExercise, StoredSet, StoredTrainingWeek } from '../../store/types.js';

/** A Monday, so `startOfCalendarWeekIso` is a no-op on it. */
const MONDAY = '2026-07-06T00:00:00.000Z';
const NOW = new Date('2026-07-08T12:00:00.000Z'); // Wednesday of the same week

const WEEK: StoredTrainingWeek = {
  id: 'wk-1',
  blockId: 'blk-1',
  orderIndex: 0,
  isDeload: true,
  weekIndex: 2,
};

const TEMPLATE_A: MusclePlanTemplateRow = { id: 'tpl-a', name: 'Upper A', completed: true };
const TEMPLATE_B: MusclePlanTemplateRow = { id: 'tpl-b', name: 'Upper B', completed: false };

const CATALOG: Record<string, { name?: string; muscleGroups: string[] }> = {
  'chest-press': { name: 'Chest Press', muscleGroups: ['chest'] },
  'overhead-press': { name: 'Overhead Press', muscleGroups: ['shoulders'] },
};
const catalog = (id: string): { name?: string; muscleGroups: string[] } | undefined => CATALOG[id];

function plannedExercise(overrides: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise {
  return {
    id: 'pe1',
    workoutTemplateId: 'tpl-a',
    exerciseId: 'chest-press',
    orderIndex: 0,
    targetSets: 3,
    ...overrides,
  };
}

function completedSet(overrides: Partial<StoredSet> = {}): StoredSet {
  return {
    id: 'set1',
    sessionId: 'sess-1',
    startedAt: MONDAY,
    endedAt: MONDAY,
    partial: false,
    reps: [],
    exerciseId: 'chest-press',
    firmwareRepCount: 5,
    ...overrides,
  };
}

function musclesOf(
  view: ReturnType<typeof buildMusclePlanView>,
): Map<string, (typeof view.muscles)[number]> {
  return new Map(view.muscles.map((m) => [m.muscle, m]));
}

describe('buildMusclePlanView', () => {
  it('sums planned sets across all templates, and remaining only from incomplete ones', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [TEMPLATE_A, TEMPLATE_B],
      plannedExercises: [
        plannedExercise({ id: 'pe-a', workoutTemplateId: 'tpl-a', targetSets: 3 }),
        plannedExercise({ id: 'pe-b', workoutTemplateId: 'tpl-b', targetSets: 4 }),
      ],
      completedSets: [completedSet()],
      catalog,
      now: NOW,
    };
    const view = buildMusclePlanView(rows);
    const chest = musclesOf(view).get('chest');
    expect(chest?.plannedSetsThisWeek).toBe(7);
    expect(chest?.doneSetsThisWeek).toBe(1);
    expect(chest?.plannedRemaining).toEqual([
      { workoutName: 'Upper B', exerciseId: 'chest-press', exerciseName: 'Chest Press', sets: 4 },
    ]);
  });

  it('credits every titan slug a coarse catalog group maps to, in full', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [TEMPLATE_B],
      plannedExercises: [
        plannedExercise({
          id: 'pe-c',
          workoutTemplateId: 'tpl-b',
          exerciseId: 'overhead-press',
          targetSets: 3,
        }),
      ],
      completedSets: [],
      catalog,
      now: NOW,
    };
    const muscles = musclesOf(buildMusclePlanView(rows));
    for (const slug of ['front_delts', 'side_delts', 'rear_delts']) {
      const m = muscles.get(slug);
      expect(m?.plannedSetsThisWeek).toBe(3);
      expect(m?.plannedRemaining).toEqual([
        {
          workoutName: 'Upper B',
          exerciseId: 'overhead-press',
          exerciseName: 'Overhead Press',
          sets: 3,
        },
      ]);
    }
  });

  it('returns zeros for a muscle with no planned work, and lists all 15 titan slugs', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [TEMPLATE_A],
      plannedExercises: [plannedExercise()],
      completedSets: [],
      catalog,
      now: NOW,
    };
    const view = buildMusclePlanView(rows);
    expect(view.muscles).toHaveLength(15);
    const calves = musclesOf(view).get('calves');
    expect(calves).toEqual({
      muscle: 'calves',
      plannedSetsThisWeek: 0,
      doneSetsThisWeek: 0,
      plannedRemaining: [],
    });
  });

  it('excludes a guest set, a mock-adapter set, and a warm-up from doneSetsThisWeek', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [TEMPLATE_A],
      plannedExercises: [plannedExercise()],
      completedSets: [
        completedSet({ id: 'guest', lifter: 'Jordan' }),
        completedSet({ id: 'mock', source: 'mock' }),
        completedSet({ id: 'warmup', setPurpose: 'warmup' }),
        completedSet({ id: 'zero-rep', firmwareRepCount: 0 }),
        completedSet({ id: 'real' }),
      ],
      catalog,
      now: NOW,
    };
    const chest = musclesOf(buildMusclePlanView(rows)).get('chest');
    expect(chest?.doneSetsThisWeek).toBe(1);
  });

  it('scopes doneSetsThisWeek to the calendar week containing `now`', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [TEMPLATE_A],
      plannedExercises: [plannedExercise()],
      completedSets: [
        completedSet({ id: 'before', startedAt: '2026-07-05T23:59:59.999Z' }),
        completedSet({ id: 'on-boundary', startedAt: MONDAY }),
        completedSet({ id: 'after', startedAt: '2026-07-13T00:00:00.000Z' }),
      ],
      catalog,
      now: NOW,
    };
    const chest = musclesOf(buildMusclePlanView(rows)).get('chest');
    expect(chest?.doneSetsThisWeek).toBe(1);
  });

  it('echoes weekStart, weekIndex, isDeload, and muscleMapVersion', () => {
    const rows: MusclePlanRows = {
      week: WEEK,
      templates: [],
      plannedExercises: [],
      completedSets: [],
      catalog,
      now: NOW,
    };
    const view = buildMusclePlanView(rows);
    expect(view.weekStart).toBe(startOfCalendarWeekIso(NOW));
    expect(view.weekStart).toBe(MONDAY);
    expect(view.weekIndex).toBe(2);
    expect(view.isDeload).toBe(true);
    expect(view.muscleMapVersion).toBe(MUSCLE_MAP_VERSION);
  });

  it('omits weekIndex when the training week does not carry one', () => {
    const rows: MusclePlanRows = {
      week: { ...WEEK, weekIndex: undefined },
      templates: [],
      plannedExercises: [],
      completedSets: [],
      catalog,
      now: NOW,
    };
    expect('weekIndex' in buildMusclePlanView(rows)).toBe(false);
  });
});
