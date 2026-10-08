// plan.suggest_progression labels a stale basis and steps down to the re-entry load (VW-907).
//
// End to end over a real in-memory store with the clock fixed, because the age is read from the
// basis session's row. The last case drives `computeProgressionDelta` directly: it never sees the
// age, so the dashboard's session summary, which calls it on the session just finished, is
// untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredPlannedExercise, StoredRep, StoredSet } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError, TrainingMode: {}, TrainingModeNames: {} };
});

const { computeProgressionDelta, registerPlanTools } = await import('../plan-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const NOW = '2026-10-03T12:00:00.000Z';
const BASIS = 'sess-basis';
const TOP_LOAD = 135;

const PHASE = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  peakVelocity: 800,
} as unknown as Phase;

const PLANNED: StoredPlannedExercise = {
  id: 'pe-1',
  workoutTemplateId: 'tmpl-1',
  exerciseId: 'bench-press',
  orderIndex: 0,
  targetSets: 3,
  targetRepsLow: 8,
  targetRepsHigh: 12,
};

/** Twelve reps at the top load: a topped-out 8-12 band that would earn +5 lb on a fresh basis. */
function toppedOutSet(n: number, startedAt: string): StoredSet {
  const id = `set-${String(n)}`;
  const reps = Array.from({ length: 12 }, (_, index): StoredRep => {
    const rep = { repNumber: index + 1, concentric: PHASE, eccentric: PHASE } as unknown as Rep;
    return { ...rep, id: `${id}-r${String(index)}`, setId: id, index };
  });
  return {
    id,
    sessionId: BASIS,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: TOP_LOAD,
    exerciseId: 'bench-press',
    reps,
  } as StoredSet;
}

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  store = openTestStore();
  await seedPlan(store);
  const state = { store, slots: new Map() } as unknown as ServerState;
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

async function seedPlan(target: SessionStore): Promise<void> {
  await target.putTrainingProgram({ id: 'prog-1', name: 'Plan', createdAt: NOW });
  await target.putTrainingBlock({
    id: 'block-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Block 1',
    weeksCount: 4,
  });
  await target.putTrainingWeek({
    id: 'week-1',
    blockId: 'block-1',
    orderIndex: 0,
    weekIndex: 0,
    isDeload: false,
  });
  await target.putWorkoutTemplate({ id: 'tmpl-1', weekId: 'week-1', orderIndex: 0, name: 'A' });
  await target.putPlannedExercise(PLANNED);
}

async function seedBasis(startedAt: string): Promise<StoredSet[]> {
  await store.putSession({
    kind: 'training',
    id: BASIS,
    startedAt,
    endedAt: startedAt,
    exerciseId: 'bench-press',
  });
  const sets = [1, 2, 3].map((n) => toppedOutSet(n, startedAt));
  for (const set of sets) await store.putSet({ ...set, userId: LOCAL_USER_ID });
  return sets;
}

async function suggest(): Promise<Record<string, unknown>> {
  const result = await callbacks.get('plan.suggest_progression')!({
    programId: 'prog-1',
    exerciseId: 'bench-press',
  });
  expect(result.isError, result.content[0].text).not.toBe(true);
  return (JSON.parse(result.content[0].text) as { suggestion: Record<string, unknown> }).suggestion;
}

describe('plan.suggest_progression on a stale basis', () => {
  it('labels a 26-day-old basis stale and steps down to 0.8 x the top load', async () => {
    await seedBasis('2026-09-07T12:00:00.000Z');

    const suggestion = await suggest();

    expect(suggestion.lastTime).toEqual({
      startedAt: '2026-09-07T12:00:00.000Z',
      daysAgo: 26,
      stale: true,
    });
    // 0.8 x 135 = 108, rounded down to 105.
    expect(suggestion.reEntry).toEqual({
      band: 'short',
      loadLbs: 105,
      loadFactor: 0.8,
      source: 'Nuckols 2022',
    });
    expect(suggestion).toMatchObject({ delta: -30, repDelta: 0, basis: 'fixed' });
    expect(suggestion.gates).toEqual(expect.objectContaining({ setsUnlocked: false }));
    expect(suggestion.reasoning).toContain('26 days ago');
  });

  it('scales a medium break to one third of the top load', async () => {
    await seedBasis('2026-08-24T12:00:00.000Z');

    const suggestion = await suggest();

    expect(suggestion.lastTime).toMatchObject({ daysAgo: 40, stale: true });
    expect(suggestion.reEntry).toMatchObject({ band: 'medium', loadLbs: 45 });
    expect(suggestion.delta).toBe(-90);
  });

  it('leaves the delta alone after a long break and points at the starting prescription', async () => {
    await seedBasis('2026-03-01T12:00:00.000Z');

    const suggestion = await suggest();

    expect(suggestion.lastTime).toMatchObject({ stale: true });
    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion.delta).toBe(5);
    expect(suggestion.reasoning).toContain('profile.get_starting_prescription');
  });

  it('leaves a 10-day-old basis unchanged apart from its age', async () => {
    await seedBasis('2026-09-23T12:00:00.000Z');

    const suggestion = await suggest();

    expect(suggestion.lastTime).toEqual({
      startedAt: '2026-09-23T12:00:00.000Z',
      daysAgo: 10,
      stale: false,
    });
    expect(suggestion).not.toHaveProperty('reEntry');
    expect(suggestion).toMatchObject({ delta: 5, repDelta: 0 });
    expect(suggestion.reasoning).not.toContain('Last time');
  });
});

describe('computeProgressionDelta stays store-free', () => {
  it('suggests from the sets alone, with no age and no re-entry, however old they are', () => {
    const sets = [1, 2, 3].map((n) => toppedOutSet(n, '2026-09-07T12:00:00.000Z'));

    const suggestion = computeProgressionDelta(PLANNED, sets, BASIS);

    expect(suggestion.delta).toBe(5);
    expect(suggestion).not.toHaveProperty('lastTime');
    expect(suggestion).not.toHaveProperty('reEntry');
  });
});
