// `report.weekly` and `goal.weekly_review` on the block calendar (VW-478): adherence counted
// over the dated weeks the range overlaps, the block named in the header, what changed about a
// block's dates inside the range, and the planning prompt on the Sunday review.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLANNING_PROMPT } from '../../plan/current-block.js';
import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { buildWeeklyReport, renderWeeklyMarkdown } from '../report-tools.js';
import { runWeeklyReview } from '../goal-weekly-review.js';

const FROM = '2026-09-14T00:00:00.000Z';
// The range ends inside week 1: a `to` of Monday 00:00 would reach into week 2.
const TO = '2026-09-20T18:00:00.000Z';

let store: SqliteSessionStore;
let state: ServerState;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T18:00:00.000Z'));
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
  state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined, list: () => [] },
  } as unknown as ServerState;
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

/** Block 2's week 1 holds four templates and none of them was trained. */
async function dateBlockTwo(startsOn = '2026-09-14'): Promise<void> {
  await dateBlock(store, 'b2', startsOn, 2);
}

describe('adherence over the dated weeks', () => {
  it('counts a week nobody trained as planned, done 0', async () => {
    await dateBlockTwo();

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });

    expect(report.header.adherence).toMatchObject({ planned: 4, done: 0, basis: 'dated_weeks' });
    expect(report.header.adherence?.weeks).toEqual([
      { startsOn: '2026-09-14', planned: 4, done: 0, skipped: null },
    ]);
  });

  it('marks a week the lifter held, and still counts its templates', async () => {
    await dateBlockTwo();
    const live = await store.getLiveBlockSchedule('b2');
    await store.appendBlockSchedule({
      ...live!,
      skips: [{ weekOf: '2026-09-14', mode: 'hold', reason: 'travel' }],
      kind: 'week_skipped',
      changedBy: 'user',
      declaredAt: '2026-09-20T12:00:00.000Z',
    });

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });
    const markdown = renderWeeklyMarkdown(report);

    expect(report.header.adherence?.weeks[0]).toEqual({
      startsOn: '2026-09-14',
      planned: 4,
      done: 0,
      skipped: 'hold',
    });
    expect(markdown).toContain('Week of 2026-09-14: planned 4 / done 0 (hold)');
  });

  it('counts a session against the dated week it trained', async () => {
    await dateBlockTwo();
    await store.putSession({
      kind: 'training',
      id: 'trained',
      startedAt: '2026-09-15T16:00:00.000Z',
      endedAt: '2026-09-15T17:00:00.000Z',
    });
    await store.putProgramAssignment({
      id: 'a-trained',
      sessionId: 'trained',
      workoutTemplateId: 'b2w1-0',
      assignedAt: '2026-09-15T17:00:00.000Z',
    });

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });

    expect(report.header.adherence).toMatchObject({ planned: 4, done: 1 });
  });

  it('keeps the touched-weeks rule when no block is dated', async () => {
    await store.putSession({
      kind: 'training',
      id: 'trained',
      startedAt: '2026-09-15T16:00:00.000Z',
      endedAt: '2026-09-15T17:00:00.000Z',
    });
    await store.putProgramAssignment({
      id: 'a-trained',
      sessionId: 'trained',
      workoutTemplateId: 'day-a',
      assignedAt: '2026-09-15T17:00:00.000Z',
    });

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });

    expect(report.header.adherence).toMatchObject({ planned: 2, done: 1, basis: 'touched_weeks' });
  });
});

describe('the report header and schedule changes', () => {
  it('names the block and the week the range ends in', async () => {
    await dateBlockTwo();

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });

    expect(report.header.block).toEqual({ name: 'Block 2 — Orientation', week: 1, weeks: 2 });
    expect(renderWeeklyMarkdown(report)).toContain('Block: Block 2 — Orientation, week 1 of 2');
  });

  it('reports a date change declared inside the range, and nothing from before it', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 2);
    await store.appendBlockSchedule({
      blockId: 'b1',
      startsOn: '2026-09-07',
      weeksCount: 2,
      skips: [],
      kind: 'moved',
      reason: 'travel',
      changedBy: 'user',
      declaredAt: '2026-09-16T12:00:00.000Z',
    });

    const report = await buildWeeklyReport(state, { from: FROM, to: TO });

    expect(report.scheduleChanges).toEqual([
      'Block 1 — Re-acclimate moved: now Mon 7 Sep to Sun 20 Sep (was Sun 13 Sep): travel.',
    ]);
    expect(renderWeeklyMarkdown(report)).toContain('## Schedule changes');
  });

  it('says nothing about a change declared before the range', async () => {
    await dateBlockTwo();

    const report = await buildWeeklyReport(state, {
      from: '2026-09-21T00:00:00.000Z',
      to: '2026-09-28T00:00:00.000Z',
    });

    expect(report.scheduleChanges).toEqual([]);
  });
});

describe('goal.weekly_review', () => {
  it('says the next block is due to be planned', async () => {
    await dateBlockTwo();
    vi.setSystemTime(new Date('2026-09-22T18:00:00.000Z'));

    const review = await runWeeklyReview(state, {});

    expect(review.planning).toMatchObject({ due: true, prompt: PLANNING_PROMPT });
  });

  it('says nothing about planning mid-block', async () => {
    await dateBlock(store, 'b1', '2026-09-14', 4);
    await dateBlock(store, 'b2', '2026-10-12', 2);

    const review = await runWeeklyReview(state, {});

    expect(review.planning).toMatchObject({ due: false, prompt: null });
  });

  it('leaves the rate advisory alone', async () => {
    await dateBlockTwo();

    const review = await runWeeklyReview(state, {});

    expect(review).toMatchObject({
      advisory: null,
      observation: null,
      committedUnchanged: true,
      proposal: null,
      vetoes: [],
    });
  });
});
