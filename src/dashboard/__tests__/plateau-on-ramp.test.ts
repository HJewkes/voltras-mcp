// A lifter climbing on the programmed ramp is not stalled (VW-452).
//
// `history.trend`'s plateau verdict decides `stalled` on the goal card, and
// `stalled` outranks `on_track`. The detector used to call any 14-day run
// inside ±5% of its median a plateau, and the ramp moves about 5% in two
// weeks, so the ideal lifter read stalled. Each case runs the real route code
// over a real sqlite store seeded through the helper `dashboard:preview` uses,
// with the target started at the first seeded week.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seedGoalPreview, type GoalPreviewState } from '../../docs/preview-seeds.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import type { GoalProgressView } from '../read-models/index.js';

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

async function viewFor(
  weeklyLoadsLbs: number[],
  extra: Partial<GoalPreviewState> = {},
): Promise<GoalProgressView> {
  const dir = mkdtempSync(join(tmpdir(), 'vmcp-plateau-ramp-'));
  scratchDirs.push(dir);
  const store = SqliteSessionStore.open(join(dir, 'goal.sqlite'));
  try {
    const now = new Date();
    const state: GoalPreviewState = {
      name: 'on_track',
      expectedStatus: 'on_track',
      summary: 'VW-452 case',
      weeklyLoadsLbs,
      targetStartWeeksAgo: weeklyLoadsLbs.length - 1,
      ...extra,
    };
    await seedGoalPreview(store, state, now);
    const [priority] = await store.listPriorities(LOCAL_USER_ID);
    const [view] = await fetchGoalProgressViews(store, priority!, now);
    return view!;
  } finally {
    store.close();
  }
}

describe('the plateau rule on the goal card (VW-452)', () => {
  it('reads a lifter on the committed ramp for five weeks on_track, not stalled', async () => {
    const view = await viewFor([100, 101.25, 102.5, 103.75, 105]);

    expect(view.status).toBe('on_track');
  });

  it('reads a lifter on the full ramp, short of the goal, on_track', async () => {
    const view = await viewFor([100, 102.5, 105, 107.5]);

    expect(view.status).toBe('on_track');
  });

  it('reads a slow-but-rising lifter under the band behind, never on_track', async () => {
    const view = await viewFor([100, 101, 102, 103, 104]);

    expect(view.status).toBe('behind');
  });

  it('still reads the same top load for three weeks stalled, and names the flatline', async () => {
    const view = await viewFor([100, 100, 100, 100]);

    expect(view.status).toBe('stalled');
    expect(view.statusBasis).toContain('plateau over 21 days');
    expect(view.statusBasis).toContain('under the flatline threshold');
  });

  it('names only the flat tail of a climb that stopped, not the detector’s wider window', async () => {
    const view = await viewFor([90, 93, 96, 99, 100, 100, 100], { targetStartWeeksAgo: 3 });

    expect(view.status).toBe('stalled');
    expect(view.statusBasis).toContain('plateau over 21 days');
  });

  it('still reads a noisy flat run stalled', async () => {
    const view = await viewFor([100, 103, 98, 102, 99]);

    expect(view.status).toBe('stalled');
  });

  it('reads a steep fall behind, as before', async () => {
    const view = await viewFor([146, 133, 121, 110, 100]);

    expect(view.status).toBe('behind');
  });

  it('does not let one light week inside a climb read as stalled', async () => {
    const view = await viewFor([100, 102.5, 105, 96, 107.5]);

    expect(view.status).toBe('on_track');
  });
});
