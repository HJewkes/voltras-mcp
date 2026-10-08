// plan.next_workout carries the re-entry read on every result shape (VW-906).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { dateBlock, seedOwnerShapedPlan } from '../../plan/__tests__/fixtures/owner-shaped-plan.js';
import type { ServerState } from '../../state/server-state.js';
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
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  store = openTestStore();
  await seedOwnerShapedPlan(store);
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

async function nextWorkout(args: unknown = {}): Promise<Record<string, unknown>> {
  const result = await callbacks.get('plan.next_workout')!(args);
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function trainOn(id: string, startedAt: string, extra: object = {}): Promise<void> {
  await seedTrainingDay(store, { id, startedAt, endedAt: startedAt, ...extra });
}

describe('plan.next_workout reEntry', () => {
  it('reads 26 days, a short break and a cited source after a 26-day gap', async () => {
    await trainOn('s-old', '2026-09-07T12:00:00.000Z');

    const { reEntry } = (await nextWorkout()) as { reEntry: Record<string, unknown> };

    expect(reEntry).toEqual({
      phase: 'in_gap',
      daysSinceLastTrainingDay: 26,
      band: 'short',
      windowEndsOn: '2026-10-09',
      rule: { loadFactor: 0.8, weeks: 1, source: 'Nuckols 2022' },
    });
  });

  it('keeps the compact form while the lifter is training normally', async () => {
    await trainOn('s-mid', '2026-09-20T12:00:00.000Z');
    await trainOn('s-recent', '2026-10-01T12:00:00.000Z');

    const { reEntry } = (await nextWorkout()) as { reEntry: Record<string, unknown> };

    expect(reEntry).toEqual({ phase: 'training', daysSinceLastTrainingDay: 2 });
  });

  it('carries reEntry on the unplanned shape', async () => {
    await dateBlock(store, 'b1', '2026-08-10', 4);
    await trainOn('s-old', '2026-09-07T12:00:00.000Z');

    const next = await nextWorkout();

    expect(next).toMatchObject({ unplanned: true, reEntry: { band: 'short' } });
  });

  it('carries reEntry on the completed shape', async () => {
    await store.putTrainingProgram({
      id: 'empty',
      name: 'Empty',
      createdAt: '2026-05-18T15:09:27.604Z',
    });
    await trainOn('s-old', '2026-09-07T12:00:00.000Z');

    const next = await nextWorkout({ programId: 'empty' });

    expect(next).toMatchObject({ completed: true, reEntry: { band: 'short' } });
  });

  it('never counts a guest session', async () => {
    await trainOn('s-owner', '2026-09-07T12:00:00.000Z');
    await trainOn('s-guest', '2026-10-02T12:00:00.000Z', { lifter: 'Jordan' });

    const { reEntry } = (await nextWorkout()) as { reEntry: Record<string, unknown> };

    expect(reEntry).toMatchObject({ daysSinceLastTrainingDay: 26, band: 'short' });
  });

  it('never counts a test-kind session', async () => {
    await trainOn('s-owner', '2026-09-07T12:00:00.000Z');
    await trainOn('s-test', '2026-10-02T12:00:00.000Z', { kind: 'test' });

    const { reEntry } = (await nextWorkout()) as { reEntry: Record<string, unknown> };

    expect(reEntry).toMatchObject({ daysSinceLastTrainingDay: 26, band: 'short' });
  });
});
