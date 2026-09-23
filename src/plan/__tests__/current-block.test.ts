// The one current-block rule (VW-475), run on the owner's plan shape in a real in-memory store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { PLANNING_PROMPT, resolveCurrentBlock } from '../current-block.js';
import {
  RETURN_PROGRAM,
  TEST_PROGRAM,
  dateBlock,
  seedOwnerShapedPlan,
} from './fixtures/owner-shaped-plan.js';

const TODAY = '2026-09-19';

let store: SqliteSessionStore;

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
});

afterEach(async () => {
  await store.close();
});

describe('undated_only', () => {
  it('picks the program with work left over the newer, finished test program (VW-469)', async () => {
    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.state).toBe('undated_only');
    expect(read.program?.name).toBe(RETURN_PROGRAM);
    expect(read.block).toBeNull();
    expect(read.planning).toEqual({
      due: true,
      windowOpensOn: null,
      reason: 'No block has dates yet.',
      prompt: PLANNING_PROMPT,
    });
  });

  it('falls back to the newest program when every program is finished', async () => {
    const empty = SqliteSessionStore.open(':memory:');
    await empty.putTrainingProgram({
      id: 'old',
      name: 'Old',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await empty.putTrainingProgram({
      id: 'new',
      name: 'New',
      createdAt: '2026-02-01T00:00:00.000Z',
    });

    const read = await resolveCurrentBlock(empty, TODAY);

    expect(read.program?.name).toBe('New');
    await empty.close();
  });

  it('reports no program when none exists', async () => {
    const empty = SqliteSessionStore.open(':memory:');

    const read = await resolveCurrentBlock(empty, TODAY);

    expect(read).toMatchObject({ state: 'undated_only', program: null });
    await empty.close();
  });
});

describe('current', () => {
  it("picks a dated current block's program over any undated one", async () => {
    await store.putTrainingProgram({
      id: 'newer',
      name: 'Newer undated',
      createdAt: '2026-09-18T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'nb',
      programId: 'newer',
      orderIndex: 0,
      name: 'Undated',
      weeksCount: 1,
    });
    await dateBlock(store, 'discovery', '2026-09-14', 1);

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.state).toBe('current');
    expect(read.program?.name).toBe(TEST_PROGRAM);
    expect(read.block?.id).toBe('discovery');
    expect(read.week).toEqual({
      n: 1,
      of: 1,
      isDeload: false,
      name: 'Week 1',
      startsOn: '2026-09-14',
      endsOn: '2026-09-20',
    });
  });

  it('opens the planning window on the Monday of the final week, not at a mid-block deload', async () => {
    await store.putTrainingWeek({
      id: 'b1w2',
      blockId: 'b1',
      orderIndex: 1,
      name: 'Deload',
      isDeload: true,
    });
    await dateBlock(store, 'b1', '2026-09-07', 4);

    const inWeek2 = await resolveCurrentBlock(store, '2026-09-19');
    const inWeek4 = await resolveCurrentBlock(store, '2026-09-28');

    expect(inWeek2.week?.isDeload).toBe(true);
    const lastSunday = await resolveCurrentBlock(store, '2026-09-27');

    expect(inWeek2.planning).toMatchObject({
      due: false,
      windowOpensOn: '2026-09-28',
      prompt: null,
    });
    expect(lastSunday.planning.due).toBe(false);
    expect(inWeek4.planning).toMatchObject({
      due: true,
      windowOpensOn: '2026-09-28',
      prompt: PLANNING_PROMPT,
    });
  });

  it('is not due once the next block is dated', async () => {
    await dateBlock(store, 'b1', '2026-09-07', 2);
    await dateBlock(store, 'b2', '2026-09-21', 2);

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.nextBlock).toEqual({
      id: 'b2',
      name: 'Block 2 — Orientation',
      startsOn: '2026-09-21',
    });
    expect(read.planning.due).toBe(false);
  });
});

describe('gap and upcoming', () => {
  it('reports the ended block in a gap and says the next block is due', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.state).toBe('gap');
    expect(read.program?.name).toBe(RETURN_PROGRAM);
    expect(read.block?.id).toBe('b1');
    expect(read.week).toBeNull();
    expect(read.planning).toMatchObject({
      due: true,
      windowOpensOn: null,
      prompt: PLANNING_PROMPT,
    });
    expect(read.planning.reason).toContain('ended on 2026-09-06');
  });

  it('names the next block in a gap before it starts, and is not due', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);
    await dateBlock(store, 'b2', '2026-09-28', 2);

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.state).toBe('gap');
    expect(read.nextBlock?.id).toBe('b2');
    expect(read.planning.due).toBe(false);
  });

  it('is upcoming before the first dated block starts', async () => {
    await dateBlock(store, 'b2', '2026-09-21', 2);

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read).toMatchObject({ state: 'upcoming', block: null });
    expect(read.program?.name).toBe(RETURN_PROGRAM);
    expect(read.nextBlock?.startsOn).toBe('2026-09-21');
  });

  it('ignores blocks of an archived program', async () => {
    await dateBlock(store, 'discovery', '2026-09-14', 1);
    const test = await store.getTrainingProgram('test');
    await store.putTrainingProgram({ ...test!, archivedAt: '2026-09-18T00:00:00.000Z' });

    const read = await resolveCurrentBlock(store, TODAY);

    expect(read.state).toBe('undated_only');
    expect(read.program?.name).toBe(RETURN_PROGRAM);
  });
});
