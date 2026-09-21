// A planned row with learning off and no rest (VW-445 s.7.2, VW-537). No write path accepts
// one and no database CHECK refuses one, so a row that got in some other way must still
// read: the plan tree marks it `restInvalid`, and reading it writes nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchPlanTree } from '../plan-api.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';

let dir: string;
let store: SqliteSessionStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-rest-invalid-'));
  store = SqliteSessionStore.open(join(dir, 'plan.sqlite'));
  await store.putTrainingProgram({ id: 'prog', name: 'P', createdAt: '2026-09-01T00:00:00.000Z' });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B',
    weeksCount: 4,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0, isDeload: false });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Upper', orderIndex: 0 });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = { workoutTemplateId: 'tpl', exerciseId: 'cable-row', targetSets: 3 };

async function exerciseViews() {
  const tree = await fetchPlanTree(store, () => undefined, { programId: 'prog' });
  return tree.program?.blocks[0]?.weeks[0]?.templates[0]?.exercises ?? [];
}

describe('a learning-off row with no rest', () => {
  it('is stored as given and read back with learning still off', async () => {
    await store.putPlannedExercise({ ...base, id: 'bad', orderIndex: 0, restLearning: false });

    const row = await store.getPlannedExercise('bad');
    expect(row?.restLearning).toBe(false);
    expect(row?.restSec).toBeUndefined();
  });

  it('is marked restInvalid on the plan tree, and the read writes nothing', async () => {
    await store.putPlannedExercise({ ...base, id: 'bad', orderIndex: 0, restLearning: false });
    await store.putPlannedExercise({
      ...base,
      id: 'fixed',
      orderIndex: 1,
      restLearning: false,
      restSec: 90,
    });
    await store.putPlannedExercise({ ...base, id: 'learned', orderIndex: 2 });

    const views = await exerciseViews();

    expect(views.map((v) => [v.id, v.restLearning, v.restInvalid])).toEqual([
      ['bad', false, true],
      ['fixed', false, undefined],
      ['learned', true, undefined],
    ]);
    expect(await store.getPlannedExercise('bad')).toMatchObject({ restLearning: false });
    expect((await store.getPlannedExercise('bad'))?.restSec).toBeUndefined();
  });

  it('carries the goal fields onto the plan tree', async () => {
    await store.putPlannedExercise({
      ...base,
      id: 'loss',
      orderIndex: 0,
      goalKind: 'velocity_loss',
      targetVelocityLossPct: 20,
    });

    const [view] = await exerciseViews();

    expect(view).toMatchObject({ goalKind: 'velocity_loss', targetVelocityLossPct: 20 });
  });
});
