// plan.respond_deload_advisory files the lifter's answer to an advised ladder rung (VW-594).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
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
const { CORE_TOOL_NAMES, TOOL_ACCESS } = await import('../../tool-registry.js');
const { actionEntry } = await import('../../actions/allowlist.js');

const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Advisory {
  status: string;
  rung: string | null;
  reasoning: string;
}

interface RespondResult {
  recorded: boolean;
  reason: string;
  advisory: Advisory;
}

let store: SessionStore;
let callbacks: Map<string, Callback>;
let recorder: ReturnType<typeof deloadSessionRecorder>;

beforeEach(async () => {
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
  await seedPlan();
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

/** One program, one block, one week holding one untrained template. */
async function seedPlan(): Promise<void> {
  await store.putTrainingProgram({ id: 'p', name: 'Synthetic', createdAt: '2026-01-01T00:00:00Z' });
  await store.putTrainingBlock({
    id: 'b',
    programId: 'p',
    orderIndex: 0,
    name: 'B',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'w', blockId: 'b', orderIndex: 0, name: 'W', isDeload: false });
  await store.putWorkoutTemplate({ id: 't', weekId: 'w', orderIndex: 0, name: 'Day' });
}

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await callbacks.get(name)!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as T;
}

async function respond(response: 'accepted' | 'declined'): Promise<RespondResult> {
  return call<RespondResult>('plan.respond_deload_advisory', { response });
}

async function nextAdvisory(): Promise<Advisory> {
  return (await call<{ deloadAdvisory: Advisory }>('plan.next_workout', {})).deloadAdvisory;
}

async function planTree(): Promise<unknown> {
  return {
    programs: await store.listTrainingPrograms(),
    blocks: await store.getTrainingBlocksForProgram('p'),
    weeks: await store.getTrainingWeeksForBlock('b'),
    templates: await store.getWorkoutTemplatesForWeek('w'),
  };
}

describe('plan.respond_deload_advisory', () => {
  it('files an accepted ladder decision and leaves the plan tree unchanged', async () => {
    // Arrange
    await recorder.recordWeekly([6, 4, 3]);
    const before = await planTree();

    // Act
    const result = await respond('accepted');

    // Assert
    expect(result).toMatchObject({
      recorded: true,
      advisory: { status: 'advise', rung: 'recovery_session' },
    });
    const decisions = await store.listAdvisoryDecisions(LOCAL_USER_ID, { code: 'deload_ladder' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      verdict: 'recovery_session',
      userResponse: 'accepted',
      algorithmVersion: expect.any(String),
      thresholds: { rollingWindowDays: 7 },
      inputs: {
        muscles: [
          {
            muscle: 'chest',
            evidence: [{ exerciseId: 'synthetic-press', sessionIds: ['s1', 's2', 's3'] }],
          },
        ],
      },
    });
    expect(await planTree()).toEqual(before);
  });

  it('suppresses the same evidence on the next plan.next_workout after a decline', async () => {
    // Arrange
    await recorder.recordWeekly([6, 4, 3]);

    // Act
    const result = await respond('declined');
    const advisory = await nextAdvisory();

    // Assert
    expect(result.recorded).toBe(true);
    expect(advisory).toMatchObject({ status: 'suppressed', rung: null });
    expect(advisory.reasoning).toContain('declined');
    expect(JSON.stringify(advisory)).not.toContain('respond_deload_advisory');
  });

  it('re-offers the rung once a newer session confirms the decline again', async () => {
    // Arrange
    await recorder.recordWeekly([6, 4, 3]);
    await respond('declined');
    await recorder.recordSession({ daysAgo: -0.5, reps: 2 });
    vi.setSystemTime(new Date(NOW.getTime() + DAY_MS));

    // Act
    const advisory = await nextAdvisory();

    // Assert
    expect(advisory).toMatchObject({
      status: 'advise',
      rung: 'recovery_session',
      respondWith: 'plan.respond_deload_advisory',
    });
  });

  it('records nothing, with the reason, when no rung is open', async () => {
    // Arrange
    await recorder.recordWeekly([6, 6, 7]);

    // Act
    const result = await respond('accepted');

    // Assert
    expect(result).toMatchObject({ recorded: false, advisory: { status: 'clear' } });
    expect(result.reason).toContain('No ladder rung is open');
    expect(await store.listAdvisoryDecisions(LOCAL_USER_ID, { code: 'deload_ladder' })).toEqual([]);
  });

  it('records nothing for an answer already filed against the same evidence', async () => {
    // Arrange
    await recorder.recordWeekly([6, 4, 3]);
    await respond('declined');

    // Act
    const result = await respond('accepted');

    // Assert
    expect(result).toMatchObject({ recorded: false, advisory: { status: 'suppressed' } });
    expect(
      await store.listAdvisoryDecisions(LOCAL_USER_ID, { code: 'deload_ladder' }),
    ).toHaveLength(1);
  });

  it('is registered as a write and allowlisted at W2', () => {
    expect(TOOL_ACCESS['plan.respond_deload_advisory']).toBe('write');
    expect(actionEntry('plan.respond_deload_advisory')).toMatchObject({
      tool: 'plan.respond_deload_advisory',
      tier: 'W2',
    });
  });
});
