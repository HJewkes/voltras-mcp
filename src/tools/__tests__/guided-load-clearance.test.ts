// device.start_guided_load would open a working session of its own on a slot that has none, so it
// is held by the same return clearance check as session.start (VW-984).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { RETURN_NOT_CLEARED_REASON } from '../../profile/return-clearance.js';
import type { ReturnClearanceAnswer } from '../../profile/return-clearance.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  VoltraClient: class {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerDeviceTools } = await import('../device-tools.js');

type Result = { content: { text: string }[]; isError?: boolean };
type Callback = (args: unknown) => Promise<Result>;

const NOW = '2026-10-03T12:00:00.000Z';

let store: SessionStore;
let live: InstanceType<typeof LiveState>;
let client: ReturnType<typeof makeClient>;
let startGuidedLoad: Callback;

function makeClient() {
  const fake = {
    guidedLoadState: { phase: 'idle' },
    setMode: vi.fn(async () => undefined),
    unloadDevice: vi.fn(async () => undefined),
    // A device-reported phase ends the read-back at once; its wait runs on the faked clock.
    startGuidedLoad: vi.fn(async () => {
      fake.guidedLoadState.phase = 'active';
    }),
  };
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  store = openTestStore();
  live = new LiveState();
  client = makeClient();
  const state = {
    config: { adapter: 'node' },
    slots: new Map([['primary', { slotId: 'primary', client, live }]]),
    store,
    lease: { generation: () => 0, isTransferring: () => false, onChange: () => () => {} },
    channels: { forSlot: () => ({ publish: () => {} }) },
  } as unknown as ServerState;
  const placeholders = {
    get: (name: string) => ({
      update: (u: { callback: Callback }) => {
        if (name === 'device.start_guided_load') startGuidedLoad = u.callback;
      },
    }),
  };
  registerDeviceTools({} as never, state, placeholders as never);
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

describe('device.start_guided_load and the return clearance answer', () => {
  it('refuses after a break while the answer is not yet, before any device write', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('not_yet');

    const result = await startGuidedLoad({ targetWeightLbs: 50 });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: 'RETURN_NOT_CLEARED',
      message: RETURN_NOT_CLEARED_REASON,
    });
    expect(client.setMode).not.toHaveBeenCalled();
    expect(client.unloadDevice).not.toHaveBeenCalled();
    expect(client.startGuidedLoad).not.toHaveBeenCalled();
  });

  it('starts after a break once the answer is cleared', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('cleared');

    const result = await startGuidedLoad({ targetWeightLbs: 50 });

    expect(result.isError, result.content[0].text).not.toBe(true);
    expect(client.startGuidedLoad).toHaveBeenCalledTimes(1);
  });

  it('starts inside a test session during a held return, since no session is opened', async () => {
    await lastTrainedOn('2026-08-04T12:00:00.000Z');
    await answer('not_yet');
    live.startSession({ sessionId: 's-test', startedAt: NOW, setIds: [], status: 'active' });

    const result = await startGuidedLoad({ targetWeightLbs: 50 });

    expect(result.isError, result.content[0].text).not.toBe(true);
    expect(client.startGuidedLoad).toHaveBeenCalledTimes(1);
  });
});
