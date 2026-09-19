// Tool-boundary tests for `goal.weekly_review` (VW-376, research W5).
//
// A real `SqliteSessionStore` on `:memory:`, like `goal-tools.test.ts`: this
// handler reads the weight series, the declared diet phase, the week's
// check-in and the accepted goal target, and a fake answering all four would
// be a second store with its own opinions.
//
// What the cases are for:
//   * a proposal is recorded with the inputs AND the thresholds it fired on,
//     so a later threshold change can be re-scored against it;
//   * accept / decline / ignore all round-trip through the one table;
//   * a DECLINED proposal is never raised again for the same observation —
//     the same week anchor at the same urgency;
//   * a vetoed week records nothing at all;
//   * the committed line on the chart is read and never written;
//   * the declared diet phase is never written, by anything, ever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WEEKLY_CHECKIN_CODES, WEEKLY_CHECKIN_KIND } from '../../schemas/profile.js';
import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredGoalTarget } from '../../store/types.js';
import { registerGoalTools } from '../goal-tools.js';
import { BODYWEIGHT_RATE_ADVISORY_CODE } from '../goal-weekly-review.js';

const TOOL_NAMES = [
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
  'goal.weekly_review',
];

const DAY_MS = 24 * 60 * 60 * 1000;
const PHASE_DAYS = 70;
const START_WEIGHT_LBS = 200;

/** The committed edge of the fat-loss band: -0.5%/wk, which is 1 lb/wk here. */
const COMMITTED_PCT_PER_WEEK = -0.5;

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(updates: { callback: FakeRegisteredTool['callback'] }): void;
}

interface Harness {
  store: SqliteSessionStore;
  invoke: (name: string, args?: unknown) => Promise<Record<string, unknown>>;
}

const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function mostRecentSunday(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - now.getUTCDay());
  return now.toISOString().slice(0, 10);
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const state = { store, exercises: { list: () => [] } } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  registerGoalTools(
    undefined as unknown as Parameters<typeof registerGoalTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerGoalTools>[2],
  );
  return {
    store,
    invoke: async (name, args = {}) => {
      const callback = placeholders.get(name)?.callback;
      if (callback === undefined) throw new Error(`no callback installed for ${name}`);
      const result = await callback(args);
      if (result.isError === true) throw new Error(`unexpected error: ${result.content[0].text}`);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
  };
}

/** A declared fat-loss phase with an accepted bodyweight target under it. */
async function seedPhaseAndTarget(store: SqliteSessionStore, days = PHASE_DAYS): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'fat-loss',
    startedAt: daysAgo(days),
    declaredAt: daysAgo(days),
  });
  const priority = await store.putPriority({
    id: 'priority-bodyweight',
    userId: LOCAL_USER_ID,
    horizonWeeks: 12,
    kind: 'muscle',
    ref: 'whole-body',
    level: 'maintain',
    declaredAt: daysAgo(PHASE_DAYS),
    mesosHeld: 0,
  });
  await store.putGoalTarget(bodyweightTarget(priority.id));
}

function bodyweightTarget(priorityId: string): StoredGoalTarget {
  return {
    id: 'target-bodyweight',
    priorityId,
    metric: 'bodyweight',
    startValue: START_WEIGHT_LBS,
    startMeasuredAt: daysAgo(PHASE_DAYS),
    bandLowPctPerWeek: COMMITTED_PCT_PER_WEEK,
    bandHighPctPerWeek: -1,
    committedValue: 190,
    stretchValue: 180,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'fat-loss',
    acceptedBy: 'coach-default',
    acknowledgedStretch: false,
    derivedAt: daysAgo(PHASE_DAYS),
    endsAt: daysAgo(-14),
  };
}

/**
 * A daily series losing `lbsPerWeek` against a line that asks for 1 lb/wk, so
 * the gap off the committed line widens every week.
 */
async function seedReadings(
  store: SqliteSessionStore,
  lbsPerWeek: number,
  days = PHASE_DAYS,
): Promise<void> {
  for (let day = 0; day <= days; day += 1) {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: daysAgo(days - day),
      bodyweightLbs: START_WEIGHT_LBS - (lbsPerWeek * day) / 7,
    });
  }
}

async function seedCheckin(store: SqliteSessionStore, adherence: string): Promise<void> {
  await store.putSelfReport({
    id: 'checkin-adherence',
    userId: LOCAL_USER_ID,
    kind: WEEKLY_CHECKIN_KIND,
    questionCode: WEEKLY_CHECKIN_CODES[1],
    valueText: adherence,
    recordedAt: `${mostRecentSunday()}T00:00:00.000Z`,
  });
}

describe('goal.weekly_review', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = setup();
    await seedPhaseAndTarget(harness.store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('proposes an unsized advisory and records it with its inputs and thresholds', async () => {
    await seedReadings(harness.store, 0.6);
    const result = await harness.invoke('goal.weekly_review');

    expect(result.outcome).toBe('advisory');
    expect(result.advisory).toContain('intake and activity');
    expect(result.levers).toEqual(['intake', 'activity']);
    const rows = await harness.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].inputs.weekOf).toBe(mostRecentSunday());
    expect(rows[0].inputs.phase).toBe('fat-loss');
    expect(rows[0].thresholds.weeklyCadenceDays).toBe(7);
    expect(rows[0].userResponse).toBeUndefined();
  });

  it('round-trips accepted, and keeps one row for the observation', async () => {
    await seedReadings(harness.store, 0.6);
    await harness.invoke('goal.weekly_review');
    const answered = await harness.invoke('goal.weekly_review', { response: 'accepted' });

    expect(answered.response).toMatchObject({ userResponse: 'accepted' });
    const rows = await harness.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userResponse).toBe('accepted');
    expect(rows[0].respondedAt).toBeDefined();
  });

  it('round-trips ignored', async () => {
    await seedReadings(harness.store, 0.6);
    await harness.invoke('goal.weekly_review');
    await harness.invoke('goal.weekly_review', { response: 'ignored' });

    const rows = await harness.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(rows[0].userResponse).toBe('ignored');
  });

  it('never raises a declined proposal again for the same observation', async () => {
    await seedReadings(harness.store, 0.6);
    await harness.invoke('goal.weekly_review');
    const declined = await harness.invoke('goal.weekly_review', { response: 'declined' });
    expect(declined.suppressedByDecline).toBe(true);
    expect(declined.advisory).toBeNull();

    const again = await harness.invoke('goal.weekly_review');
    expect(again.suppressedByDecline).toBe(true);
    expect(again.advisory).toBeNull();
    expect(again.proposal).toBeNull();
    const rows = await harness.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userResponse).toBe('declined');
  });

  // A short phase on purpose: past the settling window, but not yet at the
  // two-week cap, which would force the held signal to a decision instead
  // (rp-s12-two-week-cap-for-slow-signal-situations).
  it('records nothing on a vetoed week', async () => {
    const fresh = setup();
    await seedPhaseAndTarget(fresh.store, 24);
    await seedReadings(fresh.store, 0.1, 24);
    const result = await fresh.invoke('goal.weekly_review');

    expect(result.outcome).toBe('vetoed');
    expect(result.advisory).toBeNull();
    expect(result.proposal).toBeNull();
    expect(result.vetoes).toHaveLength(1);
    const rows = await fresh.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(rows).toHaveLength(0);
  });

  it('leaves the committed line byte-identical across a full propose-and-answer cycle', async () => {
    await seedReadings(harness.store, 0.6);
    const before = JSON.stringify(await harness.store.listGoalTargets({ userId: LOCAL_USER_ID }));

    await harness.invoke('goal.weekly_review');
    await harness.invoke('goal.weekly_review', { response: 'declined' });

    const after = JSON.stringify(await harness.store.listGoalTargets({ userId: LOCAL_USER_ID }));
    expect(after).toBe(before);
  });

  it('never writes the declared diet phase', async () => {
    await seedReadings(harness.store, 0.6);
    const before = JSON.stringify(await harness.store.listDietPhases(LOCAL_USER_ID));
    harness.store.declareDietPhase = () => {
      throw new Error('goal.weekly_review must never write diet_phases');
    };

    await harness.invoke('goal.weekly_review');
    await harness.invoke('goal.weekly_review', { response: 'accepted' });

    expect(JSON.stringify(await harness.store.listDietPhases(LOCAL_USER_ID))).toBe(before);
  });

  it('says what is missing when no diet phase is declared', async () => {
    const empty = setup();
    const result = await empty.invoke('goal.weekly_review');

    expect(result.outcome).toBe('no_declared_diet_phase');
    expect(result.proposal).toBeNull();
    expect(String(result.notes)).toContain('profile.set_diet_phase');
  });

  it('reads the week’s check-in into the advisory', async () => {
    await seedReadings(harness.store, 0.6);
    await seedCheckin(harness.store, 'low');
    const result = await harness.invoke('goal.weekly_review');

    expect(result.checkin).toMatchObject({ dietPlanAdherence: 'low' });
    expect(result.lowConfidence).toBe(true);
    expect(String(result.confounders)).toContain('low-confidence');
  });

  it('judges a back-dated week on the readings taken by its end, not later ones (VW-463)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const weekOf = Date.parse(`${mostRecentSunday()}T00:00:00.000Z`) - 21 * DAY_MS;
    const weekEnd = weekOf + 7 * DAY_MS;
    const args = { weekOf: new Date(weekOf).toISOString().slice(0, 10) };
    const withLaterCrash = setup();
    const pastOnly = setup();
    await seedPhaseAndTarget(withLaterCrash.store);
    await seedPhaseAndTarget(pastOnly.store);
    for (let day = 0; day <= PHASE_DAYS; day += 1) {
      const measuredAt = daysAgo(PHASE_DAYS - day);
      const later = Date.parse(measuredAt) > weekEnd;
      const reading = {
        userId: LOCAL_USER_ID,
        measuredAt,
        bodyweightLbs: START_WEIGHT_LBS - (0.6 * day) / 7 - (later ? 8 : 0),
      };
      await withLaterCrash.store.putBodyMetric(reading);
      if (!later) await pastOnly.store.putBodyMetric(reading);
    }

    const judged = await withLaterCrash.invoke('goal.weekly_review', args);
    const expected = await pastOnly.invoke('goal.weekly_review', args);

    expect(judged.observation).toEqual(expected.observation);
    expect(judged.readingCount).toBe(expected.readingCount);
  });
});
