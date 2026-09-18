// What `npm run dashboard:preview -- goals --state <name>` actually shows
// (VW-416).
//
// The seed is only worth having if the state it names is the state the page
// renders. Nothing about that is obvious from the seed: the band is re-derived
// at read time from the newest session's top load, the plateau detector can
// speak before any of the status rules do, and a baseline that never leaves
// SHAPE_ONLY makes every state read `calibrating`. So each state is run through
// the SAME route code the page polls (`fetchGoalProgressViews`) over a REAL
// sqlite store, and its status asserted.
//
// A real store rather than the route tests' `FakeStore`: the seed writes through
// `putSet` / `reharvestExercise` / `recalcBaseline`, and the baseline state
// those produce is exactly what decides `calibrating` against everything else.
// A fake that answered `getBaseline: () => undefined` would pass this file while
// the command previewed one status for all six names.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAPTURE_SCENARIOS } from '../../docs/capture-shots.js';
import {
  GOAL_PREVIEW_STATES,
  PREVIEW_PAGES,
  goalPreviewState,
  seedGoalPreview,
  type GoalPreviewState,
} from '../../docs/preview-seeds.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import type { GoalProgressView } from '../read-models/index.js';

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

/** Seed one state into a throwaway store and project it exactly as the route does. */
async function viewFor(state: GoalPreviewState): Promise<GoalProgressView> {
  const dir = mkdtempSync(join(tmpdir(), 'vmcp-preview-seeds-'));
  scratchDirs.push(dir);
  const store = SqliteSessionStore.open(join(dir, 'preview.sqlite'));
  try {
    const now = new Date();
    await seedGoalPreview(store, state, now);
    const priorities = await store.listPriorities(LOCAL_USER_ID);
    expect(priorities).toHaveLength(1);
    const views = await fetchGoalProgressViews(store, priorities[0]!, now);
    expect(views).toHaveLength(1);
    return views[0]!;
  } finally {
    store.close();
  }
}

/** The newest reading the page draws — the one every status rule is judged on. */
function latestReading(view: GoalProgressView): number {
  const matched = view.actuals.filter((actual) => actual.matched);
  return matched[matched.length - 1]!.value;
}

describe('dashboard:preview goal states', () => {
  for (const state of GOAL_PREVIEW_STATES) {
    it(`--state ${state.name} lands the read model in ${state.expectedStatus}`, async () => {
      const view = await viewFor(state);

      expect(view.status).toBe(state.expectedStatus);
      expect(view.committed).toBe(state.committedLbs);
      expect(view.stretch).toBe(state.stretchLbs);
    });
  }

  // The status names the verdict; where the newest reading sits against the
  // committed number is what a human opens the page to look at, so it is pinned too.
  it('puts the newest reading exactly on the committed target for hit_exact', async () => {
    const state = goalPreviewState('hit_exact');
    const view = await viewFor(state);

    expect(latestReading(view)).toBe(view.committed);
  });

  it('puts the newest reading past the committed target for beyond_goal', async () => {
    const state = goalPreviewState('beyond_goal');
    const view = await viewFor(state);

    expect(latestReading(view)).toBeGreaterThan(view.committed);
  });

  it('states what the calibrating seed still waits on, off a target stored cold (VW-444)', async () => {
    const view = await viewFor(goalPreviewState('calibrating'));

    expect(view.calibration).toMatchObject({
      sessionsNeeded: 1,
      blockedBy: 'sessions',
      targetBasis: 'execution_ramp',
      targetInfoLevel: 'cold',
    });
  });

  it('keeps the ahead reading short of the committed target, so pace is what it shows', async () => {
    const view = await viewFor(goalPreviewState('ahead'));

    expect(latestReading(view)).toBeLessThan(view.committed);
  });

  it('keeps the newest reading under the committed target for on_track', async () => {
    const view = await viewFor(goalPreviewState('on_track'));

    expect(latestReading(view)).toBeLessThan(view.committed);
  });

  // VW-421: the target used to start a day AFTER the oldest seeded session, so
  // the first lift fell outside the block and the line began a week late.
  const blockLongStates = GOAL_PREVIEW_STATES.filter(
    (state) => state.weeklyLoadsLbs.length === state.targetStartWeeksAgo + 1,
  );
  for (const state of blockLongStates) {
    it(`draws the first lift of ${state.name} on week 1, where the band starts`, async () => {
      const view = await viewFor(state);

      const firstMatched = view.actuals.find((actual) => actual.matched);
      expect(firstMatched?.value).toBe(state.weeklyLoadsLbs[0]);
      expect(firstMatched?.weekIndex).toBe(1);
    });
  }

  // VW-422: the newest session is the current week's reading, never a week behind it.
  for (const state of GOAL_PREVIEW_STATES) {
    it(`gives the current week of ${state.name} a reading`, async () => {
      const view = await viewFor(state);

      const matched = view.actuals.filter((actual) => actual.matched);
      expect(matched[matched.length - 1]?.weekIndex).toBe(view.mesoMilestone.currentWeek);
    });
  }

  // The newest session has to share `now`'s calendar week, even seconds after it turned.
  it('keeps every state on its status and its current-week reading just past Monday midnight UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T00:00:30.000Z'));
    try {
      for (const state of GOAL_PREVIEW_STATES) {
        const view = await viewFor(state);

        const matched = view.actuals.filter((actual) => actual.matched);
        expect(view.status, state.name).toBe(state.expectedStatus);
        expect(matched[matched.length - 1]?.weekIndex, state.name).toBe(
          view.mesoMilestone.currentWeek,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a state nobody defined, naming the ones that exist', () => {
    expect(() => goalPreviewState('nearly')).toThrow(/unknown --state nearly; known: calibrating/);
  });
});

describe('dashboard:preview pages', () => {
  it('opens a hash route on the dashboard SPA for every page', () => {
    for (const page of PREVIEW_PAGES) {
      expect(page.route).toMatch(/^\/app#\//);
    }
  });

  it('names goals as the one page that seeds its own store', () => {
    const seeded = PREVIEW_PAGES.filter((page) => page.captureScenario === null);

    expect(seeded.map((page) => page.name)).toEqual(['goals']);
  });

  it('reuses a capture scenario that still exists for every other page', () => {
    const known = new Set(CAPTURE_SCENARIOS.map((scenario) => scenario.name));

    for (const page of PREVIEW_PAGES) {
      if (page.captureScenario === null) continue;
      expect(known).toContain(page.captureScenario);
    }
  });
});
