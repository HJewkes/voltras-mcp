// A lift target's band is drawn inside the target's own frame (VW-449).
//
// Before this, `/api/goal-progress` re-derived every band from TODAY's latest
// top load and drew it from week 1 of the target's block, so the line restarted
// at wherever the lifter was on every read. These cases run the real route code
// over a real sqlite store seeded through the same helper `dashboard:preview`
// uses, so the band asserted is the one the page draws.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  goalPreviewState,
  seedGoalPreview,
  type GoalPreviewState,
} from '../../docs/preview-seeds.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import {
  deriveTarget,
  deriveTargetInFrame,
  readDerivationContext,
  selectionOf,
} from '../../tools/goal-derivation.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import type { GoalProgressView } from '../read-models/index.js';

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function openStore(): SqliteSessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'vmcp-band-in-frame-'));
  scratchDirs.push(dir);
  return SqliteSessionStore.open(join(dir, 'goal.sqlite'));
}

async function viewFor(store: SqliteSessionStore, now: Date): Promise<GoalProgressView> {
  const [priority] = await store.listPriorities(LOCAL_USER_ID);
  const [view] = await fetchGoalProgressViews(store, priority!, now);
  return view!;
}

/** The week of the block `now` falls in, and the band row drawn for it. */
function currentBand(view: GoalProgressView): { low: number; high: number } {
  const row = view.expected.find((point) => point.weekIndex === view.mesoWeek?.n);
  return { low: row!.low, high: row!.high };
}

function latest(view: GoalProgressView): number {
  return view.actuals.filter((actual) => actual.matched).at(-1)!.value;
}

const CLIMB = goalPreviewState('fast_climb');

describe('the goal band is anchored in the target frame (VW-449)', () => {
  it('starts week 1 at the target start value, not at the latest lift', async () => {
    const store = openStore();
    const now = new Date();
    await seedGoalPreview(store, CLIMB, now);

    const view = await viewFor(store, now);

    expect(view.target.startValue).toBe(100);
    expect(latest(view)).toBe(146);
    expect(view.expected[0]).toEqual({ weekIndex: 1, low: 100, high: 100 });
    store.close();
  });

  it('keeps an earned own slope, anchored at the frame start', async () => {
    const store = openStore();
    const now = new Date();
    await seedGoalPreview(store, OWN_SLOPE, now);
    await giveThePriorityACompletedMeso(store);
    const [priority] = await store.listPriorities(LOCAL_USER_ID);
    const [target] = await store.listGoalTargets({ priorityId: priority!.id });
    const context = await readDerivationContext({ store }, priority!);

    const framed = await deriveTargetInFrame({ store }, context, target!);
    const today = await deriveTarget({ store }, context, selectionOf(target!));

    if (!('band' in framed) || !('band' in today)) throw new Error('expected both bands');
    expect(today.band.basis).toBe('own_slope');
    expect(framed.band.basis).toBe('own_slope');
    expect(framed.band.expected[0]!.low).toBe(target!.startValue);
    expect(today.band.expected[0]!.low).toBeGreaterThan(target!.startValue);
    store.close();
  });
});

/**
 * Six weeks of a steady but imperfect climb: enough points and a fit tight
 * enough to earn the own slope. A perfect line has no standard error, and a
 * slope with no error is never projected.
 */
const OWN_SLOPE: GoalPreviewState = {
  name: 'on_track',
  expectedStatus: 'on_track',
  summary: 'Six steady weeks with a completed mesocycle behind them.',
  weeklyLoadsLbs: [100, 112, 118, 131, 139, 152],
  targetStartWeeksAgo: 5,
  committedLbs: 200,
  stretchLbs: 220,
};

/** A program whose second block is this priority's, so one mesocycle is complete. */
async function giveThePriorityACompletedMeso(store: SqliteSessionStore): Promise<void> {
  await store.putTrainingProgram({
    id: 'prog',
    name: 'Program',
    createdAt: new Date().toISOString(),
  });
  for (const orderIndex of [0, 1]) {
    await store.putTrainingBlock({
      id: `block-${orderIndex}`,
      programId: 'prog',
      orderIndex,
      name: `Block ${orderIndex}`,
      weeksCount: 8,
    });
  }
  const [priority] = await store.listPriorities(LOCAL_USER_ID);
  await store.putPriority({ ...priority!, blockId: 'block-1' });
}

describe('statuses against the anchored band (VW-449)', () => {
  async function seeded(name: string): Promise<GoalProgressView> {
    const store = openStore();
    const now = new Date();
    await seedGoalPreview(store, goalPreviewState(name), now);
    const view = await viewFor(store, now);
    store.close();
    return view;
  }

  it('reads behind for a lifter below the anchored band', async () => {
    const view = await seeded('behind');

    expect(latest(view)).toBeLessThan(currentBand(view).low);
    expect(view.status).toBe('behind');
  });

  it('reads on_track for a lifter inside the anchored band', async () => {
    const view = await seeded('on_track');
    const band = currentBand(view);

    expect(latest(view)).toBeGreaterThanOrEqual(band.low);
    expect(latest(view)).toBeLessThanOrEqual(band.high);
    expect(view.status).toBe('on_track');
  });

  it('reads ahead for a lifter above the anchored band', async () => {
    const view = await seeded('ahead');

    expect(latest(view)).toBeGreaterThan(currentBand(view).high);
    expect(view.status).toBe('ahead');
  });
});
