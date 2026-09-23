// The banner read (VW-504): which weeks of a dated block count as unrecorded, and what the
// wall says about them. Runs against a real in-memory store with the clock pinned to Saturday
// 2026-09-19, the same day the owner-shaped plan fixture describes.
//
// The fixture holds exactly one ended session, on 2026-09-07, so any week that spans that date
// is recorded and every other week is not.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { BlockCalendar } from '../../plan/block-calendar.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import {
  BANNER_PRIORITY,
  readTopBanner,
  sortByPriority,
  unrecordedWeeks,
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

/** A finished, marked-training session with a working set: a training day the read can see. */
async function trainingDayOn(date: string): Promise<void> {
  await seedTrainingDay(store, {
    id: `sess-${date}`,
    startedAt: `${date}T15:00:00.000Z`,
    endedAt: `${date}T16:00:00.000Z`,
  });
}

/** A marked-training session on the given date that holds no working set: not a training day. */
async function emptyOpenSessionOn(date: string): Promise<void> {
  await store.putSession({
    id: `open-${date}`,
    startedAt: `${date}T15:00:00.000Z`,
    kind: 'training',
  });
}

/** A worked, unended session left unmarked: `kind` defaults to unreviewed, not training. */
async function unreviewedWorkedSessionOn(date: string): Promise<void> {
  const id = `unreviewed-${date}`;
  await store.putSession({ id, startedAt: `${date}T15:00:00.000Z` });
  await store.putSet({
    id: `${id}-work`,
    sessionId: id,
    startedAt: `${date}T15:00:00.000Z`,
    endedAt: `${date}T15:30:00.000Z`,
    partial: false,
    reps: [],
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

describe('unrecordedWeeks', () => {
  // An extend's off week is excluded through block-calendar.ts's own skipped='extend' marking
  // too, so a fixture routed through the real store can never isolate planWeek===null as the
  // guard: skipped alone would still block it even if planWeek stopped going null. This builds
  // the CalendarWeek directly, with skipped left null, so planWeek===null is the only thing
  // stopping the banner.
  it('excludes a week with no plan content even when nothing marks it skipped', () => {
    const calendar: BlockCalendar = {
      startsOn: '2026-08-31',
      endsOn: '2026-09-27',
      state: 'current',
      weeks: [
        {
          calendarWeek: 1,
          planWeek: null,
          startsOn: '2026-08-31',
          endsOn: '2026-09-06',
          isDeload: false,
          skipped: null,
        },
      ],
    };

    expect(unrecordedWeeks(calendar, [], '2026-09-19')).toEqual([]);
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
      title: 'Week of Mon 31 Aug: nothing recorded',
      subtitle: null,
      destination: '#/plan',
      dismissible: false,
      source: 'plan.block-calendar',
    });
  });

  it('raises a banner for a block dated after the weeks it covers had already passed', async () => {
    await dateBlock(store, 'b1', '2026-08-24', 4);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      kind: 'unrecorded_week',
      title: '2 planned weeks: nothing recorded',
      subtitle: 'Most recent: week of Mon 31 Aug.',
    });
  });

  it('raises nothing for a week that holds one training day', async () => {
    await dateBlock(store, 'b2', '2026-09-07', 1);

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('names the count and the most recent week when several went unrecorded', async () => {
    await dateBlock(store, 'b2', '2026-08-17', 5);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      title: '3 planned weeks: nothing recorded',
      subtitle: 'Most recent: week of Mon 31 Aug.',
    });
  });

  it('raises a banner for a deload week with no training day', async () => {
    const week = await store.getTrainingWeek('b1w1');
    await store.putTrainingWeek({ ...week!, isDeload: true });
    await dateBlock(store, 'b1', '2026-08-31', 4);

    expect(await readTopBanner(store, TODAY, NOW)).toMatchObject({
      title: 'Week of Mon 31 Aug: nothing recorded',
      subtitle: null,
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
      title: 'Week of Mon 31 Aug: nothing recorded',
      subtitle: null,
    });
  });

  it('clears once a training day falls inside the week', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 4);
    expect(await readTopBanner(store, TODAY, NOW)).not.toBeNull();

    await trainingDayOn('2026-09-02');

    expect(await readTopBanner(store, TODAY, NOW)).toBeNull();
  });

  it('still banners when the week only holds a session with no working set', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 4);

    await emptyOpenSessionOn('2026-09-02');

    expect(await readTopBanner(store, TODAY, NOW)).not.toBeNull();
  });

  it('still banners when the week only holds a worked session left unreviewed', async () => {
    await dateBlock(store, 'b1', '2026-08-31', 4);

    await unreviewedWorkedSessionOn('2026-09-02');

    expect(await readTopBanner(store, TODAY, NOW)).not.toBeNull();
  });
});
