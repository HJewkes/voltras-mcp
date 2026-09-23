// The `mesocycle` field on `GET /api/goals` (VW-480): the dated block the goals header reads,
// in every state the header must draw (VW-466 section 6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { goalPreviewState, seedGoalPreview } from '../../docs/preview-seeds.js';
import { fetchMesocycle } from '../read-models/mesocycle.js';

const TODAY = '2026-09-19';

let store: SqliteSessionStore;

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
});

afterEach(async () => {
  await store.close();
});

describe('fetchMesocycle', () => {
  it('is null while no block has dates', async () => {
    expect(await fetchMesocycle(store, TODAY)).toBeNull();
  });

  it('describes the block that has started, and which week this is', async () => {
    await dateBlock(store, 'b2', '2026-09-14', 2);

    const meso = await fetchMesocycle(store, TODAY);

    expect(meso).toEqual({
      programName: 'Voltra Return — 2026',
      blockId: 'b2',
      blockName: 'Block 2 — Orientation',
      focus: null,
      blockIndex: 2,
      blockCount: 2,
      startsOn: '2026-09-14',
      endsOn: '2026-09-27',
      state: 'current',
      week: { n: 1, of: 2, isDeload: false, name: 'Week 1 — Load Discovery' },
      weeks: [
        { index: 1, isDeload: false, name: 'Week 1 — Load Discovery', skipped: null },
        { index: 2, isDeload: false, name: 'Week 2 — Confirm', skipped: null },
      ],
      nextBlock: null,
    });
  });

  it('marks a deload week, and says this week is one', async () => {
    const week = await store.getTrainingWeek('b2w2');
    await store.putTrainingWeek({ ...week!, isDeload: true });
    await dateBlock(store, 'b2', '2026-09-14', 2);

    const meso = await fetchMesocycle(store, '2026-09-23');

    expect(meso?.week).toEqual({ n: 2, of: 2, isDeload: true, name: 'Week 2 — Confirm' });
    expect(meso?.weeks[1]).toMatchObject({ index: 2, isDeload: true });
  });

  it('marks held and extended weeks', async () => {
    await dateBlock(store, 'b2', '2026-09-07', 2);
    const live = await store.getLiveBlockSchedule('b2');
    await store.appendBlockSchedule({
      ...live!,
      skips: [
        { weekOf: '2026-09-07', mode: 'hold' },
        { weekOf: '2026-09-14', mode: 'extend' },
      ],
      kind: 'week_skipped',
      changedBy: 'user',
    });

    const meso = await fetchMesocycle(store, TODAY);

    expect(meso?.weeks.map((week) => week.skipped)).toEqual(['hold', 'extend', null]);
    expect(meso?.endsOn).toBe('2026-09-27');
  });

  it('describes a block that has not started yet', async () => {
    await dateBlock(store, 'b2', '2026-09-21', 2);

    const meso = await fetchMesocycle(store, TODAY);

    expect(meso).toMatchObject({
      blockId: 'b2',
      state: 'upcoming',
      startsOn: '2026-09-21',
      endsOn: '2026-10-04',
      week: null,
      nextBlock: { id: 'b2', name: 'Block 2 — Orientation', startsOn: '2026-09-21' },
    });
  });

  it('keeps describing the block that ended, and names the next one', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);
    await dateBlock(store, 'b2', '2026-09-28', 2);

    const meso = await fetchMesocycle(store, TODAY);

    expect(meso).toMatchObject({
      blockId: 'b1',
      blockName: 'Block 1 — Re-acclimate',
      blockIndex: 1,
      state: 'ended',
      endsOn: '2026-09-06',
      week: null,
      nextBlock: { id: 'b2', startsOn: '2026-09-28' },
    });
  });

  it('reads a gap with nothing planned after it', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);

    const meso = await fetchMesocycle(store, TODAY);

    expect(meso).toMatchObject({ blockId: 'b1', state: 'ended', nextBlock: null });
  });

  it('ignores an archived program', async () => {
    await dateBlock(store, 'discovery', '2026-09-14', 1);
    const test = await store.getTrainingProgram('test');
    await store.putTrainingProgram({ ...test!, archivedAt: '2026-09-18T00:00:00.000Z' });

    expect(await fetchMesocycle(store, TODAY)).toBeNull();
  });

  it('reads the goals preview seed as a block in progress (VW-480)', async () => {
    const seeded = SqliteSessionStore.open(':memory:');
    const now = new Date('2026-09-19T18:00:00.000Z');
    await seedGoalPreview(seeded, goalPreviewState('on_track'), now);

    const meso = await fetchMesocycle(seeded, '2026-09-19');

    expect(meso).toMatchObject({
      blockName: 'Block 2 — Orientation',
      state: 'current',
      week: { n: 5, of: 8, isDeload: false },
    });
    expect(meso?.weeks.at(-1)).toMatchObject({ index: 8, isDeload: true, name: 'Deload' });
    await seeded.close();
  });
});
