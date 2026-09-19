// The banner read (VW-504): which weeks of a dated block count as unrecorded, and what the
// wall says about them. Runs against a real in-memory store with the clock pinned to Saturday
// 2026-09-19, the same day the owner-shaped plan fixture describes.
//
// The fixture holds exactly one ended session, on 2026-09-07, so any week that spans that date
// is recorded and every other week is not.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import {
  BANNER_PRIORITY,
  readTopBanner,
  sortByPriority,
  type BannerRecord,
} from '../read-models/banners.js';

const TODAY = '2026-09-19';
const NOW = '2026-09-19T18:00:00.000Z';

let store: SqliteSessionStore;

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  await seedOwnerShapedPlan(store);
});

afterEach(async () => {
  await store.close();
});

function banner(kind: BannerRecord['kind']): BannerRecord {
  return {
    kind,
    tone: 'info',
    title: kind,
    subtitle: null,
    destination: '#/',
    dismissible: true,
    source: 'test',
  };
}

/** A finished session on the given local date, as a training day the read can see. */
async function trainingDayOn(date: string): Promise<void> {
  await store.putSession({
    id: `sess-${date}`,
    startedAt: `${date}T15:00:00.000Z`,
    endedAt: `${date}T16:00:00.000Z`,
  });
}

describe('BANNER_PRIORITY', () => {
  it('names every banner kind exactly once', () => {
    expect(new Set(BANNER_PRIORITY).size).toBe(BANNER_PRIORITY.length);
    expect(BANNER_PRIORITY).toEqual([
      'device_fault',
      'unrecorded_week',
      'planning_due',
      'checkin_due',
      'target_ready',
      'history_review',
    ]);
  });
});

describe('sortByPriority', () => {
  it('puts the higher-priority kind first whichever order it arrives in', () => {
    const sorted = sortByPriority([banner('history_review'), banner('device_fault')]);

    expect(sorted.map((record) => record.kind)).toEqual(['device_fault', 'history_review']);
  });
});

describe('readTopBanner', () => {
  it('raises nothing while no block has dates', async () => {
    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('raises nothing before the block starts', async () => {
    await dateBlock(store, 'b2', '2026-09-21', 2);

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('raises nothing for a week still running, including on its last day', async () => {
    await dateBlock(store, 'b2', '2026-09-14', 2);

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
    expect(await readTopBanner(store, '2026-09-20', '2026-09-20T18:00:00.000Z')).toBeNull();
  });

  it('raises a banner for a planned week that fully passed with no training day', async () => {
    await dateBlock(store, 'b2', '2026-08-31', 3);

    expect(await readTopBanner(store, TODAY, NOW)).toEqual({
      kind: 'unrecorded_week',
      tone: 'attention',
      title: 'A planned week went unrecorded',
      subtitle: 'The week of Mon 31 Aug had no training day.',
      destination: '#/plan',
      dismissible: false,
      source: 'plan.block-calendar',
    });
  });

  it('raises a banner for a block dated after the weeks it covers had already passed', async () => {
    await dateBlock(store, 'b1', '2026-08-24', 4);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      kind: 'unrecorded_week',
      subtitle: '2 planned weeks had no training day, the most recent the week of Mon 31 Aug.',
    });
  });

  it('raises nothing for a week that holds one training day', async () => {
    await dateBlock(store, 'b2', '2026-09-07', 1);

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('names the count and the most recent week when several went unrecorded', async () => {
    await dateBlock(store, 'b2', '2026-08-17', 5);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      subtitle: '3 planned weeks had no training day, the most recent the week of Mon 31 Aug.',
    });
  });

  it('raises a banner for a deload week with no training day', async () => {
    const week = await store.getTrainingWeek('b1w1');
    await store.putTrainingWeek({ ...week!, isDeload: true });
    await dateBlock(store, 'b1', '2026-08-31', 4);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      subtitle: 'The week of Mon 31 Aug had no training day.',
    });
  });

  it('raises nothing for a week recorded as a hold', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 4);
    const live = await store.getLiveBlockSchedule('b1');
    await store.appendBlockSchedule({
      ...live!,
      skips: [{ weekOf: '2026-08-31', mode: 'hold' }],
      kind: 'week_skipped',
      changedBy: 'user',
    });

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('raises nothing for the off week an extend inserted', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 3);
    const live = await store.getLiveBlockSchedule('b1');
    await store.appendBlockSchedule({
      ...live!,
      skips: [{ weekOf: '2026-08-31', mode: 'extend' }],
      kind: 'week_skipped',
      changedBy: 'user',
    });

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('raises nothing for a gap, even when the ended block left an empty passed week', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 3);

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('ignores the passed weeks of older blocks once a newer block is current', async () => {
    await dateBlock(store, 'discovery', '2026-06-29', 2);
    await dateBlock(store, 'b1', '2026-08-03', 2);
    await dateBlock(store, 'b2', '2026-08-31', 3);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      subtitle: 'The week of Mon 31 Aug had no training day.',
    });
  });

  it('clears once a training day falls inside the week', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 4);
    expect(await readTopBanner(store, TODAY, NOW)).not.toBeNull();

    await trainingDayOn('2026-09-02');

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });
});
