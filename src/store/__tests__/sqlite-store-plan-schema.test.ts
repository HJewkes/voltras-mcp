// Tests for the v3 block-periodization planning schema added to
// SqliteSessionStore. Covers: idempotent migration, full round-trip across
// the program → block → week → template → planned-exercise tree (with
// orderIndex respected), ON DELETE CASCADE through the planning tree, and
// ON DELETE SET NULL for program_assignments when a planned exercise goes
// away. Most cases use a `:memory:` DB; the migration-idempotency case
// reopens a real temp file twice to confirm the v0→v3 path is also
// re-runnable.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSession,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../types.js';

function makeProgram(overrides: Partial<StoredTrainingProgram> = {}): StoredTrainingProgram {
  return {
    id: 'prog-1',
    name: '12-week strength block',
    description: 'Linear progression block',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBlock(overrides: Partial<StoredTrainingBlock> = {}): StoredTrainingBlock {
  return {
    id: 'block-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Hypertrophy block',
    focus: 'hypertrophy',
    weeksCount: 4,
    notes: 'Volume accumulation',
    ...overrides,
  };
}

function makeWeek(overrides: Partial<StoredTrainingWeek> = {}): StoredTrainingWeek {
  return {
    id: 'week-1',
    blockId: 'block-1',
    orderIndex: 0,
    name: 'Week 1',
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<StoredWorkoutTemplate> = {}): StoredWorkoutTemplate {
  return {
    id: 'tmpl-1',
    weekId: 'week-1',
    dayLabel: 'Upper A',
    name: 'Upper A',
    notes: 'Push focus',
    orderIndex: 0,
    ...overrides,
  };
}

function makePlanned(overrides: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise {
  return {
    id: 'pe-1',
    workoutTemplateId: 'tmpl-1',
    exerciseId: 'bench-press',
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 12,
    targetWeightLbs: 135,
    targetRpe: 8,
    restSec: 120,
    notes: 'Pause at chest',
    ...overrides,
  };
}

describe('SqliteSessionStore — v3 plan schema', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  describe('training_programs', () => {
    it('round-trips a program through put/get', async () => {
      const program = makeProgram();
      await store.putTrainingProgram(program);
      const fetched = await store.getTrainingProgram(program.id);
      expect(fetched).toEqual(program);
    });

    it('returns undefined for missing id', async () => {
      expect(await store.getTrainingProgram('nope')).toBeUndefined();
    });

    it('upserts on duplicate id', async () => {
      await store.putTrainingProgram(makeProgram());
      await store.putTrainingProgram(makeProgram({ name: 'renamed' }));
      const fetched = await store.getTrainingProgram('prog-1');
      expect(fetched?.name).toBe('renamed');
    });

    it('listTrainingPrograms hides archived rows by default', async () => {
      await store.putTrainingProgram(
        makeProgram({ id: 'a', name: 'A', createdAt: '2025-01-01T00:00:00.000Z' }),
      );
      await store.putTrainingProgram(
        makeProgram({
          id: 'b',
          name: 'B',
          createdAt: '2025-01-02T00:00:00.000Z',
          archivedAt: '2025-02-01T00:00:00.000Z',
        }),
      );
      const visible = await store.listTrainingPrograms();
      expect(visible.map((p) => p.id)).toEqual(['a']);
      const all = await store.listTrainingPrograms({ includeArchived: true });
      expect(all.map((p) => p.id)).toEqual(['b', 'a']);
    });

    it('preserves omitted optional fields as undefined', async () => {
      const minimal: StoredTrainingProgram = {
        id: 'prog-min',
        name: 'Minimal',
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      await store.putTrainingProgram(minimal);
      const fetched = await store.getTrainingProgram('prog-min');
      expect(fetched).toEqual(minimal);
      expect(fetched?.description).toBeUndefined();
      expect(fetched?.archivedAt).toBeUndefined();
    });
  });

  describe('full tree round-trip', () => {
    beforeEach(async () => {
      // 1 program → 1 block → 2 weeks → 2 templates per week →
      // 3 planned exercises per template. orderIndex is intentionally
      // inserted out of natural order to verify retrieval sorts.
      await store.putTrainingProgram(makeProgram());
      await store.putTrainingBlock(makeBlock());

      await store.putTrainingWeek(makeWeek({ id: 'week-2', orderIndex: 1, name: 'Week 2' }));
      await store.putTrainingWeek(makeWeek({ id: 'week-1', orderIndex: 0, name: 'Week 1' }));

      for (const weekId of ['week-1', 'week-2']) {
        await store.putWorkoutTemplate(
          makeTemplate({
            id: `${weekId}-tmpl-b`,
            weekId,
            orderIndex: 1,
            dayLabel: 'Lower B',
            name: 'Lower B',
          }),
        );
        await store.putWorkoutTemplate(
          makeTemplate({
            id: `${weekId}-tmpl-a`,
            weekId,
            orderIndex: 0,
            dayLabel: 'Upper A',
            name: 'Upper A',
          }),
        );

        for (const tmplSuffix of ['a', 'b']) {
          const tmplId = `${weekId}-tmpl-${tmplSuffix}`;
          // Insert in reverse order to prove ORDER BY order_index is used.
          for (const idx of [2, 1, 0]) {
            await store.putPlannedExercise(
              makePlanned({
                id: `${tmplId}-pe-${idx}`,
                workoutTemplateId: tmplId,
                exerciseId: `ex-${idx}`,
                orderIndex: idx,
              }),
            );
          }
        }
      }
    });

    it('returns blocks for a program', async () => {
      const blocks = await store.getTrainingBlocksForProgram('prog-1');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.id).toBe('block-1');
    });

    it('returns weeks ordered by orderIndex ascending', async () => {
      const weeks = await store.getTrainingWeeksForBlock('block-1');
      expect(weeks.map((w) => w.id)).toEqual(['week-1', 'week-2']);
    });

    it('returns templates per week ordered by orderIndex ascending', async () => {
      const week1Templates = await store.getWorkoutTemplatesForWeek('week-1');
      expect(week1Templates.map((t) => t.id)).toEqual(['week-1-tmpl-a', 'week-1-tmpl-b']);
      const week2Templates = await store.getWorkoutTemplatesForWeek('week-2');
      expect(week2Templates.map((t) => t.id)).toEqual(['week-2-tmpl-a', 'week-2-tmpl-b']);
    });

    it('returns planned exercises per template ordered by orderIndex ascending', async () => {
      const exercises = await store.getPlannedExercisesForTemplate('week-1-tmpl-a');
      expect(exercises.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
      expect(exercises.map((e) => e.exerciseId)).toEqual(['ex-0', 'ex-1', 'ex-2']);
    });

    it('getWorkoutTemplate looks up by id', async () => {
      const tmpl = await store.getWorkoutTemplate('week-1-tmpl-a');
      expect(tmpl?.dayLabel).toBe('Upper A');
      expect(tmpl?.weekId).toBe('week-1');
    });

    it('cascades program deletion through blocks → weeks → templates → planned exercises', async () => {
      // Sanity-check pre-state.
      expect(await store.getTrainingBlocksForProgram('prog-1')).toHaveLength(1);
      expect(await store.getTrainingWeeksForBlock('block-1')).toHaveLength(2);
      expect(await store.getWorkoutTemplatesForWeek('week-1')).toHaveLength(2);
      expect(await store.getPlannedExercisesForTemplate('week-1-tmpl-a')).toHaveLength(3);

      const raw = (store as unknown as { db: DatabaseSync }).db;
      raw.prepare('DELETE FROM training_programs WHERE id = ?').run('prog-1');

      expect(await store.getTrainingProgram('prog-1')).toBeUndefined();
      expect(await store.getTrainingBlocksForProgram('prog-1')).toEqual([]);
      expect(await store.getTrainingWeeksForBlock('block-1')).toEqual([]);
      expect(await store.getWorkoutTemplatesForWeek('week-1')).toEqual([]);
      expect(await store.getWorkoutTemplatesForWeek('week-2')).toEqual([]);
      expect(await store.getPlannedExercisesForTemplate('week-1-tmpl-a')).toEqual([]);
      expect(await store.getPlannedExercisesForTemplate('week-2-tmpl-b')).toEqual([]);
    });
  });

  describe('program_assignments', () => {
    beforeEach(async () => {
      await store.putTrainingProgram(makeProgram());
      await store.putTrainingBlock(makeBlock());
      await store.putTrainingWeek(makeWeek());
      await store.putWorkoutTemplate(makeTemplate());
      await store.putPlannedExercise(makePlanned());

      const session: StoredSession = {
        id: 'sess-1',
        startedAt: '2025-02-01T00:00:00.000Z',
        exerciseId: 'bench-press',
      };
      await store.putSession(session);
    });

    it('round-trips an assignment linking a session to a planned exercise', async () => {
      const assignment: StoredProgramAssignment = {
        id: 'assign-1',
        sessionId: 'sess-1',
        plannedExerciseId: 'pe-1',
        workoutTemplateId: 'tmpl-1',
        assignedAt: '2025-02-01T00:00:00.000Z',
      };
      await store.putProgramAssignment(assignment);
      const rows = await store.getAssignmentsForSession('sess-1');
      expect(rows).toEqual([assignment]);
    });

    it('upserts on duplicate id', async () => {
      const initial: StoredProgramAssignment = {
        id: 'assign-1',
        sessionId: 'sess-1',
        plannedExerciseId: 'pe-1',
        assignedAt: '2025-02-01T00:00:00.000Z',
      };
      await store.putProgramAssignment(initial);
      await store.putProgramAssignment({
        ...initial,
        workoutTemplateId: 'tmpl-1',
        assignedAt: '2025-02-02T00:00:00.000Z',
      });
      const rows = await store.getAssignmentsForSession('sess-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workoutTemplateId).toBe('tmpl-1');
      expect(rows[0]?.assignedAt).toBe('2025-02-02T00:00:00.000Z');
    });

    it('nullifies plannedExerciseId when the planned exercise is deleted', async () => {
      await store.putProgramAssignment({
        id: 'assign-1',
        sessionId: 'sess-1',
        plannedExerciseId: 'pe-1',
        workoutTemplateId: 'tmpl-1',
        assignedAt: '2025-02-01T00:00:00.000Z',
      });

      const raw = (store as unknown as { db: DatabaseSync }).db;
      raw.prepare('DELETE FROM planned_exercises WHERE id = ?').run('pe-1');

      // Session row survives.
      expect(await store.getSession('sess-1')).toBeDefined();
      // Assignment survives, with plannedExerciseId nulled out.
      const rows = await store.getAssignmentsForSession('sess-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.plannedExerciseId).toBeUndefined();
      // workoutTemplateId still points at its row.
      expect(rows[0]?.workoutTemplateId).toBe('tmpl-1');
    });

    it('cascades assignment deletion when its session is deleted', async () => {
      await store.putProgramAssignment({
        id: 'assign-1',
        sessionId: 'sess-1',
        plannedExerciseId: 'pe-1',
        assignedAt: '2025-02-01T00:00:00.000Z',
      });

      const raw = (store as unknown as { db: DatabaseSync }).db;
      raw.prepare('DELETE FROM sessions WHERE id = ?').run('sess-1');

      expect(await store.getAssignmentsForSession('sess-1')).toEqual([]);
    });
  });
});

describe('SqliteSessionStore — v3 migration idempotency', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'vmcp-plan-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('opening the same DB twice is a no-op (CREATE IF NOT EXISTS guards)', async () => {
    const dbPath = join(workdir, 'idempotent.sqlite');

    const first = SqliteSessionStore.open(dbPath);
    await first.putTrainingProgram({
      id: 'prog-1',
      name: 'P',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    await first.close();

    const second = SqliteSessionStore.open(dbPath);
    try {
      const fetched = await second.getTrainingProgram('prog-1');
      expect(fetched?.name).toBe('P');
      const raw = (second as unknown as { db: DatabaseSync }).db;
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as {
        user_version?: number;
      };
      expect(version.user_version).toBe(3);
    } finally {
      await second.close();
    }
  });

  it('migrates a v2 DB forward by adding the planning tables', async () => {
    const dbPath = join(workdir, 'v2-migrate.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exercise_id TEXT,
        exercise_name TEXT,
        notes TEXT
      );
      CREATE TABLE sets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        partial INTEGER NOT NULL,
        partial_reason TEXT,
        training_mode TEXT NOT NULL,
        weight_lbs REAL NOT NULL
      );
      CREATE TABLE reps (
        id TEXT PRIMARY KEY,
        set_id TEXT NOT NULL,
        rep_index INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    seed.close();

    const store = SqliteSessionStore.open(dbPath);
    try {
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const tables = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('training_programs');
      expect(names).toContain('training_blocks');
      expect(names).toContain('training_weeks');
      expect(names).toContain('workout_templates');
      expect(names).toContain('planned_exercises');
      expect(names).toContain('program_assignments');
      const version = (raw.prepare('PRAGMA user_version').get() ?? {}) as {
        user_version?: number;
      };
      expect(version.user_version).toBe(3);
    } finally {
      await store.close();
    }
  });
});
