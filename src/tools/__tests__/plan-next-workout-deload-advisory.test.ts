// plan.next_workout carries the fatigue-reduction ladder read on every result shape (VW-593).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { catalogExercise, deloadSessionRecorder } from './fixtures/deload-sessions.js';

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

const NOW = new Date('2026-03-15T12:00:00.000Z');

const ADVISORY_KEYS = [
  'algorithmVersion',
  'muscles',
  'reasoning',
  'respondWith',
  'rung',
  'status',
  'thresholdsUsed',
  'userMessage',
];

const SET_COUNT_ADVICE = /\b(add|hold|cut|drop|remove|fewer|more)\b[^.]{0,30}\bsets?\b/i;

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Advisory {
  status: string;
  rung: string | null;
  reasoning: string;
  userMessage: string;
  respondWith: string | null;
  muscles: Array<{ muscle: string; state: string; evidence: Array<{ sessionIds: string[] }> }>;
}

let store: SessionStore;
let callbacks: Map<string, Callback>;
let recorder: ReturnType<typeof deloadSessionRecorder>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store = openTestStore();
  recorder = deloadSessionRecorder(store, NOW);
  const state = {
    config: { adapter: 'node' },
    store,
    exercises: { getById: catalogExercise },
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

/** One program, one block, one week holding one untrained template. */
async function seedPlan(options: { isDeload: boolean }): Promise<void> {
  await store.putTrainingProgram({ id: 'p', name: 'Synthetic', createdAt: '2026-01-01T00:00:00Z' });
  await store.putTrainingBlock({
    id: 'b',
    programId: 'p',
    orderIndex: 0,
    name: 'B',
    weeksCount: 1,
  });
  await store.putTrainingWeek({
    id: 'w',
    blockId: 'b',
    orderIndex: 0,
    name: 'W',
    isDeload: options.isDeload,
  });
  await store.putWorkoutTemplate({ id: 't', weekId: 'w', orderIndex: 0, name: 'Day' });
}

async function nextWorkout(args: unknown = { programId: 'p' }): Promise<Record<string, unknown>> {
  const result = await callbacks.get('plan.next_workout')!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function advisoryAfter(
  reps: [number, number, number] | null,
  options = { isDeload: false },
): Promise<Advisory> {
  await seedPlan(options);
  if (reps !== null) await recorder.recordWeekly(reps);
  return (await nextWorkout()).deloadAdvisory as Advisory;
}

function expectExplainedWithoutSetCount(advisory: Advisory): void {
  expect(Object.keys(advisory).sort()).toEqual(ADVISORY_KEYS);
  expect(advisory.reasoning.length).toBeGreaterThan(0);
  expect(advisory.userMessage.length).toBeGreaterThan(0);
  expect(`${advisory.reasoning} ${advisory.userMessage}`).not.toMatch(SET_COUNT_ADVICE);
}

describe('plan.next_workout deloadAdvisory', () => {
  it('reads clear when every muscle held against the week before', async () => {
    // Act
    const advisory = await advisoryAfter([6, 6, 7]);

    // Assert
    expect(advisory).toMatchObject({ status: 'clear', rung: null, respondWith: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('reads watching, with no rung to answer, after a single miss', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 4]);

    // Assert
    expect(advisory).toMatchObject({ status: 'watching', rung: null, respondWith: null });
    expect(advisory.userMessage).toContain('noise');
    expectExplainedWithoutSetCount(advisory);
  });

  it('advises a recovery session after two consecutive misses of one muscle', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 3]);

    // Assert
    expect(advisory).toMatchObject({
      status: 'advise',
      rung: 'recovery_session',
      respondWith: 'plan.respond_deload_advisory',
      muscles: [{ muscle: 'chest', state: 'confirmed' }],
    });
    expect(advisory.muscles[0]?.evidence[0]?.sessionIds).toEqual(['s1', 's2', 's3']);
    expectExplainedWithoutSetCount(advisory);
  });

  it('reads inconclusive with no comparable history', async () => {
    // Act
    const advisory = await advisoryAfter(null);

    // Assert
    expect(advisory).toMatchObject({ status: 'inconclusive', rung: null, respondWith: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('is suppressed when the returned workout sits in a deload week', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 3], { isDeload: true });

    // Assert
    expect(advisory).toMatchObject({ status: 'suppressed', rung: null, respondWith: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('carries the advisory on the completed shape', async () => {
    // Arrange
    await store.putTrainingProgram({
      id: 'empty',
      name: 'Empty',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await recorder.recordWeekly([6, 4, 3]);

    // Act
    const next = await nextWorkout({ programId: 'empty' });

    // Assert
    expect(next).toMatchObject({
      completed: true,
      deloadAdvisory: { status: 'advise', rung: 'recovery_session' },
    });
  });
});
