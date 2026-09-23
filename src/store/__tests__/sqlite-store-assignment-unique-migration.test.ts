// The one-link-per-pair migration (VW-536): two unique indexes on `program_assignments`, one
// for (session, template) and one for (session, planned exercise), exercised against a
// genuinely pre-migration file holding links (VW-288).
//
// Run from the version before this step (40) and on the chain from 37, the version the
// owner's live store was on when the step landed; plus a fresh store, and a v40 file that
// already holds a duplicate, which the step must refuse without deleting anything.
//
// Named for what it migrates rather than for a version number, so a re-number is
// `CURRENT_VERSION` and the `FROM_VERSIONS` list alone.
//
// Every value here is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import type { StoredProgramAssignment } from '../types.js';

const CURRENT_VERSION = 41;
const FROM_VERSIONS = [37, 40] as const;
const AT = '2026-09-21T18:00:00.000Z';

const DROP_THIS_STEP_SQL = `
  DROP INDEX idx_program_assignments_session_template_unique;
  DROP INDEX idx_program_assignments_session_planned_unique;
`;

/** What v38 to v40 added elsewhere, taken back off so a v37 file is genuinely v37. */
const UNDO_V38_TO_V40_SQL = `
  ALTER TABLE sets DROP COLUMN effort_context_json;
  ALTER TABLE sets DROP COLUMN cue_record_json;
  DROP INDEX idx_ui_actions_device;
  DROP TRIGGER ui_actions_complete_once;
  ALTER TABLE ui_actions DROP COLUMN device_id;
  ALTER TABLE planned_exercises DROP COLUMN goal_kind;
  ALTER TABLE planned_exercises DROP COLUMN target_velocity_loss_pct;
  ALTER TABLE planned_exercises DROP COLUMN rest_learning;
  DROP TABLE learned_rest;
`;

const TEMPLATE_LINK: StoredProgramAssignment = {
  id: 'link-tpl',
  sessionId: 'sess-1',
  workoutTemplateId: 'tpl',
  assignedAt: AT,
};
const PLANNED_LINK: StoredProgramAssignment = {
  id: 'link-pe',
  sessionId: 'sess-1',
  plannedExerciseId: 'pe',
  assignedAt: AT,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-assignment-unique-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fully-shaped store holding one link of each kind, written through the port. */
async function seededStore(path: string): Promise<void> {
  const store = SqliteSessionStore.open(path);
  await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0, isDeload: false });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', orderIndex: 0, name: 'Upper' });
  await store.putPlannedExercise({
    id: 'pe',
    workoutTemplateId: 'tpl',
    exerciseId: 'cable-row',
    orderIndex: 0,
    targetSets: 3,
  } as never);
  await store.putSession({ id: 'sess-1', startedAt: AT });
  await store.putProgramAssignment(TEMPLATE_LINK);
  await store.putProgramAssignment(PLANNED_LINK);
  await store.close();
}

/**
 * A pre-migration file at `version`: a seeded store with this step's indexes (and, for 37,
 * the three later steps) taken back off. Dropping is how the shape is reached, never how it
 * is tested.
 */
async function priorStore(version: number, extraSql = ''): Promise<string> {
  const path = join(dir, `store-${String(version)}.sqlite`);
  await seededStore(path);
  const db = new DatabaseSync(path);
  db.exec(DROP_THIS_STEP_SQL);
  if (version < 38) db.exec(UNDO_V38_TO_V40_SQL);
  db.exec(extraSql);
  db.exec(`PRAGMA user_version = ${String(version)}`);
  db.close();
  return path;
}

function readOnly<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function uniqueIndexes(path: string): string[] {
  return readOnly(path, (db) =>
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'program_assignments' AND name LIKE '%_unique'
            ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

function userVersion(path: string): number {
  return readOnly(
    path,
    (db) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
}

function linkCount(path: string): number {
  return readOnly(
    path,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM program_assignments').get() as { n: number }).n,
  );
}

const BOTH_INDEXES = [
  'idx_program_assignments_session_planned_unique',
  'idx_program_assignments_session_template_unique',
];

describe.each(FROM_VERSIONS)('the one-link-per-pair migration, from v%i', (from) => {
  it('keeps every link, adds both indexes and stamps the version', async () => {
    const path = await priorStore(from);

    await SqliteSessionStore.open(path).close();

    expect(linkCount(path)).toBe(2);
    expect(uniqueIndexes(path)).toEqual(BOTH_INDEXES);
    expect(userVersion(path)).toBe(CURRENT_VERSION);
  });

  it('changes nothing on a second open', async () => {
    const path = await priorStore(from);
    await SqliteSessionStore.open(path).close();

    await SqliteSessionStore.open(path).close();

    expect(uniqueIndexes(path)).toEqual(BOTH_INDEXES);
    expect(linkCount(path)).toBe(2);
  });

  it('refuses a second link for a pair in the database, while the port returns the first', async () => {
    const store = SqliteSessionStore.open(await priorStore(from));

    const raw = [
      store.putProgramAssignment({ ...TEMPLATE_LINK, id: 'dup-tpl' }),
      store.putProgramAssignment({ ...PLANNED_LINK, id: 'dup-pe' }),
    ];
    const viaPort = await store.putProgramAssignmentIfAbsent({ ...TEMPLATE_LINK, id: 'again' });
    await store.close();

    for (const write of raw) await expect(write).rejects.toThrow(/UNIQUE constraint failed/);
    expect(viaPort).toEqual({ assignment: TEMPLATE_LINK, created: false });
  });
});

describe('the one-link-per-pair indexes on a fresh store', () => {
  it('are there without any migration having run', async () => {
    const path = join(dir, 'fresh.sqlite');

    await SqliteSessionStore.open(path).close();

    expect(uniqueIndexes(path)).toEqual(BOTH_INDEXES);
  });

  it('still let one session link to a template and to a planned lift in it', async () => {
    const path = join(dir, 'fresh-links.sqlite');

    await seededStore(path);

    expect(linkCount(path)).toBe(2);
  });
});

describe('a v40 file that already holds a duplicate pair', () => {
  const DUPLICATE_SQL = `
    INSERT INTO program_assignments (id, session_id, workout_template_id, assigned_at)
      VALUES ('dup-tpl', 'sess-1', 'tpl', '${AT}');`;

  it('refuses to open, names the count, and deletes nothing', async () => {
    const path = await priorStore(40, DUPLICATE_SQL);

    expect(() => SqliteSessionStore.open(path)).toThrow(/schema v41: 1 session and plan-target/);

    expect(linkCount(path)).toBe(3);
    expect(userVersion(path)).toBe(40);
    expect(uniqueIndexes(path)).toEqual([]);
  });
});
