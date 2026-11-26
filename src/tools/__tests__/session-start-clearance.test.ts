// session.start holds working sessions while the lifter's latest answer to the return clearance
// question is "not yet" and a break, or the window after one, is open (VW-976).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import type { ReturnClearanceAnswer } from '../../profile/return-clearance.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Result = { content: { text: string }[]; isError?: boolean };
type Callback = (args: unknown) => Promise<Result>;

const NOW = '2026-10-03T12:00:00.000Z';

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  store = openTestStore();
  const publisher: { publish: () => void; forSlot: () => unknown } = {
    publish: () => {},
    forSlot: () => publisher,
  };
  const slot = { slotId: 'primary', client: {}, live: new LiveState() };
  const state = {
    config: { adapter: 'node' },
    slots: new Map([['primary', { ...slot, modeRevertGuard: new ModeRevertGuard() }]]),
    store,
    exercises: { getById: () => undefined },
    channels: { forSlot: () => publisher },
    slotBindings: { get: () => null },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('session.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerSessionTools({ tool: vi.fn() } as never, state, placeholders as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function answer(clearance: ReturnClearanceAnswer): Promise<void> {
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    updatedAt: NOW,
    returnClearance: { answer: clearance, answeredOn: '2026-10-02' },
  });
}

async function lastTrainedOn(startedAt: string): Promise<void> {
  await seedTrainingDay(store, { id: `s-${startedAt}`, startedAt, endedAt: startedAt });
}

async function start(args: object = {}): Promise<Result> {
  return callbacks.get('session.start')!({ exerciseName: 'Bench Press', ...args });
}

describe('session.start and the return clearance answer', () => {
  it('refuses a working session after a break while the answer is not yet, with a plain reason', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('not_yet');

    const result = await start();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not cleared to train yet');
    expect(await store.listSessions({})).toHaveLength(1);
  });

  it('allows a working session when the answer is cleared with a limit', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('cleared_with_limit');

    const result = await start();

    expect(result.isError, result.content[0].text).not.toBe(true);
  });

  it('refuses inside the window that opened once the lifter came back', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await lastTrainedOn('2026-10-01T12:00:00.000Z');
    await answer('not_yet');

    expect((await start()).isError).toBe(true);
  });

  it('allows a working session with no break open, whatever the answer', async () => {
    await lastTrainedOn('2026-09-30T12:00:00.000Z');
    await answer('not_yet');

    expect((await start()).isError).not.toBe(true);
  });

  it('allows a test session and a guest session during a held return', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('not_yet');

    expect((await start({ kind: 'test' })).isError).not.toBe(true);
    await callbacks.get('session.end')!({});
    expect((await start({ lifter: 'guest-a' })).isError).not.toBe(true);
  });

  it('allows a working session when the question was never answered', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');

    expect((await start()).isError).not.toBe(true);
  });
});
