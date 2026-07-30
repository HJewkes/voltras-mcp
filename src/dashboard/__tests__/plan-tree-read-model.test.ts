// Unit tests for the plan-tree read-model (VW-120).
//
// Pure shaping only — no store, no HTTP. What matters here is that the view is
// ordered by `orderIndex` (not input order), named from the catalog with a
// never-invented fallback, and that `nextOrderIndex` cannot collide with an
// existing row.

import { describe, expect, it } from 'vitest';

import { buildPlanTreeView, nextOrderIndex, type PlanTreeRows } from '../read-models/plan-tree.js';
import type {
  StoredPlannedExercise,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

const PROGRAM: StoredTrainingProgram = {
  id: 'prog-1',
  name: 'Base Build',
  createdAt: '2026-07-01T00:00:00.000Z',
};
const BLOCK: StoredTrainingBlock = {
  id: 'blk-1',
  programId: 'prog-1',
  orderIndex: 0,
  name: 'Block 1',
  weeksCount: 4,
};
const WEEK: StoredTrainingWeek = { id: 'wk-1', blockId: 'blk-1', orderIndex: 0, name: 'Week 1' };
const TEMPLATE: StoredWorkoutTemplate = {
  id: 'tpl-1',
  weekId: 'wk-1',
  name: 'Upper A',
  orderIndex: 0,
};

function plannedExercise(
  id: string,
  exerciseId: string,
  orderIndex: number,
): StoredPlannedExercise {
  return { id, workoutTemplateId: 'tpl-1', exerciseId, orderIndex, targetSets: 3 };
}

function rowsWith(exercises: StoredPlannedExercise[]): PlanTreeRows {
  return {
    programs: [PROGRAM],
    program: PROGRAM,
    blocks: [BLOCK],
    weeksByBlock: new Map([['blk-1', [WEEK]]]),
    templatesByWeek: new Map([['wk-1', [TEMPLATE]]]),
    exercisesByTemplate: new Map([['tpl-1', exercises]]),
    completedTemplateIds: new Set<string>(),
  };
}

const NAMES: Record<string, string> = { 'cable-row': 'Cable Row' };
const nameOf = (id: string): string | undefined => NAMES[id];

describe('buildPlanTreeView', () => {
  it('nests program → block → week → template → exercises', () => {
    const view = buildPlanTreeView(rowsWith([plannedExercise('pe-1', 'cable-row', 0)]), nameOf);
    const template = view.program?.blocks[0]?.weeks[0]?.templates[0];
    expect(view.program?.name).toBe('Base Build');
    expect(template?.name).toBe('Upper A');
    expect(template?.exercises.map((e) => e.name)).toEqual(['Cable Row']);
  });

  it('orders exercises by orderIndex regardless of input order', () => {
    const view = buildPlanTreeView(
      rowsWith([
        plannedExercise('pe-c', 'cable-row', 2),
        plannedExercise('pe-a', 'cable-row', 0),
        plannedExercise('pe-b', 'cable-row', 1),
      ]),
      nameOf,
    );
    const ids = view.program?.blocks[0]?.weeks[0]?.templates[0]?.exercises.map((e) => e.id);
    expect(ids).toEqual(['pe-a', 'pe-b', 'pe-c']);
  });

  it('falls back to the raw exercise id when the catalog has no entry', () => {
    const view = buildPlanTreeView(rowsWith([plannedExercise('pe-1', 'mystery-lift', 0)]), nameOf);
    expect(view.program?.blocks[0]?.weeks[0]?.templates[0]?.exercises[0]?.name).toBe(
      'mystery-lift',
    );
  });

  it('flags a template that already has an assignment as completed', () => {
    const rows = { ...rowsWith([]), completedTemplateIds: new Set(['tpl-1']) };
    expect(
      buildPlanTreeView(rows, nameOf).program?.blocks[0]?.weeks[0]?.templates[0]?.completed,
    ).toBe(true);
  });

  it('reports program: null and an empty tree when no program is selected', () => {
    const view = buildPlanTreeView({ ...rowsWith([]), program: undefined }, nameOf);
    expect(view.program).toBeNull();
    expect(view.programs).toHaveLength(1);
  });

  it('surfaces the live session’s template and exercise', () => {
    const view = buildPlanTreeView(
      { ...rowsWith([]), activeTemplateId: 'tpl-1', activeExerciseId: 'cable-row' },
      nameOf,
    );
    expect(view.activeTemplateId).toBe('tpl-1');
    expect(view.activeExerciseId).toBe('cable-row');
  });

  it('marks an archived program in the picker', () => {
    const archived = { ...PROGRAM, archivedAt: '2026-07-20T00:00:00.000Z' };
    const view = buildPlanTreeView({ ...rowsWith([]), programs: [archived] }, nameOf);
    expect(view.programs[0]?.archived).toBe(true);
  });
});

describe('nextOrderIndex', () => {
  it('starts an empty template at 0', () => {
    expect(nextOrderIndex([])).toBe(0);
  });

  it('lands one past the HIGHEST index, not the row count', () => {
    // A gapped list (0, 5) has length 2 — appending at `length` would collide
    // with nothing today but silently reorder once index 2 exists.
    expect(nextOrderIndex([{ orderIndex: 0 }, { orderIndex: 5 }])).toBe(6);
  });
});
