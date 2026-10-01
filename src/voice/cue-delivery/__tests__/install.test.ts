// VMCP_CUE_DELIVERY picks exactly one cue tee, and the delivery tee looks up tier once per set.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSetStartedPayload } from '../../../state/channel-payloads.js';
import type { ChannelEvent, ChannelPublisher } from '../../../state/channel-publisher.js';
import { LiveState, type ActiveSet, type DeviceSnapshot } from '../../../state/live-state.js';
import { openTestStore, type SessionStore } from '../../../store/__tests__/open-test-store.js';
import { LOCAL_USER_ID } from '../../../store/types.js';
import { CueTeePublisher } from '../../cue-emitter.js';
import { makeCueSettings } from '../../cue-settings.js';
import { DeliveryTee } from '../delivery-emitter.js';
import { installCueLayer, type CueLayerState } from '../install.js';
import { repEvents } from './proximity-fixtures.js';

const device: DeviceSnapshot = { connected: true, weightLbs: 60, trainingMode: 'WeightTraining' };

function recordingPublisher(): { publisher: ChannelPublisher; published: ChannelEvent[] } {
  const published: ChannelEvent[] = [];
  const publisher: ChannelPublisher = {
    publish: (event) => published.push(event),
    forSlot: () => publisher,
  };
  return { publisher, published };
}

function liveWithSession(): LiveState {
  const live = new LiveState();
  live.startSession({
    sessionId: 'sess-install',
    startedAt: '2026-01-01T00:00:00.000Z',
    exerciseId: 'row',
    setIds: [],
    status: 'active',
  });
  return live;
}

function openSet(live: LiveState, setId: string, lifter?: string): ActiveSet {
  const set: ActiveSet = {
    setId,
    sessionId: 'sess-install',
    startedAt: '2026-01-01T00:00:00.000Z',
    reps: [],
    status: 'active',
    exerciseId: 'row',
    ...(lifter !== undefined ? { lifter } : {}),
  };
  live.startSet(set);
  return set;
}

let store: SessionStore;
let live: LiveState;

function layerState(cueDelivery: 'off' | 'on'): CueLayerState {
  return { config: { cueDelivery }, store, slots: new Map([['primary', { live }]]) };
}

function install(cueDelivery: 'off' | 'on', inner: ChannelPublisher): ChannelPublisher {
  return installCueLayer(inner, layerState(cueDelivery), {
    settings: makeCueSettings({ cues: 'on', cuesMidSet: 'on' }),
    voiceListenerRef: null,
    platform: 'linux',
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  store = openTestStore();
  live = liveWithSession();
});

afterEach(async () => {
  await store.close();
});

describe('installCueLayer', () => {
  it('leaves the legacy cue tee in place when the flag is off, and never reads the tier', async () => {
    // Arrange
    const tierReads = vi.spyOn(store, 'getTrainingProfile');
    const { publisher, published } = recordingPublisher();
    const tee = install('off', publisher);
    const set = openSet(live, 'set-a');
    const event = buildSetStartedPayload(set, device, 1, null);

    // Act
    tee.publish(event);
    await flush();

    // Assert
    expect(tee).toBeInstanceOf(CueTeePublisher);
    expect(tee).not.toBeInstanceOf(DeliveryTee);
    expect(published).toEqual([event]);
    expect(tierReads).not.toHaveBeenCalled();
  });

  it('installs only the delivery tee when the flag is on, passing events through unchanged', () => {
    // Arrange
    const { publisher, published } = recordingPublisher();
    const event = buildSetStartedPayload(openSet(live, 'set-a'), device, 1, null);

    // Act
    const tee = install('on', publisher);
    tee.publish(event);

    // Assert
    expect(tee).toBeInstanceOf(DeliveryTee);
    expect(tee).not.toBeInstanceOf(CueTeePublisher);
    expect(tee.forSlot('left')).toBeInstanceOf(DeliveryTee);
    expect(published).toEqual([event]);
  });

  it('resolves the tier through the tier signal once per set, not once per rep', async () => {
    // Arrange
    const tierReads = vi.spyOn(store, 'getTrainingProfile');
    const tee = install('on', recordingPublisher().publisher);

    // Act
    tee.publish(buildSetStartedPayload(openSet(live, 'set-a'), device, 1, null));
    for (const event of repEvents([0.8, 0.8, 0.8], 1, 'set-a')) tee.publish(event);
    await flush();
    live.endSet();
    tee.publish(buildSetStartedPayload(openSet(live, 'set-b'), device, 2, null));
    for (const event of repEvents([0.8, 0.8], 1, 'set-b')) tee.publish(event);
    await flush();

    // Assert
    expect(tierReads).toHaveBeenCalledTimes(2);
    expect(tierReads).toHaveBeenNthCalledWith(1, LOCAL_USER_ID);
    expect(tierReads).toHaveBeenNthCalledWith(2, LOCAL_USER_ID);
  });

  it("reads a guest set's tier under the guest's label, never the owner's", async () => {
    // Arrange
    const tierReads = vi.spyOn(store, 'getTrainingProfile');
    const tee = install('on', recordingPublisher().publisher);

    // Act
    tee.publish(buildSetStartedPayload(openSet(live, 'set-g', 'Guest A'), device, 1, null));
    await flush();

    // Assert
    expect(tierReads).toHaveBeenCalledExactlyOnceWith('Guest A');
  });
});
