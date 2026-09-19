// The owner's plan tree as it stood on 2026-09-19 (VW-475), rebuilt from a read-only query of
// the live store: 2 programs, 3 blocks, 4 week rows, nothing dated. "Voltra Return — 2026" has
// work left; the newer "MCP-Driven Test — Upper Body A" has its one workout done, which is why
// "newest program" picked the wrong one (VW-469). Ids are short stand-ins for the real UUIDs.

import type { SqliteSessionStore } from '../../../store/sqlite-store.js';

export const RETURN_PROGRAM = 'Voltra Return — 2026';
export const TEST_PROGRAM = 'MCP-Driven Test — Upper Body A';
/** Planned only in the real program, so a reader looking in the test program finds nothing. */
export const RETURN_ONLY_EXERCISE = 'seated-row';

const WEEK_2_TEMPLATES = ['Upper A', 'Lower A', 'Upper B', 'Lower B'];

export async function seedOwnerShapedPlan(store: SqliteSessionStore): Promise<void> {
  await store.putTrainingProgram({
    id: 'return',
    name: RETURN_PROGRAM,
    createdAt: '2026-05-18T15:09:27.604Z',
  });
  await store.putTrainingProgram({
    id: 'test',
    name: TEST_PROGRAM,
    createdAt: '2026-07-19T03:47:47.141Z',
  });
  await seedReturnProgram(store);
  await seedTestProgram(store);
}

async function seedReturnProgram(store: SqliteSessionStore): Promise<void> {
  await block(store, 'b1', 'return', 0, 'Block 1 — Re-acclimate', 4);
  await block(store, 'b2', 'return', 1, 'Block 2 — Orientation', 2);
  await store.putTrainingWeek({
    id: 'b1w1',
    blockId: 'b1',
    orderIndex: 0,
    name: 'Week 1',
    isDeload: false,
  });
  await store.putTrainingWeek({
    id: 'b2w1',
    blockId: 'b2',
    orderIndex: 0,
    name: 'Week 1 — Load Discovery',
    isDeload: false,
  });
  await store.putTrainingWeek({
    id: 'b2w2',
    blockId: 'b2',
    orderIndex: 1,
    name: 'Week 2 — Confirm',
    isDeload: false,
  });
  await template(store, 'day-a', 'b1w1', 0, 'Day A — Full Body A (squat / bench / row / curl)');
  await template(store, 'day-b', 'b1w1', 1, 'Day B — Upper Body (push / pull / arms)');
  await store.putPlannedExercise({
    id: 'day-a-row',
    workoutTemplateId: 'day-a',
    exerciseId: RETURN_ONLY_EXERCISE,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 12,
    targetWeightLbs: 100,
  });
  for (const week of ['b2w1', 'b2w2']) {
    for (const [index, name] of WEEK_2_TEMPLATES.entries()) {
      await template(store, `${week}-${index}`, week, index, name);
    }
  }
  await trained(store, 'day-b', 'sess-day-b', '2026-09-07T15:00:00.000Z');
}

async function seedTestProgram(store: SqliteSessionStore): Promise<void> {
  await block(store, 'discovery', 'test', 0, 'Discovery Block', 1);
  await store.putTrainingWeek({
    id: 'dw1',
    blockId: 'discovery',
    orderIndex: 0,
    name: 'Week 1',
    isDeload: false,
  });
  await template(store, 'upper-a', 'dw1', 0, 'Upper Body A');
  await trained(store, 'upper-a', 'sess-test-1', '2026-07-19T03:50:00.000Z');
  await trained(store, 'upper-a', 'sess-test-2', '2026-07-19T04:30:00.000Z');
}

async function block(
  store: SqliteSessionStore,
  id: string,
  programId: string,
  orderIndex: number,
  name: string,
  weeksCount: number,
): Promise<void> {
  await store.putTrainingBlock({ id, programId, orderIndex, name, weeksCount });
}

async function template(
  store: SqliteSessionStore,
  id: string,
  weekId: string,
  orderIndex: number,
  name: string,
): Promise<void> {
  await store.putWorkoutTemplate({ id, weekId, orderIndex, name });
}

async function trained(
  store: SqliteSessionStore,
  templateId: string,
  sessionId: string,
  startedAt: string,
): Promise<void> {
  const endedAt = new Date(Date.parse(startedAt) + 45 * 60_000).toISOString();
  await store.putSession({ id: sessionId, startedAt, endedAt });
  await store.putProgramAssignment({
    id: `assign-${sessionId}`,
    sessionId,
    workoutTemplateId: templateId,
    assignedAt: endedAt,
  });
}

/** Date one block by appending a planned schedule row, as `plan.block.schedule` would. */
export async function dateBlock(
  store: SqliteSessionStore,
  blockId: string,
  startsOn: string,
  weeksCount: number,
): Promise<void> {
  await store.appendBlockSchedule({
    blockId,
    startsOn,
    weeksCount,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: '2026-09-01T12:00:00.000Z',
  });
}
