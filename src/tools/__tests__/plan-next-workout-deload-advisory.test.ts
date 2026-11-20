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

const SILENT_KEYS = ['reasoning', 'rung', 'status', 'userMessage'];
const WATCHING_KEYS = [...SILENT_KEYS, 'muscles'].sort();
const ADVISE_KEYS = [...WATCHING_KEYS, 'algorithmVersion', 'respondWith', 'thresholdsUsed'].sort();

const SET_COUNT_ADVICE = /\b(add|hold|cut|drop|remove|fewer|more)\b[^.]{0,30}\bsets?\b/i;

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Advisory {
  status: string;
  rung: string | null;
  reasoning: string;
  userMessage: string;
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

/** One program, one block, one week holding one untrained template, all ids prefixed. */
async function seedPlan(options: { isDeload: boolean; prefix?: string }): Promise<void> {
  const id = (suffix: string): string => `${options.prefix ?? ''}${suffix}`;
  await store.putTrainingProgram({
    id: id('p'),
    name: 'Synthetic',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await store.putTrainingBlock({
    id: id('b'),
    programId: id('p'),
    orderIndex: 0,
    name: 'B',
    weeksCount: 1,
  });
  await store.putTrainingWeek({
    id: id('w'),
    blockId: id('b'),
    orderIndex: 0,
    name: 'W',
    isDeload: options.isDeload,
  });
  await store.putWorkoutTemplate({ id: id('t'), weekId: id('w'), orderIndex: 0, name: 'Day' });
}

/** Puts the prefixed block on the calendar for the week ending at NOW. */
async function dateBlock(prefix: string): Promise<void> {
  await store.appendBlockSchedule({
    blockId: `${prefix}b`,
    startsOn: '2026-03-09',
    weeksCount: 1,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: '2026-03-01T12:00:00.000Z',
  });
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

function expectExplainedWithoutSetCount(advisory: Advisory, keys = SILENT_KEYS): void {
  expect(Object.keys(advisory).sort()).toEqual(keys);
  expect(advisory.reasoning.length).toBeGreaterThan(0);
  expect(advisory.userMessage.length).toBeGreaterThan(0);
  expect(`${advisory.reasoning} ${advisory.userMessage}`).not.toMatch(SET_COUNT_ADVICE);
}

describe('plan.next_workout deloadAdvisory', () => {
  it('reads clear when every muscle held against the week before', async () => {
    // Act
    const advisory = await advisoryAfter([6, 6, 7]);

    // Assert
    expect(advisory).toMatchObject({ status: 'clear', rung: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('reads watching, with no rung to answer, after a single miss', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 4]);

    // Assert
    expect(advisory).toMatchObject({ status: 'watching', rung: null });
    expect(advisory.userMessage).toContain('noise');
    expectExplainedWithoutSetCount(advisory, WATCHING_KEYS);
  });

  it('advises a recovery session after two consecutive misses of one muscle', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 3]);

    // Assert
    expect(advisory).toMatchObject({
      status: 'advise',
      rung: 'recovery_session',
      muscles: [{ muscle: 'chest', state: 'confirmed' }],
    });
    expect(advisory.muscles[0]?.evidence[0]?.sessionIds).toEqual(['s1', 's2', 's3']);
    expectExplainedWithoutSetCount(advisory, ADVISE_KEYS);
  });

  it('reads inconclusive with no comparable history', async () => {
    // Act
    const advisory = await advisoryAfter(null);

    // Assert
    expect(advisory).toMatchObject({ status: 'inconclusive', rung: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('is suppressed when the returned workout sits in a deload week', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 3], { isDeload: true });

    // Assert
    expect(advisory).toMatchObject({ status: 'suppressed', rung: null });
    expectExplainedWithoutSetCount(advisory);
  });

  it('is suppressed when the dated week in force is a deload week but the returned one is not', async () => {
    // Arrange
    await seedPlan({ isDeload: true, prefix: 'dated-' });
    await dateBlock('dated-');
    await seedPlan({ isDeload: false });
    await recorder.recordWeekly([6, 4, 3]);

    // Act
    const next = await nextWorkout({ programId: 'p' });

    // Assert
    expect(next).toMatchObject({
      week: { isDeload: false },
      deloadAdvisory: { status: 'suppressed', rung: null },
    });
  });

  it('names only registered tools, and the answer tool only when it advises', async () => {
    // Act
    const advisory = await advisoryAfter([6, 4, 3]);

    // Assert
    expect(advisory).toMatchObject({
      status: 'advise',
      respondWith: 'plan.respond_deload_advisory',
    });
    const named = JSON.stringify(advisory).match(/\b[a-z_]+\.[a-z_]+\b/g) ?? [];
    const toolLike = named.filter((name) => /^(plan|mrvguard|session|goal)\./.test(name));
    expect(toolLike.filter((name) => !CORE_TOOL_NAMES.includes(name))).toEqual([]);
  });

  it.each<[string, [number, number, number] | null]>([
    ['clear', [6, 6, 7]],
    ['watching', [6, 4, 4]],
    ['inconclusive', null],
  ])('names no answer tool when it reads %s', async (status, reps) => {
    // Act
    const advisory = await advisoryAfter(reps);

    // Assert
    expect(advisory.status).toBe(status);
    expect(JSON.stringify(advisory)).not.toContain('respond_deload_advisory');
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
