// plan.next_workout offers the day-1 baseline session after a break (VW-982).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';

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
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
  store = openTestStore();
  await seedOwnerShapedPlan(store);
  await addDayAExercises();
  const state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerPlanTools({} as never, state, placeholders as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

/** Day A gains two lifts beside its seated row; the goblet squat is never trained. */
async function addDayAExercises(): Promise<void> {
  for (const [index, exerciseId] of ['chest-press', 'goblet-squat'].entries()) {
    await store.putPlannedExercise({
      id: `day-a-${exerciseId}`,
      workoutTemplateId: 'day-a',
      exerciseId,
      orderIndex: index + 1,
      targetSets: 3,
      targetRepsLow: 8,
      targetRepsHigh: 12,
    });
  }
}

async function trainLifts(id: string, startedAt: string, loads: Record<string, number>) {
  const endedAt = new Date(Date.parse(startedAt) + 30 * 60_000).toISOString();
  await store.putSession({ id, kind: 'training', startedAt, endedAt });
  for (const [exerciseId, weightLbs] of Object.entries(loads)) {
    await store.putSet({
      id: `${id}-${exerciseId}`,
      sessionId: id,
      userId: LOCAL_USER_ID,
      exerciseId,
      startedAt,
      endedAt,
      partial: false,
      reps: [],
      weightLbs,
    });
  }
}

async function nextWorkout(args: unknown = {}) {
  const result = await callbacks.get('plan.next_workout')!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Record<string, unknown> & {
    reEntry: Record<string, unknown>;
  };
}

async function reEntry(): Promise<Record<string, unknown>> {
  return (await nextWorkout()).reEntry;
}

const BEFORE_THE_BREAK = '2026-09-07T10:00:00.000Z';

describe('plan.next_workout reEntry.baselineSession', () => {
  it('offers a light session of the trained template lifts during an open medium break', async () => {
    await trainLifts('s-before', BEFORE_THE_BREAK, { 'seated-row': 90, 'chest-press': 120 });

    const read = await reEntry();

    expect(read).toMatchObject({ phase: 'in_gap', band: 'medium' });
    expect(read.baselineSession).toEqual({
      label: 'baseline session',
      sets: [
        { exerciseId: 'seated-row', role: 'working', loadLbs: 30, relativeLoad: 0.33 },
        { exerciseId: 'chest-press', role: 'working', loadLbs: 40, relativeLoad: 0.33 },
        { exerciseId: 'seated-row', role: 'back_off', loadLbs: 20, relativeLoad: 0.22 },
      ].map((set, index) => ({
        ...set,
        repsLow: 20,
        repsHigh: 30,
        restSeconds: index === 2 ? 0 : 120,
      })),
      estimatedMinutes: 9,
      minutes: 20,
    });
  });

  it('keeps offering it on the first day back, scaled from the load before the break', async () => {
    await trainLifts('s-before', BEFORE_THE_BREAK, { 'seated-row': 90, 'chest-press': 120 });
    await trainLifts('s-today', '2026-11-06T10:00:00.000Z', { 'seated-row': 30 });

    const read = await reEntry();

    expect(read.phase).toBe('returning');
    expect(read.baselineSession).toMatchObject({
      sets: expect.arrayContaining([expect.objectContaining({ loadLbs: 40, relativeLoad: 0.33 })]),
    });
    expect((read.baselineSession as { sets: { loadLbs: number }[] }).sets[0].loadLbs).toBe(30);
  });

  it('stops offering it once a day back is behind the lifter', async () => {
    await trainLifts('s-before', BEFORE_THE_BREAK, { 'seated-row': 90 });
    await trainLifts('s-back', '2026-11-05T10:00:00.000Z', { 'seated-row': 30 });

    const read = await reEntry();

    expect(read.phase).toBe('returning');
    expect(read).not.toHaveProperty('baselineSession');
  });

  it('offers none while the lifter is training normally', async () => {
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    await trainLifts('s-recent', '2026-07-30T10:00:00.000Z', { 'seated-row': 90 });

    const read = await reEntry();

    expect(read).toEqual({ phase: 'training', daysSinceLastTrainingDay: 2 });
  });

  it('gives null and points at the starting prescription when no template lift has a load', async () => {
    const read = await reEntry();

    expect(read).toMatchObject({
      phase: 'in_gap',
      baselineSession: null,
      startFrom: 'profile.get_starting_prescription',
    });
  });

  it('gives null after a long break, where no old load is scaled', async () => {
    await trainLifts('s-before', BEFORE_THE_BREAK, { 'seated-row': 90 });
    vi.setSystemTime(new Date('2027-04-01T12:00:00.000Z'));

    const read = await reEntry();

    expect(read).toMatchObject({ band: 'long', baselineSession: null });
  });

  it('never takes a guest set as the load to scale', async () => {
    await trainLifts('s-before', BEFORE_THE_BREAK, { 'seated-row': 90 });
    await store.putSet({
      id: 's-before-guest',
      sessionId: 's-before',
      userId: LOCAL_USER_ID,
      exerciseId: 'seated-row',
      startedAt: BEFORE_THE_BREAK,
      endedAt: BEFORE_THE_BREAK,
      partial: false,
      reps: [],
      weightLbs: 300,
      lifter: 'Jordan',
    });

    const read = await reEntry();

    expect(read.baselineSession).toMatchObject({ sets: [{ loadLbs: 30 }, { loadLbs: 20 }] });
  });
});

const LAST_PRE_BREAK = '2026-09-10T10:00:00.000Z';

function liftLoads(read: Record<string, unknown>): [string, number][] {
  const session = read.baselineSession as { sets: { exerciseId: string; loadLbs: number }[] };
  return session.sets.map((set) => [set.exerciseId, set.loadLbs]);
}

const SCALED_LAST_SESSION = [
  ['cable-curl', 20],
  ['lat-pulldown', 40],
  ['cable-curl', 15],
];

describe('plan.next_workout reEntry.baselineSession with no planned workout', () => {
  /** An older session holds a lift the last one does not, so it must not appear. */
  async function trainBeforeTheBreak(): Promise<void> {
    await trainLifts('s-older', '2026-09-08T10:00:00.000Z', { 'chest-press': 150 });
    await trainLifts('s-last', LAST_PRE_BREAK, { 'cable-curl': 60, 'lat-pulldown': 120 });
  }

  /** Four weeks from 2026-08-17: the block ends on 2026-09-13, before today. */
  async function endTheDatedBlock(): Promise<void> {
    await dateBlock(store, 'b1', '2026-08-17', 4);
  }

  it('builds it from the last pre-break day when the dated block ended in the gap', async () => {
    await endTheDatedBlock();
    await trainBeforeTheBreak();

    const next = await nextWorkout();

    expect(next).toMatchObject({ unplanned: true, state: 'gap' });
    expect(next.reEntry).toMatchObject({ phase: 'in_gap', band: 'medium' });
    expect(next.reEntry.baselineSession).toMatchObject({
      label: 'baseline session',
      sets: [
        { role: 'working', relativeLoad: 0.33, repsLow: 20, repsHigh: 30 },
        { role: 'working', relativeLoad: 0.33 },
        { role: 'back_off', relativeLoad: 0.25 },
      ],
    });
    expect(liftLoads(next.reEntry)).toEqual(SCALED_LAST_SESSION);
    expect(next.reEntry).not.toHaveProperty('startFrom');
  });

  it('builds it for a completed program too', async () => {
    await trainBeforeTheBreak();

    const next = await nextWorkout({ programId: 'test' });

    expect(next).toMatchObject({ completed: true });
    expect(liftLoads(next.reEntry)).toEqual(SCALED_LAST_SESSION);
  });

  const NO_PLAN_SHAPES = [
    ['unplanned', {}],
    ['completed', { programId: 'test' }],
  ] as const;

  it.each(NO_PLAN_SHAPES)(
    'keeps it on the first day back for the %s shape, scaled from before the break',
    async (shape, args) => {
      await endTheDatedBlock();
      await trainBeforeTheBreak();
      await trainLifts('s-today', '2026-11-06T10:00:00.000Z', { 'cable-curl': 20 });

      const next = await nextWorkout(args);

      expect(next).toMatchObject({ [shape]: true, reEntry: { phase: 'returning' } });
      expect(liftLoads(next.reEntry)).toEqual(SCALED_LAST_SESSION);
    },
  );

  it.each(NO_PLAN_SHAPES)(
    'offers the %s shape none on day 3 of the window',
    async (shape, args) => {
      await endTheDatedBlock();
      await trainBeforeTheBreak();
      await trainLifts('s-back', '2026-11-04T10:00:00.000Z', { 'cable-curl': 20 });

      const next = await nextWorkout(args);

      expect(next).toMatchObject({ [shape]: true, reEntry: { phase: 'returning' } });
      expect(next.reEntry).not.toHaveProperty('baselineSession');
      expect(next.reEntry).not.toHaveProperty('startFrom');
    },
  );

  it('takes the lifts of every session on the last training day before the break', async () => {
    await endTheDatedBlock();
    await trainLifts('s-older', '2026-09-08T10:00:00.000Z', { 'chest-press': 150 });
    await trainLifts('s-curl', '2026-09-10T10:00:00.000Z', { 'cable-curl': 60 });
    await trainLifts('s-pull', '2026-09-10T10:40:00.000Z', { 'lat-pulldown': 120 });
    await trainLifts('s-row', '2026-09-10T11:20:00.000Z', { 'seated-row': 90 });

    const read = await reEntry();

    expect(liftLoads(read)).toEqual([
      ['cable-curl', 20],
      ['lat-pulldown', 40],
      ['seated-row', 30],
      ['cable-curl', 15],
    ]);
  });

  it('files a session that crosses midnight under the day it ended', async () => {
    await endTheDatedBlock();
    await trainLifts('s-late', '2026-09-09T23:50:00.000Z', { 'cable-curl': 60 });
    await trainLifts('s-pull', LAST_PRE_BREAK, { 'lat-pulldown': 120 });

    const read = await reEntry();

    expect(liftLoads(read)).toEqual(SCALED_LAST_SESSION);
  });

  it('passes over a later session that holds no working set', async () => {
    await endTheDatedBlock();
    await trainBeforeTheBreak();
    await trainLifts('s-empty', '2026-09-11T10:00:00.000Z', {});

    const read = await reEntry();

    expect(liftLoads(read)).toEqual(SCALED_LAST_SESSION);
  });

  it('never takes a lift only a guest did in that session', async () => {
    await endTheDatedBlock();
    await trainBeforeTheBreak();
    await store.putSet({
      id: 's-last-guest',
      sessionId: 's-last',
      userId: LOCAL_USER_ID,
      exerciseId: 'chest-press',
      startedAt: LAST_PRE_BREAK,
      endedAt: LAST_PRE_BREAK,
      partial: false,
      reps: [],
      weightLbs: 300,
      lifter: 'Jordan',
    });

    const read = await reEntry();

    expect(liftLoads(read)).toEqual(SCALED_LAST_SESSION);
  });

  it('gives null and points at the starting prescription with no lift history at all', async () => {
    await endTheDatedBlock();

    const next = await nextWorkout();

    expect(next).toMatchObject({
      unplanned: true,
      reEntry: {
        phase: 'in_gap',
        baselineSession: null,
        startFrom: 'profile.get_starting_prescription',
      },
    });
  });
});
