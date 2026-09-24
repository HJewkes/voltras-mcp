// Goal targets on the block calendar (VW-477), run six hours west of UTC, where a local week
// and a UTC week disagree for Sunday evenings. The clock is pinned to Saturday 2026-09-19.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localMidnightIso } from '../../analytics/training-days.js';
import { blockWeekAt } from '../../analytics/goal-block-weeks.js';
import { fetchGoalProgressViews } from '../../dashboard/goal-progress-api.js';
import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { StoredPriority, StoredRep } from '../../store/types.js';
import { computeHistoryTrend } from '../metrics-tools.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { registerPlanTools } = await import('../plan-tools.js');
const { registerPlanScheduleTools } = await import('../plan-schedule-tools.js');
const { registerGoalTools } = await import('../goal-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const CATALOG = [{ id: 'bench-press', muscleGroups: ['chest'], name: 'Bench Press' }];
const SATURDAY = '2026-09-19T18:00:00.000Z';

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Body = Record<string, unknown>;

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SATURDAY));
  store = openTestStore();
  const state = {
    config: { adapter: 'node' },
    store,
    exercises: { list: () => CATALOG, getById: (id: string) => CATALOG.find((e) => e.id === id) },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.') || name.startsWith('goal.')).map(
      (name) => [
        name,
        {
          update: (u: { callback: Callback }) => callbacks.set(name, u.callback),
          remove: () => {},
        },
      ],
    ),
  );
  registerPlanTools({} as never, state, placeholders as never);
  registerPlanScheduleTools({} as never, state, placeholders as never);
  registerGoalTools({} as never, state, placeholders as never);
  await call('plan.program.create', { id: 'p', name: 'Return' });
  await call('plan.block.create', {
    id: 'b',
    programId: 'p',
    orderIndex: 0,
    name: 'Block 2',
    weeksCount: 4,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function call(name: string, args: unknown): Promise<Body> {
  const result = await callbacks.get(name)!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Body;
}

function reps(setId: string): StoredRep[] {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 1000,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return Array.from({ length: 8 }, (_, index) => ({
    repNumber: index + 1,
    concentric: phase,
    eccentric: phase,
    id: `${setId}-r${index}`,
    setId,
    index,
  }));
}

async function benchSession(id: string, at: string, weightLbs = 135): Promise<void> {
  await store.putSession({
    kind: 'training',
    id,
    startedAt: at,
    endedAt: at,
    exerciseId: 'bench-press',
  });
  for (const suffix of ['a', 'b']) {
    await store.putSet({
      id: `${id}-${suffix}`,
      sessionId: id,
      userId: LOCAL_USER_ID,
      exerciseId: 'bench-press',
      startedAt: at,
      endedAt: at,
      partial: false,
      weightLbs,
      setPurpose: 'working',
      reps: reps(`${id}-${suffix}`),
    });
  }
}

async function proposeBench(): Promise<{ priority: StoredPriority; targetId: string }> {
  await benchSession('s1', '2026-09-12T16:00:00.000Z');
  const declared = await call('goal.declare_priorities', {
    items: [{ kind: 'lift', ref: 'bench-press', level: 'specialize' }],
  });
  const priority = (declared.priorities as StoredPriority[])[0];
  const proposed = await call('goal.propose_targets', { priorityId: priority.id });
  return { priority, targetId: (proposed.targets as { targetId: string }[])[0].targetId };
}

async function storedTarget(targetId: string) {
  const all = await store.listGoalTargets({ userId: LOCAL_USER_ID }, { includeRetired: true });
  return all.find((target) => target.id === targetId)!;
}

async function view(priority: StoredPriority, at = SATURDAY) {
  const current = (await store.listPriorities(LOCAL_USER_ID)).find((p) => p.id === priority.id)!;
  const [first] = await fetchGoalProgressViews(store, current, new Date(at));
  return first;
}

describe('the local week grid', () => {
  it('puts a Sunday 21:00 reading in that Sunday’s week, not the next', () => {
    const sundayEvening = '2026-09-21T03:00:00.000Z';

    expect(blockWeekAt('2026-09-14T15:00:00.000Z', sundayEvening)).toBe(1);
  });

  it('buckets a Sunday-evening lift into the local week history.trend reports', async () => {
    await benchSession('tue', '2026-09-15T18:00:00.000Z');
    await benchSession('sun', '2026-09-21T03:00:00.000Z', 140);
    vi.setSystemTime(new Date('2026-09-22T18:00:00.000Z'));

    const trend = await computeHistoryTrend({ store }, { exerciseId: 'bench-press' });

    expect(trend.series.map((point: { ts: string }) => point.ts)).toEqual([
      '2026-09-14T00:00:00.000Z',
    ]);
  });
});

describe('targets set for a dated block', () => {
  it('stamps the upcoming block and ends the target where the block ends', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-21' });

    const { targetId } = await proposeBench();

    expect(await storedTarget(targetId)).toMatchObject({
      blockId: 'b',
      endsAt: localMidnightIso('2026-10-19'),
    });
  });

  it('reads "Starts" with no verdict until the block begins', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-21' });
    const { priority, targetId } = await proposeBench();
    await call('goal.accept_target', { targetId });

    const upcoming = await view(priority);

    expect(upcoming).toMatchObject({
      status: 'calibrating',
      startsOn: '2026-09-21',
      statusBasis: 'Starts Mon 21 Sep. No verdict before the block begins.',
    });
  });

  it('moves with its block and keeps its committed and stretch numbers', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-21' });
    const { priority, targetId } = await proposeBench();
    const accepted = await call('goal.accept_target', { targetId });

    const moved = await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-28' });
    const after = await storedTarget(targetId);

    expect(moved.targetsAffected).toEqual([
      { blockId: 'b', targetId, metric: 'top_load_at_reps', exerciseId: 'bench-press' },
    ]);
    expect(after).toMatchObject({
      committedValue: (accepted.target as Body).committedValue,
      stretchValue: (accepted.target as Body).stretchValue,
    });
    expect(await view(priority)).toMatchObject({ startsOn: '2026-09-28' });
  });

  it('counts its weeks from the block start, not from the measured start', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-21' });
    const { priority, targetId } = await proposeBench();
    await call('goal.accept_target', { targetId });

    const inWeek2 = await view(priority, '2026-09-30T18:00:00.000Z');

    expect(inWeek2).toMatchObject({ startsOn: null, mesoWeek: { n: 2, of: 4 } });
  });

  it('reads an extended off week as a deload with no verdict', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-14' });
    const { priority, targetId } = await proposeBench();
    await call('goal.accept_target', { targetId });

    const skipped = await call('plan.week.skip', { blockId: 'b', week: 1, mode: 'extend' });
    const offWeek = await view(priority);

    expect(skipped.targetsAffected).toHaveLength(1);
    expect(offWeek).toMatchObject({
      status: 'deload_week',
      mesoWeek: { n: 1, of: 5, isDeload: true },
    });
  });

  it('is set for a block at acceptance when it was proposed before any block had dates', async () => {
    const { targetId } = await proposeBench();
    expect((await storedTarget(targetId)).blockId).toBeUndefined();
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-21' });

    await call('goal.accept_target', { targetId });

    expect(await storedTarget(targetId)).toMatchObject({
      blockId: 'b',
      endsAt: localMidnightIso('2026-10-19'),
    });
  });

  it('places a lift bucket from the block’s first week on week 1', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-14' });
    const { priority, targetId } = await proposeBench();
    await call('goal.accept_target', { targetId });
    await benchSession('week1', '2026-09-15T18:00:00.000Z', 140);

    const current = await view(priority);

    // The bucket is stamped 2026-09-14T00:00Z, which is Sunday evening here.
    expect(current.actuals.at(-1)).toMatchObject({ value: 140, weekIndex: 1 });
  });

  it('keeps the block when a calibrated starting ramp is re-offered', async () => {
    await call('plan.block.schedule', { blockId: 'b', startsOn: '2026-09-14' });
    const { priority, targetId } = await proposeBench();
    await call('goal.accept_target', { targetId });
    await benchSession('s2', '2026-09-15T16:00:00.000Z');
    await benchSession('s3', '2026-09-17T16:00:00.000Z');
    await store.putFailureAnchor({
      id: 'anchor',
      userId: LOCAL_USER_ID,
      setId: 's3-b',
      exerciseId: 'bench-press',
      observedAt: '2026-09-17T16:00:00.000Z',
      source: 'harvested',
      terminalVelocityMps: 0.18,
      filterInputs: {},
      filterVerdict: 'failure',
      filterVersion: 'test@1',
    });
    await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'bench-press' });

    const proposed = await call('goal.propose_targets', { priorityId: priority.id });
    const [offer] = proposed.recalibrationOffers as { offerTargetId: string }[];

    expect(await storedTarget(offer.offerTargetId)).toMatchObject({
      blockId: 'b',
      endsAt: localMidnightIso('2026-10-12'),
    });
  });
});
