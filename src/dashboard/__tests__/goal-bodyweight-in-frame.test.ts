// A bodyweight target's band is drawn inside the target's own frame (VW-451).
//
// Before this, `/api/goal-progress` re-derived a bodyweight band from the last
// 30 days' mean weight on every read and drew it from week 1 of the target's
// block, so a cut's line re-centred on wherever the scale was now. These cases
// run the real route code over a real sqlite store and set the frame-anchored
// view beside the view the old derivation produced, for a cut, a gain and a
// maintenance corridor.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GOAL_BAND_CONSTANTS, deriveGoalBand, type GoalBand } from '../../analytics/goal-band.js';
import { blockEndsAt } from '../../analytics/goal-block-weeks.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import { deriveTarget, readDerivationContext, selectionOf } from '../../tools/goal-derivation.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import { buildGoalProgressView, type GoalProgressView } from '../read-models/index.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_WEEKS = 8;
/** Each case runs a real sqlite store; a loaded CI runner needs more than 5 s. */
const SEED_TIMEOUT_MS = 20_000;

/** A Wednesday, so the calendar week each reading lands in never depends on the day the suite runs. */
const NOW = '2026-09-16T12:00:00.000Z';

const scratchDirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

interface BodyweightCase {
  phase: 'fat-loss' | 'gain' | 'maintenance';
  /** One reading a week, oldest first; the first is the target's start, the last is today's. */
  weeklyLbs: readonly number[];
}

/** The two views of one case: as the route draws it now, and as the old derivation drew it. */
interface Compared {
  after: GoalProgressView;
  before: GoalProgressView;
}

async function compare(fixture: BodyweightCase): Promise<Compared> {
  const dir = mkdtempSync(join(tmpdir(), 'vmcp-bodyweight-frame-'));
  scratchDirs.push(dir);
  const store = openTestStore({ path: join(dir, 'goal.sqlite') });
  const now = new Date();
  const weeksBack = fixture.weeklyLbs.length - 1;
  const at = (week: number) => new Date(now.getTime() - (weeksBack - week) * 7 * DAY_MS - DAY_MS);
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: fixture.phase,
    startedAt: new Date(at(0).getTime() - 14 * DAY_MS).toISOString(),
    declaredAt: at(0).toISOString(),
  });
  for (const [week, lbs] of fixture.weeklyLbs.entries()) {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: at(week).toISOString(),
      bodyweightLbs: lbs,
    });
  }
  const priority = await store.putPriority({
    id: 'pri-bodyweight',
    userId: LOCAL_USER_ID,
    horizonWeeks: HORIZON_WEEKS,
    kind: 'lift',
    ref: 'bodyweight',
    level: 'maintain',
    declaredAt: at(0).toISOString(),
    mesosHeld: 1,
  });
  const context = await readDerivationContext({ store }, priority);
  const startValue = fixture.weeklyLbs[0]!;
  const accepted = acceptedBand(context, startValue);
  const startMeasuredAt = at(0).toISOString();
  await store.putGoalTarget({
    id: 'tgt-bodyweight',
    priorityId: priority.id,
    metric: 'bodyweight',
    startValue,
    startMeasuredAt,
    bandLowPctPerWeek: accepted.bandLowPctPerWeek,
    bandHighPctPerWeek: accepted.bandHighPctPerWeek,
    committedValue: accepted.committedValue,
    stretchValue: accepted.stretchValue,
    basis: accepted.basis,
    infoLevel: accepted.infoLevel,
    tierUsed: context.tier,
    tierProvisional: context.tierProvisional,
    dietPhaseAtDerivation: context.dietState.phase,
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: startMeasuredAt,
    endsAt: blockEndsAt(startMeasuredAt, HORIZON_WEEKS),
  });
  const [after] = await fetchGoalProgressViews(store, priority, now);
  const before = await viewFromTodaysBand(store, context, after!, now);
  store.close();
  return { after: after!, before };
}

/** The band the target was accepted with, from its own start. */
function acceptedBand(
  context: Awaited<ReturnType<typeof readDerivationContext>>,
  startValue: number,
): GoalBand {
  return deriveGoalBand({
    metric: 'bodyweight',
    startValue,
    horizonWeeks: context.horizonWeeks,
    weeks: context.weeks,
    tier: context.tier,
    infoLevel: 'own',
    dietState: context.dietState,
    layoff: context.layoff,
    matchedSessionCount: GOAL_BAND_CONSTANTS.minMatchedSessionsForRamp,
    baselineState: 'CALIBRATED',
    completedMesoCount: context.completedMesoCount,
  });
}

/** What the route drew before VW-451: the band re-derived from today's 30-day mean. */
async function viewFromTodaysBand(
  store: SessionStore,
  context: Awaited<ReturnType<typeof readDerivationContext>>,
  after: GoalProgressView,
  now: Date,
): Promise<GoalProgressView> {
  const today = await deriveTarget({ store }, context, selectionOf(after.target));
  if (!('band' in today)) throw new Error('expected a band');
  return buildGoalProgressView({
    priority: after.priority,
    target: after.target,
    band: today.band,
    calibrationEvidence: {
      matchedSessionCount: today.matchedSessionCount,
      baselineState: today.baselineState,
    },
    actuals: after.actuals,
    weeks: context.weeks,
    now: now.toISOString(),
    dietState: context.dietState,
  });
}

/** Band week 1, the current week and the last week, as [low, high]; and the status. */
function summary(view: GoalProgressView) {
  const week = (index: number) => {
    const row = view.expected.find((point) => point.weekIndex === index)!;
    return [row.low, row.high];
  };
  return {
    week1: week(1),
    current: week(view.mesoWeek!.n),
    last: week(view.expected.at(-1)!.weekIndex),
    status: view.status,
  };
}

// Pinned from the route's own output on the fixed clock. `before` is the band the
// old derivation re-centred on the 30-day mean; `after` starts at the target's own start.
const CUT_AFTER = { week1: [200, 198], current: [195, 190], last: [193, 186], status: 'on_track' };
const CUT_BEFORE = {
  week1: [196.7, 194.733],
  current: [191.7825, 186.865],
  last: [189.8155, 182.931],
  status: 'stalled',
};
const GAIN_AFTER = {
  week1: [180, 180.9],
  current: [182.25, 184.5],
  last: [183.15, 186.3],
  status: 'on_track',
};
const GAIN_BEFORE = {
  week1: [181.68, 182.5884],
  current: [183.951, 186.222],
  last: [184.8594, 188.0388],
  status: 'stalled',
};
const MAINTENANCE_AFTER = {
  week1: [176.4, 183.6],
  current: [176.4, 183.6],
  last: [176.4, 183.6],
  // The drift to 185 leaves the corridor, which reads behind (VW-457).
  status: 'behind',
};
const MAINTENANCE_BEFORE = {
  week1: [179.34, 186.66],
  current: [179.34, 186.66],
  last: [179.34, 186.66],
  status: 'on_track',
};

describe('a bodyweight band is anchored in the target frame (VW-451)', () => {
  it(
    'a cut starts its loss line at the start weight, not at the 30-day mean',
    async () => {
      const { after, before } = await compare({
        phase: 'fat-loss',
        weeklyLbs: [200, 199, 198, 196.5, 195.5, 194.5],
      });

      expect(summary(after)).toEqual(CUT_AFTER);
      expect(summary(before)).toEqual(CUT_BEFORE);
      expect(after.actuals.map((actual) => actual.value)).toEqual([199, 198, 196.5, 195.5, 194.5]);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    'a gain starts its line at the start weight',
    async () => {
      const { after, before } = await compare({
        phase: 'gain',
        weeklyLbs: [180, 180.6, 181.2, 181.6, 182.2, 182.8],
      });

      expect(summary(after)).toEqual(GAIN_AFTER);
      expect(summary(before)).toEqual(GAIN_BEFORE);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    'a maintenance corridor stays centred on the start weight, not on the drifting mean',
    async () => {
      const { after, before } = await compare({
        phase: 'maintenance',
        weeklyLbs: [180, 181, 182, 183, 184, 185],
      });
      const band = GOAL_BAND_CONSTANTS.bodyweightMaintenanceBufferPct / 100;

      expect(summary(after)).toEqual(MAINTENANCE_AFTER);
      expect(summary(before)).toEqual(MAINTENANCE_BEFORE);
      expect(summary(after).last[0]).toBeCloseTo(180 * (1 - band), 6);
      expect(summary(after).last[1]).toBeCloseTo(180 * (1 + band), 6);
    },
    SEED_TIMEOUT_MS,
  );
});

describe('a session-count band is anchored in the target frame (VW-451)', () => {
  it(
    'holds flat at the count the commitment was made at, not today’s count',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vmcp-sessions-frame-'));
      scratchDirs.push(dir);
      const store = openTestStore({ path: join(dir, 'goal.sqlite') });
      const now = new Date();
      for (let day = 1; day <= 5; day += 1) {
        const at = new Date(now.getTime() - day * 4 * DAY_MS).toISOString();
        await seedTrainingDay(store, {
          kind: 'training',
          id: `s${day}`,
          startedAt: at,
          endedAt: at,
        });
      }
      const priority = await store.putPriority({
        id: 'pri-sessions',
        userId: LOCAL_USER_ID,
        horizonWeeks: HORIZON_WEEKS,
        kind: 'lift',
        ref: 'sessions',
        level: 'maintain',
        declaredAt: now.toISOString(),
        mesosHeld: 1,
      });
      const startMeasuredAt = new Date(now.getTime() - 14 * DAY_MS).toISOString();
      await store.putGoalTarget({
        id: 'tgt-sessions',
        priorityId: priority.id,
        metric: 'sessions_28d',
        startValue: 12,
        startMeasuredAt,
        bandLowPctPerWeek: 0,
        bandHighPctPerWeek: 0,
        committedValue: 12,
        stretchValue: 12,
        basis: 'execution_ramp',
        infoLevel: 'cold',
        tierUsed: 'intermediate',
        tierProvisional: false,
        dietPhaseAtDerivation: 'maintenance',
        acceptedBy: 'user',
        acknowledgedStretch: false,
        derivedAt: startMeasuredAt,
        endsAt: blockEndsAt(startMeasuredAt, HORIZON_WEEKS),
      });

      const [view] = await fetchGoalProgressViews(store, priority, now);
      store.close();

      expect(view!.expected.every((row) => row.low === 12 && row.high === 12)).toBe(true);
    },
    SEED_TIMEOUT_MS,
  );
});
